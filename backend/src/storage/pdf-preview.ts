import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import sharp from 'sharp';
import { MAX_UPLOAD_BYTES } from './upload-limits';
import type { RenderedPreview } from './pptx-preview';

export function validatePdf(file: Express.Multer.File | undefined): Buffer {
    if (!file?.buffer?.length || !/\.pdf$/i.test(file.originalname) || !['application/pdf', 'application/octet-stream'].includes(file.mimetype) || file.buffer.subarray(0, 5).toString() !== '%PDF-')
        throw new BadRequestException({ code: 'INVALID_PDF', message: 'Choose a valid PDF preview file' });
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'PDF exceeds 1 GiB' });
    return file.buffer;
}
let active = 0;
export async function renderPdfPreviews(bytes: Buffer, expectedPages: number, onProgress?: (done: number, total: number) => void): Promise<RenderedPreview> {
    if (active) throw new ServiceUnavailableException({ code: 'PREVIEW_BUSY', message: 'Preview renderer busy; retry shortly' });
    active++;
    try {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: { bytes, expectedPages }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
            let settled = false;
            const finish = (error?: Error, value?: RenderedPreview) => {
                if (settled) return;
                settled = true; clearTimeout(timer); void worker.terminate();
                if (error) reject(error); else resolve(value!);
            };
            const failure = (reason: string, code = 'PDF_RENDER_FAILED') => new BadRequestException({ code, message: 'Unable to generate PDF previews', reason: reason.slice(0, 500) });
            const timer = setTimeout(() => finish(failure('PDF conversion timed out')), 300000);
            worker.on('message', value => {
                if (value.progress) { onProgress?.(value.done, value.total); return; }
                if (value.error) finish(failure(value.reason, value.code));
                else finish(undefined, { slideCount: value.slideCount, images: value.images.map((image: Uint8Array) => Buffer.from(image)) });
            });
            worker.once('error', error => finish(failure(error.message)));
            worker.once('exit', () => { if (!settled) finish(failure('PDF preview worker stopped')); });
        });
    } finally { active--; }
}
if (!isMainThread) {
    void (async () => {
        let library: PDFiumLibrary | undefined;
        try {
            library = await PDFiumLibrary.init();
            const document = await library.loadDocument(Buffer.from(workerData.bytes));
            try {
                const slideCount = document.getPageCount();
                if (!slideCount || slideCount > 500) throw new Error('PDF preview supports 1 to 500 pages');
                if (slideCount !== workerData.expectedPages) {
                    parentPort!.postMessage({ error: true, code: 'PDF_PAGE_COUNT_MISMATCH', reason: 'PDF pages: ' + slideCount + '; PPTX slides: ' + workerData.expectedPages + '. Export one slide per PDF page.' });
                    return;
                }
                const images: Buffer[] = []; let outputBytes = 0;
                for (const page of document.pages()) {
                    const { originalWidth, originalHeight } = page.getOriginalSize();
                    if (!(Number.isFinite(originalWidth) && Number.isFinite(originalHeight) && originalWidth > 0 && originalHeight > 0) || 1200 * (1200 * originalHeight / originalWidth) > 20000000) throw new Error('Invalid or oversized PDF page');
                    const image = await page.render({ scale: 1200 / originalWidth, render: async options => sharp(options.data, { raw: { width: options.width, height: options.height, channels: 4 } }).png().toBuffer() });
                    const png = Buffer.from(image.data); outputBytes += png.length;
                    if (outputBytes > 256 * 1024 * 1024) throw new Error('Preview output too large');
                    images.push(png); parentPort!.postMessage({ progress: true, done: images.length, total: slideCount });
                }
                parentPort!.postMessage({ images, slideCount });
            } finally { document.destroy(); }
        } catch (error) { parentPort!.postMessage({ error: true, reason: error instanceof Error ? error.message : 'PDF rendering failed' }); }
        finally { library?.destroy(); }
    })();
}
