import { operationStage, operationProgress, operationIssue } from './operation-progress';
import { assertStorageCapacity } from './maintenance';
import { MAX_UPLOAD_BYTES } from './upload-limits';
import { Controller, Get, Post, Req, Param, UploadedFiles, UseInterceptors, Body, BadRequestException } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Auth, Context } from '../modules/auth';
import { ShopService } from '../modules/shop.service';
import { LocalStorage, validateUpload } from './local';
import { syncCurrent } from './purchase-files';
import { storageHealth } from './monitor';
import { RenderedPreview, renderPptxPreviews } from './pptx-preview';
import { validatePdf, renderPdfPreviews } from './pdf-preview';
@Controller('admin')
export class PurchaseFileController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    @Get('operations/:id')
    progress(@Req() req: Context, @Param('id') id: string) { this.auth.requireAdmin(req, 'ADMIN'); return operationProgress(id, req.admin.adminId); }
    @Get('products/:id/traces')
    async traces(@Req() req: Context, @Param('id') id: string) {
        this.auth.requireAdmin(req, 'ADMIN');
        const rows = await this.shop.db.setting.findMany({ where: { key: { startsWith: 'productTrace:' + id + ':' } }, orderBy: { updatedAt: 'desc' }, take: 50 });
        return rows.map(row => row.value);
    }
    @Post('products/:id/previews/regenerate')
    async regenerate(@Req() req: Context, @Param('id') id: string) {
        this.auth.requireAdmin(req, 'ADMIN');
        const latest = await this.shop.db.fileVersion.findFirstOrThrow({ where: { productId: id }, orderBy: { createdAt: 'desc' } });
        const storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        operationStage(req, 'render');
        const rendered = await renderPptxPreviews(await fs.readFile(storage.resolve(latest.key)), (done, total) => operationStage(req, 'render', Math.round(done / total * 100), done, total));
        const keys: string[] = [];
        try {
            operationStage(req, 'store');
            await this.shop.db.$transaction(async tx => {
                await this.shop.lock(tx, 'storage-capacity');
                await assertStorageCapacity(this.shop, rendered.images.reduce((sum, image) => sum + image.length, 0));
                await this.shop.lock(tx, 'product:' + id);
                const product = await tx.product.findUniqueOrThrow({ where: { id } });
                if (product.deletedAt) throw new BadRequestException('Restore product first');
                const current = await tx.fileVersion.findFirstOrThrow({ where: { productId: id }, orderBy: { createdAt: 'desc' } });
                if (current.id !== latest.id) throw new BadRequestException('Original changed; retry');
                for (const image of rendered.images) keys.push((await storage.put(image, 'png')).key);
                await tx.fileVersion.update({ where: { id: latest.id }, data: { previews: keys } });
                await tx.product.update({ where: { id }, data: { metadata: { ...(product.metadata as any), slides: rendered.slideCount } } });
                operationStage(req, 'commit');
            }, { timeout: 120000 });
            return { uploaded: true, previews: keys, previewCount: keys.length, fileVersionId: latest.id, metadata: { slides: rendered.slideCount } };
        } catch (error) { await Promise.all(keys.map(key => fs.unlink(storage.resolve(key)).catch(() => {}))); throw error; }
    }
    @Post('products/:id/current-file')
    @UseInterceptors(FileFieldsInterceptor([{ name: 'file', maxCount: 1 }, { name: 'pdf', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 1 } }))
    async replace(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @UploadedFiles()
    files: { file?: Express.Multer.File[]; pdf?: Express.Multer.File[] }, 
    @Body()
    body: unknown) {
        this.auth.requireAdmin(req, 'ADMIN');
        const input = z.object({ kind: z.enum(['original', 'original-pdf', 'preview-pdf', 'preview']).default('original') }).strict().safeParse(body);
        if (!input.success)
            throw new BadRequestException('Invalid upload');
        operationStage(req, 'validate');
        const kind = input.data.kind, file = files?.file?.[0];
        const pdfBytes = kind === 'original-pdf' ? validatePdf(files?.pdf?.[0]) : kind === 'preview-pdf' ? validatePdf(file) : undefined;
        if (files?.pdf?.length && kind !== 'original-pdf') throw new BadRequestException('Unexpected PDF file');
        const valid = kind === 'preview-pdf' ? { buffer: pdfBytes!, extension: 'pdf', slideCount: undefined } : await validateUpload(file!, kind === 'preview' ? 'preview' : 'original'), storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        const usage = await storageHealth(this.shop.config.STORAGE_ROOT), purchases = await storageHealth(this.shop.config.PURCHASE_ROOT);
        const nested = storage.purchaseRoot.startsWith(storage.root + path.sep);
        if (usage.usedBytes + (nested ? 0 : purchases.usedBytes) + valid.buffer.length * 2 > this.shop.config.STORAGE_MAX_BYTES || Math.min(usage.freeBytes, purchases.freeBytes) < valid.buffer.length * 2 + 64 * 1024 * 1024)
            throw new BadRequestException('Private storage quota exceeded');
        const existing = await this.shop.db.product.findUniqueOrThrow({ where: { id } });
        if (existing.deletedAt) throw new BadRequestException('Restore deleted product first');
        operationStage(req, 'render');
        let rendered: RenderedPreview | undefined, previewWarning: string | undefined, previewReason: string | undefined;
        let previewOriginalId: string | undefined;
        const progress = (done: number, total: number) => operationStage(req, 'render', Math.round(done / total * 100), done, total);
        if (kind === 'preview-pdf') {
            const latest = await this.shop.db.fileVersion.findFirst({ where: { productId: id }, orderBy: { createdAt: 'desc' } });
            if (!latest) throw new BadRequestException({ code: 'ORIGINAL_REQUIRED', message: 'Upload PPTX original first' });
            const bytes = await fs.readFile(storage.resolve(latest.key));
            const original = await validateUpload({ buffer: bytes, originalname: latest.filename, size: bytes.length, mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as Express.Multer.File, 'original');
            rendered = await renderPdfPreviews(pdfBytes!, original.slideCount!, progress);
            previewOriginalId = latest.id;
        }
        if (kind === 'original' || kind === 'original-pdf') {
            try { rendered = kind === 'original-pdf' ? await renderPdfPreviews(pdfBytes!, valid.slideCount!, progress) : await renderPptxPreviews(valid.buffer, progress); }
            catch (error: any) {
                previewWarning = 'PREVIEW_RENDER_FAILED'; previewReason = (kind === 'original-pdf' ? (error.getResponse?.()?.code || 'PDF_RENDER_FAILED') + ': ' : '') + (error.getResponse?.()?.reason || 'Preview renderer unavailable');
                operationIssue(req, previewWarning, previewReason!);
            }
        }
        const previewBytes = rendered?.images.reduce((total, image) => total + image.length, 0) || 0;
        if (usage.usedBytes + (nested ? 0 : purchases.usedBytes) + valid.buffer.length * 2 + previewBytes > this.shop.config.STORAGE_MAX_BYTES || Math.min(usage.freeBytes, purchases.freeBytes) < valid.buffer.length * 2 + previewBytes + 64 * 1024 * 1024)
            throw new BadRequestException('Private storage quota exceeded');
        let written: string | undefined, currentKey: string | undefined, previous: Buffer | undefined;
        const previewKeys: string[] = [];
        try {
            return await this.shop.db.$transaction(async (tx) => {
                await this.shop.lock(tx, 'storage-capacity');
                await assertStorageCapacity(this.shop, valid.buffer.length * 2 + previewBytes);
                await this.shop.lock(tx, 'product:' + id);
                const product = await tx.product.findUniqueOrThrow({ where: { id }, include: { category: true } });
                if (product.deletedAt)
                    throw new BadRequestException('Restore deleted product first');
                const latest = await tx.fileVersion.findFirst({ where: { productId: id }, orderBy: { createdAt: 'desc' } });
                if (kind === 'preview-pdf') {
                    if (!latest || latest.id !== previewOriginalId) throw new BadRequestException('Original changed; retry');
                    operationStage(req, 'store');
                    for (const image of rendered!.images) previewKeys.push((await storage.put(image, 'png')).key);
                    await tx.fileVersion.update({ where: { id: latest.id }, data: { previews: previewKeys } });
                    operationStage(req, 'commit');
                    await this.shop.audit(tx, req.admin.adminId, 'PDF_PREVIEW_UPLOAD', latest.id, { pages: previewKeys.length }, req.requestId);
                    return { uploaded: true, previews: previewKeys, previewCount: previewKeys.length, fileVersionId: latest.id };
                }
                if (kind === 'preview') {
                    if (!latest)
                        throw new BadRequestException('Upload original first');
                    const image = await storage.put(valid.buffer, valid.extension);
                    written = image.key;
                    const previews = [...(latest.previews as string[]), image.key];
                    await tx.fileVersion.update({ where: { id: latest.id }, data: { previews } });
                    await this.shop.audit(tx, req.admin.adminId, 'PREVIEW_UPLOAD', latest.id, { size: image.size }, req.requestId);
                    return { uploaded: true, previews, fileVersionId: latest.id };
                }
                operationStage(req, 'store');
                const fileId = randomUUID(), stored = await storage.putHistory(valid.buffer, fileId, product.titleZh);
                written = stored.key;
                for (const image of rendered?.images || []) previewKeys.push((await storage.put(image, 'png')).key);
                const result = await tx.fileVersion.create({ data: { id: fileId, productId: id, version: 'u-' + fileId, ...stored, previews: previewKeys } });
                const metadata = { ...(product.metadata as Record<string, unknown>), slides: valid.slideCount };
                await tx.product.update({ where: { id }, data: { metadata } });
                currentKey = storage.currentKey(product.category.nameZh, product.titleZh);
                try {
                    previous = await fs.readFile(storage.resolve(currentKey));
                }
                catch (e: any) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                operationStage(req, 'archive');
                await syncCurrent(tx, storage, product, result);
                operationStage(req, 'commit');
                await this.shop.audit(tx, req.admin.adminId, 'FILE_REPLACE', result.id, { filename: result.filename, size: result.size, sha256: result.sha256 }, req.requestId);
                return { uploaded: true, filename: result.filename, previews: previewKeys, previewCount: previewKeys.length, fileVersionId: result.id, metadata, previewWarning, previewReason };
            }, { timeout: 120000 });
        }
        catch (error) {
            if (currentKey) {
                if (previous)
                    await storage.replace(currentKey, previous);
                else
                    await fs.unlink(storage.resolve(currentKey)).catch(() => { });
            }
            if (written)
                await fs.unlink(storage.resolve(written)).catch(() => { });
            await Promise.all(previewKeys.map(key => fs.unlink(storage.resolve(key)).catch(() => { })));
            throw error;
        }
    }
}
