import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { assertStorageCapacity } from '../storage/maintenance';
import { MAX_UPLOAD_BYTES } from '../storage/upload-limits';
import { BadRequestException, ConflictException, NotFoundException, Controller, Get, Post, Patch, Req, Param, Body, Query, Res, Sse, MessageEvent, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { Auth, Context } from '../modules/auth';
import { ShopService } from '../modules/shop.service';
import { LocalStorage } from '../storage/local';
import { LANGUAGES } from './constants';
import { avatarInput, nicknameInput, sellerProfile, customerProfile, sellerProfileKey, uploadFilename } from './chat-profile';
import { ChatTranslation } from './chat-translation';
import { encrypt } from '../security';
// A message carries text, an attachment, or both; at least one must be present.
const input = z.object({ content: z.string().trim().max(2000).default(''), clientId: z.uuid(), attachment: z.object({ key: z.string().max(300), filename: z.string().max(200), mimetype: z.string().max(150), size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['IMAGE', 'FILE']) }).strict().optional() }).strict().refine(v => v.content.length > 0 || v.attachment, { message: 'Message is empty' });
const paging = z.object({ before: z.uuid().optional() }).strict();
const messageFields = { id: true, sender: true, content: true, clientId: true, createdAt: true, attachment: { select: { id: true, filename: true, mimetype: true, size: true, kind: true } } } as const;
function read<T>(schema: z.ZodType<T>, value: unknown) { const result = schema.safeParse(value); if (!result.success)
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid message' }); return result.data; }
const ATTACHMENT_TYPES: Record<string, string[]> = { png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'], svg: ['image/svg+xml'], pdf: ['application/pdf'], txt: ['text/plain'], csv: ['text/csv'], md: ['text/markdown', 'text/plain'], json: ['application/json', 'text/plain'], zip: ['application/zip', 'application/x-zip-compressed'], doc: ['application/msword'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xls: ['application/vnd.ms-excel'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ppt: ['application/vnd.ms-powerpoint'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], rtf: ['application/rtf'], rar: ['application/vnd.rar', 'application/x-rar-compressed'], '7z': ['application/x-7z-compressed'], mp3: ['audio/mpeg'], wav: ['audio/wav'], mp4: ['video/mp4'] };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Hard ceiling for a single chat attachment (1 GiB). Applies to both storefront and admin uploads.
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;
function validateAttachment(file: Express.Multer.File) {
    if (file) file.originalname = uploadFilename(file.originalname);
    if (!file || !file.size || /[\\/\x00]/.test(file.originalname) || file.originalname.length > 200)
        throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid attachment' });
    if (file.size > MAX_ATTACHMENT_BYTES)
        throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Attachment exceeds 1 GiB' });
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    const allowed = ATTACHMENT_TYPES[ext];
    if (!allowed || !allowed.includes(file.mimetype))
        throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Unsupported file type' });
    return { kind: IMAGE_TYPES.includes(file.mimetype) ? 'IMAGE' as const : 'FILE' as const, filename: file.originalname, mimetype: file.mimetype, size: file.size };
}
export class Messaging {
    private connections = new Map<string, number>();
    private translator: ChatTranslation;
    constructor(readonly shop: ShopService, readonly auth: Auth) { this.translator = new ChatTranslation(shop); }
    async own(req: Context) { const buyer = this.auth.requireCustomer(req); return this.shop.db.chatConversation.upsert({ where: { customerId: buyer.id }, create: { customerId: buyer.id }, update: {} }); }
    async unread(req: Context) {
        const buyer = this.auth.requireCustomer(req);
        const conversation = await this.shop.db.chatConversation.findUnique({ where: { customerId: buyer.id } });
        const unreadCount = conversation ? await this.shop.db.chatMessage.count({ where: { conversationId: conversation.id, sender: 'SELLER', createdAt: { gt: conversation.buyerSeenAt } } }) : 0;
        return { unreadCount };
    }
    async history(id: string, role: 'BUYER' | 'SELLER', query: unknown) {
        const p = read(paging, query), conversation = await this.shop.db.chatConversation.findUniqueOrThrow({ where: { id } });
        if (p.before && !await this.shop.db.chatMessage.count({ where: { id: p.before, conversationId: id } }))
            throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid message cursor' });
        const rows = await this.shop.db.chatMessage.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51, ...(p.before ? { cursor: { id: p.before }, skip: 1 } : {}), select: messageFields });
        if (!p.before)
            await this.shop.db.chatConversation.update({ where: { id }, data: role === 'BUYER' ? { buyerSeenAt: rows[0]?.createdAt || conversation.createdAt } : { sellerSeenAt: rows[0]?.createdAt || conversation.createdAt } });
        const customer = await this.shop.db.customer.findUniqueOrThrow({ where: { id: conversation.customerId } });
        const participants = { BUYER: await customerProfile(this.shop.db, customer), SELLER: await sellerProfile(this.shop.db) };
        const translationRevision = (await this.shop.db.setting.findUnique({ where: { key: 'chat-translation-config' }, select: { updatedAt: true } }))?.updatedAt.toISOString() || '';
        return { id: conversation.id, status: conversation.status, participants, translationRevision, messages: rows.slice(0, 50).reverse().map(m => ({ ...m, ...(m.attachment ? { attachment: { ...m.attachment, filename: uploadFilename(m.attachment.filename) } } : {}) })), hasMore: rows.length > 50, before: rows.length ? rows[Math.min(49, rows.length - 1)].id : null };
    }
    async send(req: Context, id: string, role: 'BUYER' | 'SELLER', body: unknown) {
        const p = read(input, body);
        await this.auth.rate(req, 'chat-send', 30, 60000, role === 'BUYER' ? req.guest.customerId : req.admin.adminId);
        // Attachments are staged on disk under chat/<ownerId>/ before the message references them; the owner must match the sender.
        if (p.attachment && !p.attachment.key.startsWith(`chat/${role === 'BUYER' ? req.guest.customerId : req.admin.adminId}/`))
            throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Attachment unavailable' });
        return this.shop.db.$transaction(async (tx) => {
            await this.shop.lock(tx, 'conversation:' + id);
            const old = await tx.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: id, clientId: p.clientId } }, select: messageFields });
            if (old) {
                if (old.content !== p.content || old.sender !== role)
                    throw new ConflictException({ code: 'CONFLICT', message: 'Message identifier reused' });
                return old;
            }
            const conversation = await tx.chatConversation.findUniqueOrThrow({ where: { id } });
            if (role === 'BUYER' && conversation.customerId !== this.auth.requireCustomer(req).id)
                throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Conversation unavailable' });
            const message = await tx.chatMessage.create({ data: { conversationId: id, sender: role, actorId: role === 'BUYER' ? req.guest.customerId : req.admin.adminId, content: p.content, clientId: p.clientId, ...(p.attachment ? { attachment: { create: p.attachment } } : {}) }, select: messageFields });
            await tx.chatConversation.update({ where: { id }, data: { updatedAt: message.createdAt, status: 'OPEN', ...(role === 'BUYER' ? { buyerSeenAt: message.createdAt } : { sellerSeenAt: message.createdAt }) } });
            if (role === 'SELLER')
                await this.shop.audit(tx, req.admin.adminId, 'CHAT_REPLY', id, { messageId: message.id, attachment: !!p.attachment }, req.requestId);
            return message;
        });
    }
    // Stage an upload: bytes land in chat/<ownerId>/<name>. The returned key is later referenced by a message.
    async upload(req: Context, role: 'BUYER' | 'SELLER', file: Express.Multer.File) {
        const meta = validateAttachment(file);
        const owner = role === 'BUYER' ? req.guest.customerId : req.admin.adminId;
        const storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        const stored = await this.shop.db.$transaction(async tx => {
            await this.shop.lock(tx, 'storage-capacity');
            await assertStorageCapacity(this.shop, file.buffer.length);
            return storage.putChat(file.buffer, owner, meta.filename);
        }, { timeout: 120000 });
        return { key: stored.key, filename: meta.filename, mimetype: meta.mimetype, size: stored.size, sha256: stored.sha256, kind: meta.kind };
    }
    async attachment(req: Context, id: string, role: 'BUYER' | 'SELLER') {
        const row = await this.shop.db.chatMessage.findUnique({ where: { id }, select: { conversation: { select: { customerId: true } }, attachment: true } });
        if (!row?.attachment)
            throw new NotFoundException({ code: 'NOT_FOUND', message: 'Attachment not found' });
        if (role === 'BUYER' && row.conversation.customerId !== this.auth.requireCustomer(req).id)
            throw new NotFoundException({ code: 'NOT_FOUND', message: 'Attachment not found' });
        return row.attachment;
    }
    async download(req: Context, id: string, role: 'BUYER' | 'SELLER', inline: boolean, res: any) {
        const attachment = await this.attachment(req, id, role);
        const storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        const bytes = await fs.readFile(storage.resolve(attachment.key));
        const encoded = encodeURIComponent(uploadFilename(attachment.filename)).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16));
        res.setHeader('Content-Type', attachment.mimetype);
        res.setHeader('Content-Length', String(bytes.length));
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
        res.end(bytes);
    }
    async list() {
        const rows = await this.shop.db.chatConversation.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100, include: { customer: { select: { id: true, name: true, email: true, country: true, language: true } }, messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: messageFields } } });
        return Promise.all(rows.map(async c => {
            const unreadCount = await this.shop.db.chatMessage.count({ where: { conversationId: c.id, sender: 'BUYER', createdAt: { gt: c.sellerSeenAt } } });
            return { ...c, customer: { ...c.customer, ...await customerProfile(this.shop.db, c.customer) }, unread: unreadCount > 0, unreadCount, messages: c.messages.map(m => ({ ...m, ...(m.attachment ? { attachment: { ...m.attachment, filename: uploadFilename(m.attachment.filename) } } : {}) })) };
        }));
    }
    async translate(req: Context, id: string, role: 'BUYER' | 'SELLER', body: unknown) {
        const p = read(z.object({ target: z.enum(LANGUAGES) }).strict(), body);
        if (role === 'SELLER') this.auth.requireAdmin(req);
        else this.auth.requireCustomer(req);
        const message = await this.shop.db.chatMessage.findUnique({ where: { id }, include: { conversation: true } });
        if (!message || (role === 'BUYER' && message.conversation.customerId !== req.guest.customerId)) throw new NotFoundException();
        await this.auth.rate(req, 'chat-translate', 180, 60000, role === 'BUYER' ? req.guest.customerId : req.admin.adminId);
        return message.content ? this.translator.translate(message.content, p.target) : { status: 'ready', text: '', target: p.target };
    }
    async stream(req: Context, admin: boolean) {
        const identity = admin ? this.auth.requireAdmin(req) : this.auth.requireGuest(req);
        if (!admin)
            this.auth.requireCustomer(req);
        await this.auth.rate(req, 'chat-stream', 10);
        if ((this.connections.get(identity.id) || 0) >= 3)
            throw new BadRequestException({ code: 'RATE_LIMITED', message: 'Too many message connections' });
        return new Observable<MessageEvent>(subscriber => {
            this.connections.set(identity.id, (this.connections.get(identity.id) || 0) + 1);
            let busy = false, last: string | undefined;
            const tick = async () => {
                if (busy || subscriber.closed)
                    return;
                busy = true;
                try {
                    const session = await this.shop.db.session.findUnique({ where: { id: identity.id }, select: { expiresAt: true, revokedAt: true, admin: { select: { disabled: true } }, customer: { select: { disabled: true } } } });
                    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.admin?.disabled || session.customer?.disabled) {
                        subscriber.complete();
                        return;
                    }
                    const rows = await this.shop.db.chatConversation.findMany({ where: admin ? {} : { customerId: req.guest.customerId }, select: { id: true, updatedAt: true, buyerSeenAt: true, sellerSeenAt: true, status: true, customer: { select: { updatedAt: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100 });
                    const profile = await this.shop.db.setting.findUnique({ where: { key: sellerProfileKey }, select: { updatedAt: true } });
                    const translation = await this.shop.db.setting.findUnique({ where: { key: 'chat-translation-config' }, select: { updatedAt: true } });
                    const revision = rows.map(c => c.id + ':' + c.updatedAt.toISOString() + ':' + (admin ? c.sellerSeenAt : c.buyerSeenAt).toISOString() + ':' + c.customer.updatedAt.toISOString() + ':' + c.status).join(',') + ':' + (profile?.updatedAt.toISOString() || '') + ':' + (translation?.updatedAt.toISOString() || '');
                    if (revision !== last) {
                        subscriber.next({ data: { revision } });
                        last = revision;
                    }
                }
                catch {
                    subscriber.complete();
                }
                finally {
                    busy = false;
                }
            };
            void tick();
            const timer = setInterval(() => void tick(), 1000);
            timer.unref();
            return () => { clearInterval(timer); const remaining = (this.connections.get(identity.id) || 1) - 1; if (remaining)
                this.connections.set(identity.id, remaining);
            else
                this.connections.delete(identity.id); };
        });
    }
}
@Controller()
export class ChatController {
    constructor(readonly messaging: Messaging) { }
    @Get('chat/unread')
    async unread(@Req() req: Context) { return this.messaging.unread(req); }
    @Patch('chat/preferences')
    async preferences(@Req() req: Context, @Body() body: unknown) {
        const buyer = this.messaging.auth.requireCustomer(req), p = read(z.object({ language: z.enum(LANGUAGES) }).strict(), body);
        if (buyer.language !== p.language) await this.messaging.shop.db.customer.update({ where: { id: buyer.id }, data: p });
        return { saved: true };
    }
    @Get('admin/account')
    async account(@Req() req: Context) { this.messaging.auth.requireAdmin(req); return sellerProfile(this.messaging.shop.db); }
    @Patch('admin/account')
    async profile(@Req() req: Context, @Body() body: unknown) {
        this.messaging.auth.requireAdmin(req, 'ADMIN');
        const p = read(z.object({ nickname: nicknameInput, avatar: avatarInput, email: z.email().max(254).transform(v => v.toLowerCase()).optional(), password: z.string().min(12).max(128).optional() }).strict(), body);
        const credentials = p.email !== undefined || p.password !== undefined;
        if (credentials) this.messaging.auth.reauth(req);
        const passwordHash = p.password ? await argon2.hash(p.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }) : undefined;
        try {
            await this.messaging.shop.db.$transaction(async tx => {
                await this.messaging.shop.lock(tx, 'admin-account:' + req.admin.adminId);
                if (credentials) {
                    await tx.admin.update({ where: { id: req.admin.adminId }, data: { ...(p.email ? { email: p.email } : {}), ...(passwordHash ? { passwordHash } : {}) } });
                    if (passwordHash || p.email !== req.admin.admin.email) {
                        await tx.session.updateMany({ where: { adminId: req.admin.adminId, id: { not: req.admin.id } }, data: { revokedAt: new Date() } });
                        await tx.session.update({ where: { id: req.admin.id }, data: { reauthAt: null } });
                    }
                }
                const value = { nickname: p.nickname, avatar: p.avatar }, key = sellerProfileKey;
                await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
                await this.messaging.shop.audit(tx, req.admin.adminId, 'ADMIN_ACCOUNT_UPDATE', req.admin.adminId, { emailChanged: !!p.email && p.email !== req.admin.admin.email, passwordChanged: !!passwordHash }, req.requestId);
            });
        } catch (error: any) { if (error.code === 'P2002') throw new ConflictException({ code: 'ACCOUNT_EXISTS' }); throw error; }
        return { saved: true, credentialsChanged: !!passwordHash || (!!p.email && p.email !== req.admin.admin.email) };
    }
    @Get('admin/chat/translation-settings')
    async translationSettings(@Req() req: Context) {
        this.messaging.auth.requireAdmin(req, 'ADMIN');
        const config = this.messaging.shop.config;
        const value = (await this.messaging.shop.db.setting.findUnique({ where: { key: 'chat-translation-config' } }))?.value as any;
        return value ? { provider: value.provider, url: value.url || '', hasKey: !!value.encryptedKey } : { provider: config.CHAT_TRANSLATION_URL ? 'libretranslate' : config.GOOGLE_TRANSLATION_KEY ? 'google' : 'disabled', url: config.CHAT_TRANSLATION_URL || '', hasKey: !!(config.CHAT_TRANSLATION_KEY || config.GOOGLE_TRANSLATION_KEY) };
    }
    @Patch('admin/chat/translation-settings')
    async saveTranslationSettings(@Req() req: Context, @Body() body: unknown) {
        this.messaging.auth.requireAdmin(req, 'ADMIN');
        const p = read(z.object({ provider: z.enum(['disabled', 'google', 'libretranslate']), url: z.string().max(2000).default(''), apiKey: z.string().max(1000).default('') }).strict(), body);
        if (p.provider === 'libretranslate') {
            const url = z.url().safeParse(p.url);
            if (!url.success || !['https:', 'http:'].includes(new URL(p.url).protocol) || new URL(p.url).username || new URL(p.url).password) throw new BadRequestException({ code: 'INVALID_INPUT' });
        }
        const key = 'chat-translation-config', config = this.messaging.shop.config;
        const old = (await this.messaging.shop.db.setting.findUnique({ where: { key } }))?.value as any;
        const fallbackKey = p.provider === 'google' ? config.GOOGLE_TRANSLATION_KEY : config.CHAT_TRANSLATION_KEY;
        const encryptedKey = p.apiKey ? encrypt(p.apiKey, config.ADMIN_ENCRYPTION_KEY) : old?.provider === p.provider ? old.encryptedKey || '' : !old && fallbackKey ? encrypt(fallbackKey, config.ADMIN_ENCRYPTION_KEY) : '';
        if (p.provider === 'google' && !encryptedKey) throw new BadRequestException({ code: 'INVALID_INPUT' });
        const value = { provider: p.provider, url: p.provider === 'libretranslate' ? p.url : '', encryptedKey: p.provider === 'disabled' ? '' : encryptedKey };
        await this.messaging.shop.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
        if (p.provider !== 'disabled') {
            const products = await this.messaging.shop.db.product.findMany({ where: { deletedAt: null }, select: { id: true } });
            const batch = randomUUID();
            await this.messaging.shop.db.job.createMany({ data: products.map(product => ({ kind: 'CONTENT_TRANSLATION', relatedId: product.id, idempotencyKey: 'content-translation:' + batch + ':' + product.id, payload: {} })) });
            return { saved: true, translationQueued: products.length };
        }
        return { saved: true };
    }
    @Post('chat/messages/:id/translation')
    translation(@Req() req: Context, @Param('id') id: string, @Body() body: unknown) { return this.messaging.translate(req, id, 'BUYER', body); }
    @Post('admin/chat/messages/:id/translation')
    adminTranslation(@Req() req: Context, @Param('id') id: string, @Body() body: unknown) { return this.messaging.translate(req, id, 'SELLER', body); }
    @Get('chat')
    async history(
    @Req()
    req: Context, 
    @Query()
    query: unknown) { return this.messaging.history((await this.messaging.own(req)).id, 'BUYER', query); }
    @Post('chat/messages')
    async send(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { return this.messaging.send(req, (await this.messaging.own(req)).id, 'BUYER', body); }
    @Post('chat/attachments')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 1 } }))
    async uploadFile(
    @Req()
    req: Context, 
    @UploadedFile()
    file: Express.Multer.File) { return this.messaging.upload(req, 'BUYER', file); }
    @Get('chat/attachments/:id')
    async downloadFile(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Res()
    res: any) { return this.messaging.download(req, id, 'BUYER', !!req.query.inline, res); }
    @Sse('chat/stream')
    stream(
    @Req()
    req: Context) { return this.messaging.stream(req, false); }
    @Get('admin/chat')
    list() { return this.messaging.list(); }
    @Get('admin/chat/:id/messages')
    adminHistory(
    @Param('id')
    id: string, 
    @Query()
    query: unknown) { return this.messaging.history(id, 'SELLER', query); }
    @Post('admin/chat/:id/messages')
    adminSend(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { return this.messaging.send(req, id, 'SELLER', body); }
    @Post('admin/chat/attachments')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 1 } }))
    async adminUploadFile(
    @Req()
    req: Context, 
    @UploadedFile()
    file: Express.Multer.File) { return this.messaging.upload(req, 'SELLER', file); }
    @Get('admin/chat/attachments/:id')
    async adminDownloadFile(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Res()
    res: any) { return this.messaging.download(req, id, 'SELLER', !!req.query.inline, res); }
    @Sse('admin/chat/stream')
    adminStream(
    @Req()
    req: Context) { return this.messaging.stream(req, true); }
}
