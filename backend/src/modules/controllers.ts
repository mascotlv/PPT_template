import { operationStage, attachProduct } from '../storage/operation-progress';
import { assertStorageCapacity } from '../storage/maintenance';
import { storageOverview, cleanRuntimeFiles, clearBusinessData } from '../storage/maintenance';
import { MAX_UPLOAD_BYTES } from '../storage/upload-limits';
import { Transform } from 'node:stream';
import { storageHealth } from '../storage/monitor';
import { Controller, Get, Post, Patch, Delete, Req, Res, Param, Body, Query, UseInterceptors, UploadedFile, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Auth, Context } from './auth';
import { ShopService } from './shop.service';
import { LocalStorage, validateUpload, purchaseFilename } from '../storage/local';
import { syncCurrent } from '../storage/purchase-files';
import { renderPptxPreviews } from '../storage/pptx-preview';
import { hash, csvCell } from '../security';
import { CURRENCIES, LANGUAGES } from '../commerce/constants';
import { FxService } from '../commerce/fx';
import { cnyMinor } from '../../../packages/contracts/cny.cjs';
import { DIGITS } from '../commerce/constants';
import { adminCustomerContext } from '../commerce/admin-customer-context';
import { ContentTranslation } from '../commerce/content';
import path from 'node:path';
const currency = z.enum(CURRENCIES);
const text = z.string().trim().min(1).max(2000);
const email = z.email().max(254).transform(v => v.toLowerCase());
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const p = schema.safeParse(body); if (!p.success)
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid request fields', fields: p.error.issues.map(i => i.path.join('.')) }); return p.data; }
const productInput = z.object({ slug: z.string().regex(/^[a-z\d-]{3,80}$/), titleZh: text.max(120), titleEn: z.string().max(120).optional(), descriptionZh: text, descriptionEn: z.string().max(2000).optional(), categoryId: z.string().max(80), status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']), sort: z.number().int().min(0).max(10000), metadata: z.object({ slides: z.number().int().min(1).max(500), ratio: z.enum(['16:9', '4:3']), software: text.max(200), editable: text.max(500), fonts: text.max(500), images: text.max(500), license: text.max(500) }).strict(), prices: z.array(z.object({ currency, amount: z.number().int().min(1).max(100000000) }).strict()).min(1).max(29), translations: z.partialRecord(z.enum(LANGUAGES), z.object({ title: text.max(120), description: text, metadata: z.record(z.string(), z.string()).optional() }).strict()).optional() }).strict();
@ApiTags('shop')
@Controller()
export class ShopController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    @Get('health/live')
    live() { return { status: 'ok' }; }
    @Get('health/ready')
    async ready() { await this.shop.db.$queryRaw `SELECT 1`; await fs.access(this.shop.config.STORAGE_ROOT); return { status: 'ready' }; }
    @Get('session')
    session(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response) { return this.auth.bootstrap(req, res); }
    @Post('access')
    access(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response, 
    @Body()
    body: unknown) { return this.auth.testLogin(req, res, parse(z.object({ password: z.string().max(200) }).strict(), body).password); }
    @Post('access/logout')
    async accessLogout(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response) { if (req.testAccess)
        await this.shop.db.session.update({ where: { id: req.testAccess.id }, data: { revokedAt: new Date() } }); res.clearCookie('access', { path: '/api' }); return { ok: true }; }
    @Get('products')
    products(
    @Query()
    query: any) { const price = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/); const q = parse(z.object({ search: z.string().max(100).optional(), category: z.string().max(80).optional(), currency: currency.optional(), priceSort: z.enum(['default', 'asc', 'desc']).optional(), minPrice: price.optional(), maxPrice: price.optional() }).strict(), query); return this.shop.products(q); }
    @Get('categories')
    categories() { return this.shop.db.category.findMany({ where: { archived: false } }); }
    @Get('products/:slug')
    product(
    @Param('slug')
    slug: string) { return this.shop.product(slug); }
    @Get('quotes/:productId')
    quote(
    @Param('productId')
    id: string, 
    @Query()
    q: unknown) { return this.shop.quote(id, parse(z.object({ currency }).strict(), q).currency); }
    @Get('previews/:key')
    async preview(
    @Param('key')
    key: string, 
    @Res()
    res: Response) { const versions = await this.shop.db.fileVersion.findMany({ where: { product: { status: 'PUBLISHED', deletedAt: null, category: { archived: false }, ...(this.shop.config.PAYMENT_MODE === 'mock' ? { isDemo: true } : {}) } }, select: { previews: true } }); if (!versions.some(v => (v.previews as string[]).includes(key)))
        throw new NotFoundException(); res.setHeader('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/png'); createReadStream(new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT).resolve(key)).on('error', () => res.destroy()).pipe(res); }
    @Post('orders')
    @ApiOperation({ summary: 'Create verified customer order with immutable price and file snapshot' })
    @ApiBody({ schema: { type: 'object', required: ['productId', 'email', 'currency', 'language', 'idempotencyKey', 'termsVersion', 'quoteToken'], properties: { productId: { type: 'string' }, email: { type: 'string', format: 'email' }, currency: { enum: [...CURRENCIES] }, language: { enum: [...LANGUAGES] }, idempotencyKey: { type: 'string' }, quoteToken: { type: 'string' }, termsVersion: { type: 'string' } } } })
    async create(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { await this.auth.rate(req, 'order', 20); const data = parse(z.object({ productId: z.uuid(), email, currency, language: z.enum(LANGUAGES), idempotencyKey: z.string().min(16).max(100), termsVersion: z.literal('demo-v1'), quoteToken: z.string().max(1500), source: z.string().max(80).optional() }).strict(), body); this.auth.requireCustomer(req); return this.shop.createOrder(this.auth.requireGuest(req).id, data); }
    @Get('orders')
    async orders(
    @Req()
    req: Context) { const s = this.auth.requireGuest(req); const orders = await this.shop.db.order.findMany({ where: { OR: [{ sessionId: s.id }, ...(s.customerId ? [{ customerId: s.customerId }] : []), ...(s.verifiedEmail ? [{ email: s.verifiedEmail }] : [])] }, orderBy: { createdAt: 'desc' }, take: 100, include: { item: { include: { fileVersion: true, entitlement: true } }, payments: true, refunds: true, tickets: true } }); return orders.map(o => this.shop.publicOrder(o)); }
    @Get('orders/:id')
    async order(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { return this.shop.publicOrder(await this.shop.authorizeOrder(id, this.auth.requireGuest(req))); }
    @Post('orders/:id/query-payment')
    async queryPayment(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { await this.auth.rate(req, 'query-payment', 20); const o = await this.shop.authorizeOrder(id, this.auth.requireGuest(req)); for (const p of o.payments)
        await this.shop.reconcilePayment(p.id); return this.shop.publicOrder(await this.shop.authorizeOrder(id, req.guest)); }
    @Post('orders/:id/pay')
    async pay(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { await this.auth.rate(req, 'payment', 20); if (!await this.shop.canCheckout())
        throw new ForbiddenException({ code: 'PURCHASE_DISABLED', message: 'Purchases are not enabled' }); const order = await this.shop.authorizeOrder(id, this.auth.requireGuest(req)); if (order.status !== 'AWAITING_PAYMENT')
        throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Payment not available' }); return this.shop.mockScenario(order, 'success'); }
    @Post('orders/:id/download')
    async grant(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { await this.auth.rate(req, 'download', 30); return this.shop.downloadGrant(await this.shop.authorizeOrder(id, this.auth.requireGuest(req)), req.guest.id); }
    @Get('downloads/:token')
    async download(
    @Req()
    req: Context, 
    @Param('token')
    raw: string, 
    @Res()
    res: Response) {
        await this.auth.rate(req, 'download-stream', 60);
        const s = this.auth.requireGuest(req);
        const t = await this.shop.db.downloadToken.findUnique({ where: { tokenHash: hash(raw) }, include: { entitlement: { include: { fileVersion: true, orderItem: { include: { order: true } } } } } });
        if (!t || t.sessionId !== s.id || t.expiresAt <= new Date() || t.revokedAt || t.entitlement.status !== 'ACTIVE' || t.entitlement.orderItem.order.status !== 'PAID')
            throw new ForbiddenException('Download authorization expired or revoked');
        const f = t.entitlement.fileVersion;
        const filename = purchaseFilename({ item: t.entitlement.orderItem, language: t.entitlement.orderItem.order.language });
        const target = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT).resolve(f.key);
        const stats = await fs.stat(target);
        let start = 0, end = stats.size - 1;
        if (req.headers.range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            if (!m) {
                res.status(416).setHeader('Content-Range', `bytes */${stats.size}`);
                res.end();
                return;
            }
            start = Number(m[1]);
            end = m[2] ? Number(m[2]) : end;
            if (start > end || end >= stats.size) {
                res.status(416).setHeader('Content-Range', `bytes */${stats.size}`);
                res.end();
                return;
            }
            res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-zA-Z\d._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`);
        const log = await this.shop.db.downloadLog.create({ data: { entitlementId: t.entitlementId, status: 'STARTED' } });
        const stream = createReadStream(target, { start, end });
        let completed = false;
        res.on('finish', () => { completed = true; void this.shop.db.downloadLog.update({ where: { id: log.id }, data: { status: 'COMPLETED', bytes: end - start + 1 } }); });
        res.on('close', () => { stream.destroy(); if (!completed)
            void this.shop.db.downloadLog.update({ where: { id: log.id }, data: { status: 'INTERRUPTED' } }); });
        stream.on('error', () => res.destroy());
        const rules = (await this.shop.db.setting.findUnique({ where: { key: 'downloadRules' } }))?.value as any;
        const speed = Math.max(65536, Math.min(10 * 1024 * 1024, Number(rules?.bytesPerSecond) || 2 * 1024 * 1024));
        stream.pipe(new Transform({ transform(chunk, _encoding, done) { setTimeout(() => done(null, chunk), Math.ceil(chunk.length / speed * 1000)); } })).pipe(res);
    }
    @Post('orders/:id/resend')
    async resend(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { await this.auth.rate(req, 'resend', 3, 3600000); const o = await this.shop.authorizeOrder(id, this.auth.requireGuest(req)); if (o.status !== 'PAID')
        throw new BadRequestException('Paid order required'); await this.shop.job(this.shop.db, 'MAIL', o.id, `resend:${o.id}:${Math.floor(Date.now() / 60000)}`, { template: 'delivery' }); return { queued: true }; }
    @Post('recover/request')
    async recover(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { await this.auth.rate(req, 'recovery', 5, 15 * 60000); const p = parse(z.object({ email }).strict(), body); await this.auth.rate(req, 'recovery-email', 3, 15 * 60000, p.email); await this.shop.recover(p.email); return { message: 'If eligible orders exist, a recovery email will be sent.' }; }
    @Post('recover/redeem')
    async redeem(
    @Req()
    req: Context, 
    @Body()
    body: unknown, 
    @Res({ passthrough: true })
    res: Response) { await this.auth.rate(req, 'redeem', 10); const data = parse(z.object({ token: z.string().min(32).max(100) }).strict(), body); const old = this.auth.requireGuest(req); const fresh = await this.auth.create(res, 'GUEST', 'guest', { customerId: old.customerId }, false); try {
        await this.shop.redeem(data.token, fresh.session.id);
    }
    catch (e) {
        await this.shop.db.session.update({ where: { id: fresh.session.id }, data: { revokedAt: new Date() } });
        throw e;
    } this.auth.cookie(res, 'guest', fresh.raw, 24 * 3600000); await this.shop.db.session.update({ where: { id: old.id }, data: { revokedAt: new Date() } }); return { verified: true, csrf: fresh.csrf }; }
    @Post('orders/:id/refunds')
    async refund(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { const p = parse(z.object({ reason: text.min(5) }).strict(), body); return this.shop.requestRefund(await this.shop.authorizeOrder(id, this.auth.requireGuest(req)), p.reason); }
    @Post('orders/:id/support')
    async support(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { await this.auth.rate(req, 'support', 10); await this.shop.authorizeOrder(id, this.auth.requireGuest(req)); const p = parse(z.object({ content: text.min(5) }).strict(), body); return this.shop.db.supportTicket.create({ data: { orderId: id, content: p.content } }); }
}
@ApiTags('mock-only')
@Controller()
export class MockController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    @Post('mock/orders/:id/scenario')
    async scenario(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { if (!await this.shop.canCheckout())
        throw new ForbiddenException({ code: 'PURCHASE_DISABLED', message: 'Payments unavailable' }); await this.auth.rate(req, 'mock-payment', 30); const p = parse(z.object({ scenario: z.enum(['success', 'cancel', 'failure', 'pending', 'delayed', 'lost', 'duplicate', 'different']) }).strict(), body); return this.shop.mockScenario(await this.shop.authorizeOrder(id, this.auth.requireGuest(req)), p.scenario); }
    @Post('payments/webhooks/mock')
    webhook(
    @Req()
    req: Context) { if (!req.rawBody)
        throw new BadRequestException('Raw body required'); return this.shop.receive(req.rawBody, req.headers); }
}
@ApiTags('admin')
@Controller('admin')
export class AdminController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    @Post('login')
    login(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response, 
    @Body()
    body: unknown) { const p = parse(z.object({ email, password: z.string().min(1).max(200), code: z.string().min(6).max(100) }).strict(), body); return this.auth.login(req, res, p.email, p.password, p.code); }
    @Post('logout')
    async logout(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response) { await this.shop.db.session.update({ where: { id: req.admin.id }, data: { revokedAt: new Date() } }); res.clearCookie('admin', { path: '/api' }); return { ok: true }; }
    @Post('reauth')
    reauth(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { const p = parse(z.object({ password: z.string().max(200), code: z.string().max(100) }).strict(), body); return this.auth.reverify(req, p.password, p.code); }
    @Get('verification')
    verification(@Req() req: Context) { this.auth.requireAdmin(req, 'ADMIN'); return { expiresAt: req.admin.kind !== 'DEV_ADMIN' && req.admin.reauthAt ? new Date(req.admin.reauthAt.getTime() + 5 * 60000).toISOString() : null }; }
    @Get('dashboard')
    async dashboard() {
        const db = this.shop.db;
        const mode = (await db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any;
        const scope = { isTest: mode?.mode !== 'normal' && this.shop.config.PAYMENT_MODE === 'mock' };
        const [orders, refunds, failedJobs] = await Promise.all([db.order.groupBy({ by: ['currency', 'isTest'], where: { paidPaymentId: { not: null }, ...scope }, _sum: { amount: true }, _count: true }), db.refund.groupBy({ by: ['currency'], where: { status: 'SUCCEEDED', order: scope }, _sum: { amount: true }, _count: true }), db.job.count({ where: { status: 'FAILED' } })]);
        const storage = await storageOverview(this.shop);
        const pulse = (await db.setting.findUnique({ where: { key: 'workerPulse' } }))?.value as any;
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), week = new Date(today.getTime() - 6 * 86400000);
        const storedMode = (await db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any;
        const isTest = storedMode?.mode !== 'normal' && this.shop.config.PAYMENT_MODE === 'mock', where = { isTest };
        const [publishedProducts, draftProducts, totalCustomers, ordersCount, paidOrders, todayOrders, monthOrders, pendingRefunds, openTickets, activeEntitlements, unread, recentOrders, weekRows] = await Promise.all([
            db.product.count({ where: { status: 'PUBLISHED', deletedAt: null } }), db.product.count({ where: { status: 'DRAFT', deletedAt: null } }), db.customer.count(), db.order.count({ where }), db.order.count({ where: { ...where, paidPaymentId: { not: null } } }), db.order.count({ where: { ...where, createdAt: { gte: today } } }), db.order.count({ where: { ...where, createdAt: { gte: month } } }), db.refund.count({ where: { status: 'REQUESTED', order: where } }), db.supportTicket.count({ where: { status: 'OPEN' } }), db.entitlement.count({ where: { status: 'ACTIVE', orderItem: { order: where } } }), db.$queryRaw<any[]> `SELECT COUNT(DISTINCT c.id)::int AS count FROM "ChatConversation" c JOIN "ChatMessage" m ON m."conversationId"=c.id WHERE m.sender='BUYER' AND m."createdAt">c."sellerSeenAt"`, db.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, number: true, amount: true, currency: true, status: true, createdAt: true, item: { select: { snapshot: true } } } }), db.order.findMany({ where: { ...where, createdAt: { gte: week } }, select: { createdAt: true, paidPaymentId: true } })
        ]);
        const summary = { publishedProducts, draftProducts, totalCustomers, ordersCount, todayOrders, monthOrders, pendingRefunds, openTickets, activeEntitlements, unreadConversations: unread[0].count, paymentCompletion: ordersCount ? Math.round(paidOrders / ordersCount * 1000) / 10 : 0 };
        const activity = Array.from({ length: 7 }, (_, i) => { const day = new Date(week.getTime() + i * 86400000).toISOString().slice(0, 10), rows = weekRows.filter(o => o.createdAt.toISOString().slice(0, 10) === day); return { day, orders: rows.length, purchases: rows.filter(o => o.paidPaymentId).length }; });
        return { summary, recentOrders, activity, orders, refunds, failedJobs, storage, workerActive: !!pulse && Date.now() - new Date(pulse.at).getTime() < 15000, alerts: [...(failedJobs ? ['TASKS_FAILED'] : []), ...(storage.freeBytes < 512 * 1024 * 1024 ? ['DISK_SPACE_LOW'] : []), ...(storage.usedBytes >= this.shop.config.STORAGE_MAX_BYTES ? ['STORAGE_QUOTA_REACHED'] : [])] };
    }
    @Get('categories')
    categories() { return this.shop.db.category.findMany(); }
    @Post('categories')
    async category(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = parse(z.object({ id: z.string().regex(/^[a-z\d-]{2,80}$/), nameZh: text.max(100), nameEn: z.string().max(100).optional(), translations: z.partialRecord(z.enum(LANGUAGES), text.max(100)).optional() }).strict(), body); const existing = await this.shop.db.category.findUnique({ where: { id: p.id } }); const prepared = await new ContentTranslation(this.shop).category(p, existing); return this.shop.db.$transaction(async (tx) => { await this.shop.lock(tx, 'category:' + p.id); const current = await tx.category.findUnique({ where: { id: p.id } }); if (JSON.stringify(current) !== JSON.stringify(existing)) throw new ConflictException('Category changed; reload and retry');  const c = await tx.category.upsert({ where: { id: p.id }, create: prepared.data, update: prepared.data }); for (const product of await tx.product.findMany({ where: { categoryId: c.id }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } } })) {
        await this.shop.lock(tx, 'product:' + product.id);
        await syncCurrent(tx, new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT), { ...product, category: c }, product.versions[0]);
    } await this.shop.audit(tx, req.admin.adminId, 'CATEGORY_SAVE', p.id, { nameZh: p.nameZh }, req.requestId); return { ...c, translationWarning: prepared.warning }; }); }
    @Get('products')
    products(
    @Req()
    req: Context, 
    @Query('deleted')
    deleted?: string) { this.auth.requireAdmin(req, 'ADMIN'); return this.shop.db.product.findMany({ where: deleted === '1' ? { deletedAt: { not: null } } : { deletedAt: null }, include: { prices: true, versions: { orderBy: { createdAt: 'desc' } } }, orderBy: { sort: 'asc' } }); }
    @Get('products/:id/previews/:key')
    async adminPreview(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Param('key')
    key: string, 
    @Res()
    res: Response) { this.auth.requireAdmin(req, 'ADMIN'); const versions = await this.shop.db.fileVersion.findMany({ where: { productId: id }, select: { previews: true } }); if (!versions.some(v => (v.previews as string[]).includes(key)))
        throw new NotFoundException(); res.setHeader('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/png'); res.setHeader('Cache-Control', 'private, max-age=60'); createReadStream(new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT).resolve(key)).on('error', () => res.destroy()).pipe(res); }
    @Post('products')
    async createProduct(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = parse(productInput, body); return this.saveProduct(req, p); }
    @Patch('products/:id')
    async editProduct(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = parse(productInput, body); return this.saveProduct(req, p, id); }
    async saveProduct(req: Context, p: z.infer<typeof productInput>, id?: string) {
        const { prices: inputPrices, ...input } = p;
        const existing = id ? await this.shop.db.product.findUniqueOrThrow({ where: { id } }) : undefined;
        if (existing?.deletedAt) throw new BadRequestException('Restore product first');
        const categoryBefore = await this.shop.db.category.findUniqueOrThrow({ where: { id: input.categoryId } });
        if (input.status === 'PUBLISHED' && (categoryBefore.archived || !id || !await this.shop.db.fileVersion.count({ where: { productId: id } })))
            throw new BadRequestException({ code: 'ORIGINAL_REQUIRED', message: 'Upload original successfully before publishing; category must be active' });
        operationStage(req, 'translate');
        const translator = new ContentTranslation(this.shop);
        if (existing && await this.shop.db.fileVersion.count({ where: { productId: existing.id } })) input.metadata.slides = (existing.metadata as any).slides;
        const prepared = await translator.product(input, existing);
        const preparedCategory = await translator.category(categoryBefore, categoryBefore);
        if (input.status === 'PUBLISHED') {
        }
        const baseAmount = inputPrices.find(v => v.currency === 'CNY')?.amount;
        if (!baseAmount) throw new BadRequestException('CNY base price required');
        const { prices, snapshot } = await new FxService(this.shop.db).prices(baseAmount);
        operationStage(req, 'commit');
        return this.shop.db.$transaction(async (tx) => {
            await this.shop.lock(tx, 'category:' + input.categoryId);
            const currentCategory = await tx.category.findUniqueOrThrow({ where: { id: input.categoryId } });
            if (JSON.stringify(currentCategory) !== JSON.stringify(categoryBefore)) throw new ConflictException('Category changed; reload and retry');
            if (id) {
                await this.shop.lock(tx, 'product:' + id);
                const current = await tx.product.findUniqueOrThrow({ where: { id } });
                if (current.updatedAt.getTime() !== existing!.updatedAt.getTime()) throw new ConflictException('Product changed; reload and retry');
                if (current.deletedAt) throw new BadRequestException('Restore product first');
            }
            const category = await tx.category.update({ where: { id: input.categoryId }, data: { translations: preparedCategory.data.translations, nameEn: preparedCategory.data.nameEn } });
            const data = prepared.data;
            const saved = id ? await tx.product.update({ where: { id }, data }) : await tx.product.create({ data: { ...data, isDemo: true } });
            attachProduct(req, saved.id);
            for (const price of prices)
                await tx.price.upsert({ where: { productId_currency: { productId: saved.id, currency: price.currency } }, create: { productId: saved.id, ...price }, update: { amount: price.amount, active: true } });
            await tx.setting.upsert({ where: { key: 'pricing:' + saved.id }, create: { key: 'pricing:' + saved.id, value: { snapshotId: snapshot.id, baseAmount } }, update: { value: { snapshotId: snapshot.id, baseAmount } } });
            operationStage(req, 'archive');
            await syncCurrent(tx, new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT), { ...saved, category }, await tx.fileVersion.findFirst({ where: { productId: saved.id }, orderBy: { createdAt: 'desc' } }));
            await this.shop.audit(tx, req.admin.adminId, 'PRODUCT_SAVE', saved.id, { status: p.status, prices }, req.requestId);
            return { ...saved, translationWarning: prepared.warning || preparedCategory.warning };
        });
    }
    @Delete('products/:id')
    async archive(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { this.auth.requireAdmin(req, 'ADMIN'); await this.shop.db.$transaction(async (tx) => { await tx.product.update({ where: { id }, data: { status: 'ARCHIVED', deletedAt: new Date() } }); await this.shop.audit(tx, req.admin.adminId, 'PRODUCT_DELETE', id, {}, req.requestId); }); return { archived: true }; }
    @Post('products/:id/files')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3 } }))
    async upload(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @UploadedFile()
    file: Express.Multer.File, 
    @Body()
    body: unknown) {
        this.auth.requireAdmin(req, 'ADMIN');
        
        const p = parse(z.object({ kind: z.enum(['original', 'preview']), version: z.string().regex(/^[a-zA-Z\d._-]{1,40}$/).refine(v => v !== '.' && v !== '..') }).strict(), body);
        const valid = await validateUpload(file, p.kind);
        const quota = await storageHealth(this.shop.config.STORAGE_ROOT);
        const purchaseQuota = await storageHealth(this.shop.config.PURCHASE_ROOT);
        if (quota.usedBytes + (path.resolve(this.shop.config.PURCHASE_ROOT).startsWith(path.resolve(this.shop.config.STORAGE_ROOT) + path.sep) ? 0 : purchaseQuota.usedBytes) + valid.buffer.length > this.shop.config.STORAGE_MAX_BYTES || purchaseQuota.freeBytes < valid.buffer.length + 64 * 1024 * 1024)
            throw new BadRequestException('Private storage quota exceeded');
        const storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        const rendered = p.kind === 'original' ? await renderPptxPreviews(valid.buffer) : undefined;
        const previewKeys: string[] = [];
        const previewBytes = rendered?.images.reduce((sum, image) => sum + image.length, 0) || 0;
        if (quota.usedBytes + (storage.purchaseRoot.startsWith(storage.root + path.sep) ? 0 : purchaseQuota.usedBytes) + valid.buffer.length * 2 + previewBytes > this.shop.config.STORAGE_MAX_BYTES || Math.min(quota.freeBytes, purchaseQuota.freeBytes) < valid.buffer.length * 2 + previewBytes + 64 * 1024 * 1024)
            throw new BadRequestException('Private storage quota exceeded');
        let written: string | undefined, currentKey: string | undefined, previous: Buffer | undefined;
        try {
            return await this.shop.db.$transaction(async (tx) => {
                await this.shop.lock(tx, 'storage-capacity');
                await assertStorageCapacity(this.shop, valid.buffer.length * 2 + previewBytes);
                await this.shop.lock(tx, 'product:' + id);
                const product = await tx.product.findUniqueOrThrow({ where: { id }, include: { category: true } });
                if (product.deletedAt)
                    throw new BadRequestException('Deleted product');
                if (p.kind === 'original') {
                    if (await tx.fileVersion.count({ where: { productId: id, version: p.version } }))
                        throw new ConflictException({ code: 'CONFLICT', message: 'Use a new version number' });
                    const fileId = crypto.randomUUID();
                    const f = await storage.putHistory(valid.buffer, fileId, product.titleZh);
                    written = f.key;
                    for (const image of rendered!.images) previewKeys.push((await storage.put(image, 'png')).key);
                    const result = await tx.fileVersion.create({ data: { id: fileId, productId: id, version: p.version, ...f, previews: previewKeys } });
                    await tx.product.update({ where: { id }, data: { metadata: { ...(product.metadata as Record<string, unknown>), slides: rendered!.slideCount } } });
                    currentKey = storage.currentKey(product.category.nameZh, product.titleZh);
                    try { previous = await fs.readFile(storage.resolve(currentKey)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
                    await syncCurrent(tx, storage, product, result);
                    await this.shop.audit(tx, req.admin.adminId, 'FILE_VERSION_CREATE', result.id, { version: p.version, size: f.size, sha256: f.sha256 }, req.requestId);
                    return { id: result.id, filename: f.filename, previews: previewKeys, previewCount: previewKeys.length };
                }
                const v = await tx.fileVersion.findUniqueOrThrow({ where: { productId_version: { productId: id, version: p.version } } });
                const f = await storage.put(valid.buffer, valid.extension);
                written = f.key;
                await tx.fileVersion.update({ where: { id: v.id }, data: { previews: [...(v.previews as string[]), f.key] } });
                await this.shop.audit(tx, req.admin.adminId, 'PREVIEW_UPLOAD', v.id, { size: f.size }, req.requestId);
                return { uploaded: true };
            }, { timeout: 120000 });
        }
        catch (error) {
            if (currentKey) {
                if (previous) await storage.replace(currentKey, previous);
                else await fs.unlink(storage.resolve(currentKey)).catch(() => { });
            }
            if (written)
                await fs.unlink(storage.resolve(written)).catch(() => { });
            await Promise.all(previewKeys.map(key => fs.unlink(storage.resolve(key)).catch(() => { })));
            throw error;
        }
    }
    @Get('order-products')
    orderProducts() { return this.shop.db.product.findMany({ select: { id: true, titleZh: true, titleEn: true, translations: true, status: true }, orderBy: { sort: 'asc' } }); }
    @Get('orders')
    async orders(
    @Req()
    req: Context, 
    @Query()
    query: unknown) {
        const p = parse(z.object({ page: z.coerce.number().int().min(1).default(1), search: z.string().max(120).optional(), status: z.enum(['AWAITING_PAYMENT', 'PAID', 'CLOSED']).optional(), currency: currency.optional(), provider: z.enum(['mock', 'alipay', 'wechat', 'paypal']).optional(), productId: z.uuid().optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }).strict(), query);
        if (p.from && p.to && new Date(p.from).getTime() > new Date(p.to).getTime())
            throw new BadRequestException('Start time must not exceed end time');
        const where: any = { ...(p.status ? { status: p.status } : {}), ...(p.currency ? { currency: p.currency } : {}), ...(p.provider ? { payments: { some: { provider: p.provider } } } : {}), ...(p.productId ? { item: { fileVersion: { productId: p.productId } } } : {}), ...(p.from || p.to ? { createdAt: { ...(p.from ? { gte: new Date(p.from) } : {}), ...(p.to ? { lte: new Date(p.to) } : {}) } } : {}), ...(p.search ? { OR: [{ number: { contains: p.search, mode: 'insensitive' } }, { email: { contains: p.search, mode: 'insensitive' } }] } : {}) };
        const [rows, total] = await Promise.all([
            this.shop.db.order.findMany({ where, skip: (p.page - 1) * 25, take: 25, include: { payments: true, refunds: true, item: { include: { fileVersion: true, entitlement: { include: { logs: true } } } }, tickets: true }, orderBy: { createdAt: 'desc' } }),
            this.shop.db.order.count({ where }),
        ]);
        const jobs = await this.shop.db.job.findMany({ where: { kind: 'MAIL', relatedId: { in: rows.map(o => o.id) } }, select: { id: true, relatedId: true, status: true, attempts: true, error: true, runAt: true } });
        const messages = await this.shop.db.mailMessage.findMany({ where: { jobId: { in: jobs.map(j => j.id) } }, select: { id: true, jobId: true, status: true, subject: true, createdAt: true } });
        return { rows: rows.map(o => {
                const deliveryJobs = jobs.filter(j => j.relatedId === o.id);
                const jobIds = new Set(deliveryJobs.map(j => j.id));
                return { ...this.shop.publicOrder(o), email: req.admin.admin.role === 'SUPPORT' ? o.email.replace(/^(.).*(@.*)$/, '$1***$2') : o.email,
                    paymentAttempts: o.payments.map(payment => ({ id: payment.id, provider: payment.provider, status: payment.status, channelOrderId: payment.channelOrderId, transactionId: payment.transactionId, amount: payment.amount, currency: payment.currency, createdAt: payment.createdAt })),
                    downloadLogs: o.item?.entitlement?.logs, deliveryJobs, mailRecords: messages.filter(m => jobIds.has(m.jobId)) };
            }), total, page: p.page };
    }
    @Get('refunds')
    refunds() { return this.shop.db.refund.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { order: { select: { number: true } }, payment: { select: { provider: true, currency: true, amount: true } } } }); }
    @Post('refunds/:id/review')
    review(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { this.auth.reauth(req); const p = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(2000).default(''), scenario: z.enum(['success', 'failure', 'pending', 'timeout']).default('success') }).strict(), body); return this.shop.approveRefund(id, req.admin.adminId, req.requestId, p.decision, p.reason, p.scenario); }
    @Post('orders/:id/resend')
    async resend(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { await this.auth.rate(req, 'admin-resend', 20); const o = await this.shop.db.order.findUniqueOrThrow({ where: { id } }); if (o.status !== 'PAID')
        throw new BadRequestException('Paid order required'); await this.shop.db.$transaction(async (tx) => { await this.shop.job(tx, 'MAIL', id, `admin-resend:${id}:${Math.floor(Date.now() / 60000)}`, { template: 'delivery' }); await this.shop.audit(tx, req.admin.adminId, 'MAIL_RESEND', id, {}, req.requestId); }); return { queued: true }; }
    @Get('support')
    support(
    @Req()
    req: Context, 
    @Query()
    query: unknown) { const p = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).optional(), source: z.enum(['CUSTOMER', 'MEMO']).optional() }).strict(), query); return this.shop.db.supportTicket.findMany({ where: { ...p, ...(req.admin.admin.role === 'SUPPORT' ? { source: 'CUSTOMER' } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { order: { select: { number: true } } } }); }
    @Post('support')
    async memo(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = parse(z.object({ title: text.max(120), content: text, status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).default('OPEN') }).strict(), body); return this.shop.db.$transaction(async (tx) => { const ticket = await tx.supportTicket.create({ data: { ...p, source: 'MEMO', handlerId: req.admin.adminId } }); await this.shop.audit(tx, req.admin.adminId, 'MEMO_CREATE', ticket.id, { status: ticket.status }, req.requestId); return ticket; }); }
    @Patch('support/:id')
    async reply(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) { const p = parse(z.object({ reply: z.string().trim().max(2000).optional(), status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']), title: z.string().trim().max(120).optional(), content: text.optional() }).strict(), body); return this.shop.db.$transaction(async (tx) => { const existing = await tx.supportTicket.findUniqueOrThrow({ where: { id } }); if (existing.source === 'MEMO')
        this.auth.requireAdmin(req, 'ADMIN');
 const t = await tx.supportTicket.update({ where: { id }, data: { ...p, handlerId: req.admin.adminId } }); await this.shop.audit(tx, req.admin.adminId, 'SUPPORT_REPLY', id, { status: p.status }, req.requestId); return t; }); }
    @Post('jobs/run-all')
    async runAll(@Req() req: Context) {
        return this.shop.db.$transaction(async tx => {
            const result = await tx.job.updateMany({ where: { status: { in: ['FAILED', 'PENDING'] } }, data: { status: 'PENDING', attempts: 0, runAt: new Date(), leaseUntil: null, error: null } });
            await this.shop.audit(tx, req.admin.adminId, 'JOBS_RUN_ALL', 'jobs', { count: result.count }, req.requestId);
            return { queued: result.count };
        });
    }
    @Post('maintenance/clear-business')
    async clearBusiness(@Req() req: Context, @Body() body: unknown) {
        const p = parse(z.object({ email, password: z.string().min(1).max(200), code: z.string().min(6).max(100) }).strict(), body);
        await this.auth.verifyDestructive(req, p.email, p.password, p.code);
        return clearBusinessData(this.shop, req.admin.adminId, req.requestId);
    }
    @Post('maintenance/cleanup')
    async cleanup(@Req() req: Context, @Body() body: unknown) {
        const p = parse(z.object({ email, password: z.string().min(1).max(200), code: z.string().min(6).max(100) }).strict(), body);
        await this.auth.verifyDestructive(req, p.email, p.password, p.code);
        const result = await cleanRuntimeFiles(this.shop);
        await this.shop.audit(this.shop.db, req.admin.adminId, 'RUNTIME_CLEANUP', 'runtime', result, req.requestId);
        return result;
    }
    @Post('products/:id/purge')
    async purge(@Req() req: Context, @Param('id') id: string) {
        this.auth.reauth(req);
        const storage = new LocalStorage(this.shop.config.STORAGE_ROOT, this.shop.config.PURCHASE_ROOT);
        const keys = await this.shop.db.$transaction(async tx => {
            await this.shop.lock(tx, 'product:' + id);
            const product = await tx.product.findUniqueOrThrow({ where: { id }, include: { category: true, versions: true } });
            if (!product.deletedAt) throw new BadRequestException('Only deleted products can be permanently deleted');
            if (await tx.orderItem.count({ where: { fileVersion: { productId: id } } })) throw new BadRequestException({ code: 'PRODUCT_HAS_ORDERS', message: 'This product has orders and must be retained for customer downloads' });
            const keys = product.versions.flatMap(v => [v.key, ...(v.previews as string[])]);
            if (!await tx.product.count({ where: { id: { not: id }, categoryId: product.categoryId, titleZh: product.titleZh } })) keys.push(storage.currentKey(product.category.nameZh, product.titleZh));
            const others = await tx.fileVersion.findMany({ where: { productId: { not: id } }, select: { key: true, previews: true } });
            const retained = new Set(others.flatMap(v => [v.key, ...(v.previews as string[])]));
            await tx.price.deleteMany({ where: { productId: id } });
            await tx.fileVersion.deleteMany({ where: { productId: id } });
            await tx.product.delete({ where: { id } });
            await this.shop.audit(tx, req.admin.adminId, 'PRODUCT_PURGE', id, {}, req.requestId);
            return [...new Set(keys)].filter(key => !retained.has(key));
        });
        let removedFiles = 0, failedFiles = 0;
        for (const key of keys) { try { await fs.unlink(storage.resolve(key)); removedFiles++; } catch (e: any) { if (e.code !== 'ENOENT') failedFiles++; } }
        return { deleted: true, removedFiles, failedFiles };
    }
    @Get('jobs')
    jobs() { return this.shop.db.job.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, kind: true, relatedId: true, status: true, attempts: true, error: true, runAt: true } }); }
    @Post('jobs/:id/retry')
    async retry(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { const j = await this.shop.db.job.findUniqueOrThrow({ where: { id } }); if (!['FAILED', 'PENDING'].includes(j.status))
        throw new BadRequestException('Job cannot be retried'); await this.shop.db.$transaction(async (tx) => { await tx.job.update({ where: { id }, data: { status: 'PENDING', attempts: 0, runAt: new Date(), leaseUntil: null } }); await this.shop.audit(tx, req.admin.adminId, 'JOB_RETRY', id, {}, req.requestId); }); return { queued: true }; }
    @Get('events')
    events() { return this.shop.db.paymentEvent.findMany({ select: { id: true, eventKey: true, paymentId: true, status: true, error: true, receivedAt: true, payment: { select: { provider: true, status: true, amount: true, currency: true, order: { select: { id: true, number: true } } } } }, orderBy: { receivedAt: 'desc' }, take: 100 }); }
    @Get('audit')
    audit(
    @Req()
    req: Context) { this.auth.requireAdmin(req, 'ADMIN'); return this.shop.db.audit.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }); }
    @Get('settings')
    async settings(
    @Req()
    req: Context) { this.auth.requireAdmin(req, 'ADMIN'); const downloadRules = (await this.shop.db.setting.findUnique({ where: { key: 'downloadRules' } }))?.value || { tokenSeconds: 120, bytesPerSecond: 2097152 }; const mode = (await this.shop.db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any; return { storeMode: mode?.mode || (this.shop.config.PAYMENT_MODE === 'mock' ? 'test' : 'normal'), canUseTest: this.shop.config.APP_ENV !== 'production' && this.shop.config.PAYMENT_MODE === 'mock', mail: { transport: this.shop.config.MAIL_TRANSPORT, purchaseRecipient: this.shop.config.OWNER_PURCHASE_EMAIL, refundRecipient: this.shop.config.OWNER_REFUND_EMAIL }, brand: (await this.shop.db.setting.findUnique({ where: { key: 'brand' } }))?.value, downloadRules, downloadRule: 'Authorized streaming, token expires after 120 seconds', channels: Object.entries(this.shop.adapters).map(([provider, a]) => ({ provider, ...a.getCapabilities(), enabled: provider === 'mock' && this.shop.config.PAYMENT_MODE === 'mock', configured: provider === 'mock' && this.shop.config.PAYMENT_MODE === 'mock' })) }; }
    @Patch('settings')
    async saveSettings(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = parse(z.object({ nameZh: text.max(80), nameEn: text.max(80), contact: text.max(250), footer: text.max(500), translations: z.partialRecord(z.enum(LANGUAGES), z.object({ name: text.max(80), footer: text.max(500) }).strict()).optional(), tokenSeconds: z.number().int().min(30).max(86400), bytesPerSecond: z.number().int().min(65536).max(10485760), storeMode: z.enum(['test', 'normal']).optional() }).strict(), body); const { tokenSeconds, bytesPerSecond, storeMode, ...brand } = p; if (storeMode === 'test' && (this.shop.config.APP_ENV === 'production' || this.shop.config.PAYMENT_MODE !== 'mock'))
        throw new BadRequestException({ code: 'MOCK_MODE_FORBIDDEN', message: 'Simulated payment mode not allowed' }); const previous = (await this.shop.db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any; if (storeMode && storeMode !== (previous?.mode || (this.shop.config.PAYMENT_MODE === 'mock' ? 'test' : 'normal')))
        this.auth.reauth(req); await this.shop.db.$transaction(async (tx) => { if (storeMode)
        await tx.setting.upsert({ where: { key: 'storeMode' }, create: { key: 'storeMode', value: { mode: storeMode } }, update: { value: { mode: storeMode } } }); await tx.setting.upsert({ where: { key: 'brand' }, create: { key: 'brand', value: brand }, update: { value: brand } }); await tx.setting.upsert({ where: { key: 'downloadRules' }, create: { key: 'downloadRules', value: { tokenSeconds, bytesPerSecond } }, update: { value: { tokenSeconds, bytesPerSecond } } }); if (storeMode)
        await this.shop.audit(tx, req.admin.adminId, 'STORE_MODE_CHANGE', 'storeMode', { mode: storeMode }, req.requestId); await this.shop.audit(tx, req.admin.adminId, 'BRAND_UPDATE', 'brand', {}, req.requestId); }); return { saved: true }; }
    @Post('orders/export')
    async export(
    @Req()
    req: Context, 
    @Res()
    res: Response) { this.auth.reauth(req); const rows = await this.shop.db.order.findMany({ take: 10000, orderBy: { createdAt: 'desc' } }); await this.shop.audit(this.shop.db, req.admin.adminId, 'CUSTOMER_EXPORT', 'orders', { count: rows.length }, req.requestId); res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="orders.csv"'); const context = await adminCustomerContext(this.shop.db, rows.map(o => o.id), []); const rates = rows.some(o => o.currency !== 'CNY') ? (await new FxService(this.shop.db).latest()).rates as any : {}; res.send('\uFEFF' + [['number', 'email', 'currency', 'amount_minor', 'status', 'is_test', 'name', 'nickname', 'country', 'total_purchases'], ...rows.map(o => { const amount = cnyMinor(o.amount, o.currency, rates[o.currency]?.rate, DIGITS[o.currency]); if (amount === null) throw new BadRequestException({ code: 'FX_UNAVAILABLE' }); const customer = context.byId[o.id]; return [o.number, o.email, 'CNY', amount, o.status, o.isTest, customer?.name || '', customer?.nickname || '', customer?.country || o.country, customer?.purchaseCount ?? 0]; })].map(row => row.map(csvCell).join(',')).join('\r\n')); }
    @Get('mail')
    inbox(
    @Req()
    req: Context) { this.auth.requireAdmin(req, 'ADMIN'); return this.shop.db.mailMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }); }
}
