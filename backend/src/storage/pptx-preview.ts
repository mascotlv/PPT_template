import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { convertPptxToSvg } from 'pptx-glimpse';
import { unzipSync } from 'fflate';
import sharp from 'sharp';

export type RenderedPreview = { images: Buffer[]; slideCount: number };
let active = 0;
// Isolate parsing/rasterization from HTTP requests and bound conversion time and memory.
export async function renderPptxPreviews(bytes: Buffer, onProgress?: (done: number, total: number) => void): Promise<RenderedPreview> {
    if (active >= 1) throw new ServiceUnavailableException({ code: 'PREVIEW_BUSY', message: 'Preview renderer busy; retry shortly' });
    active++;
    try {
        return await new Promise<RenderedPreview>((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
            let settled = false;
            const finish = (error?: Error, value?: RenderedPreview) => {
                if (settled) return;
                settled = true; clearTimeout(timer); void worker.terminate();
                if (error) reject(error); else resolve(value!);
            };
            const failed = (reason = 'Preview worker stopped or conversion timed out') => new BadRequestException({ code: 'PREVIEW_RENDER_FAILED', message: 'Unable to render PPTX previews', reason: reason.slice(0, 500) });
            const timer = setTimeout(() => finish(failed()), 300000);
            worker.on('message', result => {
                if (result.progress) { onProgress?.(result.done, result.total); return; }
                if (result.error) finish(failed(result.reason));
                else finish(undefined, { slideCount: result.slideCount, images: result.images.map((image: Uint8Array) => Buffer.from(image)) });
            });
            worker.once('error', () => finish(failed()));
            worker.once('exit', () => { if (!settled) finish(failed()); });
        });
    } finally { active--; }
}

if (!isMainThread) {
    void (async () => {
        try {
            const bytes = Buffer.from(workerData);
            let expanded = 0;
            const parts = unzipSync(bytes, { filter: entry => {
                expanded += entry.originalSize;
                if (expanded > 2 * 1024 * 1024 * 1024) throw new Error('Expanded archive too large');
                return entry.name === 'ppt/presentation.xml';
            } });
            // Count the presentation's ordered slide list, rather than orphan ZIP parts.
            const presentation = Buffer.from(parts['ppt/presentation.xml'] || []).toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
            const slideCount = [...presentation.matchAll(/<(?:[\w]+:)?sldId(?=\s|\/|>)/g)].length;
            if (!slideCount || slideCount > 500) throw new Error('Preview supports 1 to 500 slides');
            // Let the rasterizer resolve installed fonts. Parsing every host font would make
            // conversion depend on the machine's font collection and exhaust worker memory.
            const report = await convertPptxToSvg(bytes, { textOutput: 'text', skipSystemFonts: true, logLevel: 'off' });
            if (report.slides.length !== slideCount) throw new Error('Missing rendered slides');
            const images: Buffer[] = []; let outputBytes = 0;
            for (const slide of report.slides) {
                // Generated SVG embeds slide images as base64. A single embedded image
                // can exceed libxml's default 10 MB text-node limit even in a valid deck.
                // Keep pixel, worker memory, archive and conversion-time budgets above;
                // allow large XML nodes only for this internally generated SVG.
                const image = await sharp(Buffer.from(slide.svg), { unlimited: true, limitInputPixels: 20000000 }).resize({ width: 1200 }).png().toBuffer();
                outputBytes += image.length;
                if (outputBytes > 256 * 1024 * 1024) throw new Error('Preview output too large');
                images.push(image);
                parentPort!.postMessage({ progress: true, done: images.length, total: slideCount });
            }
            parentPort!.postMessage({ images, slideCount });
        } catch (error) { parentPort!.postMessage({ error: true, reason: error instanceof Error ? error.message : 'Rendering failed' }); }
    })();
}
