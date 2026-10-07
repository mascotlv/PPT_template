import { MAX_UPLOAD_BYTES } from './upload-limits';
import { BadRequestException } from '@nestjs/common';
import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { hash } from '../security';
export interface StorageAdapter {
    put(bytes: Buffer, extension: string): Promise<{
        key: string;
        size: number;
        sha256: string;
    }>;
    resolve(key: string): string;
}
export function titleFilename(title: string) { let stem = title.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[.\s]+$/, '').trim(); stem = Array.from(stem).slice(0, 100).join(''); if (!stem || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem))
    stem = 'template_' + stem; return stem + '.pptx'; }
export function purchaseFilename(order: any) { const snapshot = order.item?.snapshot || {}; const translated = snapshot.translations?.[order.language]?.title; return titleFilename(translated || (order.language === 'en' ? snapshot.titleEn : '') || snapshot.titleZh || order.item?.fileVersion?.filename?.replace(/\.pptx$/i, '') || 'template'); }
// Chat attachments keep the user's original name but scrubbed to a storage-safe, path-safe token.
export function chatFilename(name: string) { const base = name.normalize('NFKC').split(/[\\/]/).pop() || 'file'; const dot = base.lastIndexOf('.'); const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80) || 'file'; const ext = (dot > 0 ? base.slice(dot + 1) : '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16); return ext ? `${stem}.${ext}` : stem; }
export class LocalStorage implements StorageAdapter {
    constructor(readonly root: string, readonly purchaseRoot = path.join(root, '购买文件')) { }
    resolve(key: string) {
        let base = this.root, relative = key;
        const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
        const parts = key.split('/');
        if (parts[0] === 'purchased') {
            if (parts.length !== 4 || ['.', '..'].includes(parts[2]) || !uuid.test(parts[1]) || !/^[-a-zA-Z\d._]{1,40}$/.test(parts[2]) || titleFilename(parts[3].slice(0, -5)) !== parts[3])
                throw new BadRequestException('Invalid storage key');
            base = this.purchaseRoot;
            relative = parts.slice(1).join('/');
        }
        else if (parts[0] === 'history') {
            if (parts.length !== 3 || !uuid.test(parts[1]) || titleFilename(parts[2].slice(0, -5)) !== parts[2])
                throw new BadRequestException('Invalid history key');
            base = path.join(this.root, '历史原文件');
            relative = parts.slice(1).join('/');
        }
        else if (parts[0] === 'catalog') {
            if (parts.length !== 3 || titleFilename(parts[1]).slice(0, -5) !== parts[1] || titleFilename(parts[2].slice(0, -5)) !== parts[2])
                throw new BadRequestException('Invalid catalog key');
            base = this.purchaseRoot;
            relative = parts.slice(1).join('/');
        }
        else if (parts[0] === 'chat') {
            if (parts.length !== 3 || !uuid.test(parts[1]) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(parts[2]) || parts[2].includes('..'))
                throw new BadRequestException('Invalid chat key');
            base = path.join(this.root, '聊天附件');
            relative = parts.slice(1).join('/');
        }
        else if (!/^[a-zA-Z\d_-]+\.(pptx|png|jpg|webp)$/.test(key))
            throw new BadRequestException('Invalid storage key');
        const target = path.resolve(base, relative);
        if (!target.startsWith(path.resolve(base) + path.sep))
            throw new BadRequestException('Invalid path');
        let current = target;
        while (true) {
            try {
                if (lstatSync(current).isSymbolicLink())
                    throw new BadRequestException('Linked storage paths are not allowed');
            }
            catch (e: any) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
        return target;
    }
    async put(bytes: Buffer, extension: string) { const key = `${randomUUID()}.${extension}`; await fs.mkdir(this.root, { recursive: true }); await fs.writeFile(this.resolve(key), bytes, { flag: 'wx', mode: 0o600 }); return { key, size: bytes.length, sha256: hash(bytes) }; }
    async putPurchased(bytes: Buffer, productId: string, version: string, title: string) { const filename = titleFilename(title); const key = `purchased/${productId}/${version}/${filename}`; const target = this.resolve(key); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); return { key, filename, size: bytes.length, sha256: hash(bytes) }; }
    currentKey(category: string, title: string) { return `catalog/${titleFilename(category).slice(0, -5)}/${titleFilename(title)}`; }
    async putHistory(bytes: Buffer, id: string, title: string) { const filename = titleFilename(title), key = `history/${id}/${filename}`, target = this.resolve(key); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); return { key, filename, size: bytes.length, sha256: hash(bytes) }; }
    async putChat(bytes: Buffer, owner: string, filename: string) {
        const safe = chatFilename(filename), target = this.resolve(`chat/${owner}/${safe}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        let key = `chat/${owner}/${safe}`, attempt = 0;
        while (attempt < 5) {
            try {
                await fs.writeFile(this.resolve(key), bytes, { flag: 'wx', mode: 0o600 });
                return { key, size: bytes.length, sha256: hash(bytes) };
            }
            catch (e: any) {
                if (e.code !== 'EEXIST' || attempt >= 4)
                    throw e;
                const dot = safe.lastIndexOf('.'), stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
                key = `chat/${owner}/${stem}-${randomUUID().slice(0, 8)}${ext}`;
                attempt++;
            }
        }
        throw new Error('Unable to allocate chat attachment key');
    }
    async replace(key: string, bytes: Buffer) { const target = this.resolve(key); await fs.mkdir(path.dirname(target), { recursive: true }); const temporary = target + '.tmp-' + randomUUID(); try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, target);
    }
    finally {
        await fs.unlink(temporary).catch(() => { });
    } }
}
export async function validateUpload(file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
}, kind: string) {
    if (!file || file.size === 0 || /[\\/\x00]/.test(file.originalname) || file.originalname.length > 160)
        throw new BadRequestException('Invalid file or filename');
    if (file.size > MAX_UPLOAD_BYTES)
        throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'File exceeds 1 GiB' });
    if (kind === 'preview') {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
            throw new BadRequestException('Preview must be PNG, JPEG or WebP');
        try {
            const meta = await sharp(file.buffer, { limitInputPixels: 20000000 }).metadata();
            if (!['png', 'jpeg', 'webp'].includes(meta.format || ''))
                throw new Error();
            return { extension: 'webp', buffer: await sharp(file.buffer, { limitInputPixels: 20000000 }).rotate().webp().toBuffer(), slideCount: undefined };
        }
        catch {
            throw new BadRequestException('Invalid image');
        }
    }
    if (file.buffer.length < 4 || !file.originalname.toLowerCase().endsWith('.pptx') || file.mimetype !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || file.buffer.readUInt32LE(0) !== 0x04034b50)
        throw new BadRequestException({ code: 'INVALID_PPTX', message: 'Original must be a valid PPTX' });
    let xmlBytes = 0, count = 0;
    // Media entries are inspected without inflating them. Only structural XML is
    // decompressed, with its own resource budget; the total compressed upload is capped separately.
    try {
        const entries = unzipSync(file.buffer, { filter: f => {
                count++;
                if (count > 1500 || f.originalSize / Math.max(1, f.size) > 200 || f.name.split('/').includes('..') || f.name.startsWith('/') || /\\|vbaProject|\.exe$|\.js$|\.html$/i.test(f.name))
                    throw new Error('Unsafe archive');
                const xml = /\.(xml|rels)$/i.test(f.name);
                if (xml) {
                    xmlBytes += f.originalSize;
                    if (f.originalSize > 20 * 1024 * 1024 || xmlBytes > 80 * 1024 * 1024)
                        throw new Error('XML resource budget exceeded');
                }
                return xml;
            } });
        if (!entries['[Content_Types].xml'] || !entries['ppt/presentation.xml'] || !Object.keys(entries).some(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)))
            throw new Error('PPTX parts missing');
        // External links may occur in normal templates; the renderer ignores external media.
        const presentation = Buffer.from(entries['ppt/presentation.xml']).toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
        const slideCount = [...presentation.matchAll(/<(?:[\w]+:)?sldId(?=\s|\/|>)/g)].length;
        if (!slideCount || slideCount > 500) throw new Error('Invalid slide count');
        return { extension: 'pptx', buffer: file.buffer, slideCount };
    }
    catch {
        throw new BadRequestException({ code: 'INVALID_PPTX', message: 'Unsafe or invalid PPTX archive' });
    }
}
