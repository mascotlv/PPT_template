import { operationStage, operationAction } from '../storage/operation-progress';
import { Controller, Get, Post, Patch, Delete, Req, Param, Body, Query, BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { Auth, Context } from '../modules/auth';
import { ShopService } from '../modules/shop.service';
import { FxService } from './fx';
import { ContentTranslation } from './content';
import { adminCustomerContext } from './admin-customer-context';
import { CURRENCIES, COUNTRIES, LANGUAGES } from './constants';
import { dictionaries } from './dictionaries';
function read<T>(schema: z.ZodType<T>, body: unknown) { const p = schema.safeParse(body); if (!p.success)
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid management request' }); return p.data; }
@Controller('admin')
export class CommerceAdminController {
    readonly fx: FxService;
    constructor(readonly shop: ShopService, readonly auth: Auth) { this.fx = new FxService(shop.db); }
    @Get('frontend')
    async frontend(@Req() req: Context) { this.auth.requireAdmin(req, 'ADMIN'); return { translations: (await this.shop.db.setting.findUnique({ where: { key: 'storefront-text' } }))?.value || {} }; }
    @Patch('frontend')
    async saveFrontend(@Req() req: Context, @Body() body: unknown) {
        this.auth.reauth(req);
        const p = read(z.object({ language: z.enum(LANGUAGES), values: z.record(z.string(), z.union([z.string().max(20000), z.array(z.string().max(2000)).length(3)])).refine(values => Object.keys(values).every(key => Object.hasOwn(dictionaries.en, key)), 'Unknown text field') }).strict(), body);
        for (const [key, value] of Object.entries(p.values)) if (Array.isArray(value) !== Array.isArray((dictionaries.en as any)[key])) throw new BadRequestException({ code: 'INVALID_INPUT' });
        await this.shop.db.$transaction(async tx => {
            await this.shop.lock(tx, 'storefront-text');
            const existing = (await tx.setting.findUnique({ where: { key: 'storefront-text' } }))?.value as any || {};
            const value = { ...existing, [p.language]: p.values };
            await tx.setting.upsert({ where: { key: 'storefront-text' }, create: { key: 'storefront-text', value }, update: { value } });
            await this.shop.audit(tx, req.admin.adminId, 'STOREFRONT_TEXT_UPDATE', 'storefront', { language: p.language, fields: Object.keys(p.values).length }, req.requestId);
        });
        return { saved: true };
    }
    @Post('customer-context')
    async customerContext(@Req() req: Context, @Body() body: unknown) {
        this.auth.requireAdmin(req);
        const p = read(z.object({ ids: z.array(z.string().max(100)).max(2000), emails: z.array(z.string().max(254)).max(1000) }).strict(), body);
        return adminCustomerContext(this.shop.db, p.ids, p.emails);
    }
    @Get('attention')
    async attention(@Req() req: Context) {
        this.auth.requireAdmin(req);
        const [refunds, feedback] = await Promise.all([
            this.shop.db.refund.count({ where: { status: 'REQUESTED' } }),
            this.shop.db.supportTicket.count({ where: { status: 'OPEN', source: 'CUSTOMER' } }),
        ]);
        return { refunds, feedback };
    }
    @Get('reporting-rates')
    async reportingRates(@Req() req: Context) {
        this.auth.requireAdmin(req);
        const snapshot = await this.fx.latest();
        return { rates: snapshot.rates, asOf: snapshot.fetchedAt, currency: 'CNY' };
    }
    @Get('fx')
    async rates(
    @Req()
    req: Context) { this.auth.requireAdmin(req, 'ADMIN'); const snapshot = await this.fx.latest(); const job = await this.shop.db.job.findFirst({ where: { kind: 'FX_REFRESH' }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true, runAt: true } }); const last = (await this.shop.db.setting.findUnique({ where: { key: 'fxLastRefresh' } }))?.value; return { ...snapshot, currencies: CURRENCIES, automatic: this.shop.config.FX_AUTOMATIC_REFRESH, nextRefresh: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(), lastRefresh: last || null, job }; }
    @Post('fx/refresh')
    async refresh(
    @Req()
    req: Context) { this.auth.requireAdmin(req, 'ADMIN'); await this.auth.rate(req, 'fx-refresh', 3); const snapshot = await this.fx.refreshPrices(); await this.shop.audit(this.shop.db, req.admin.adminId, 'FX_REFRESH', snapshot.id, { source: snapshot.source, products: snapshot.products }, req.requestId); return snapshot; }
    @Post('products/:id/status')
    async status(
    @Req()
    req: Context, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) {
        this.auth.requireAdmin(req, 'ADMIN');
        const p = read(z.object({ status: z.enum(['PUBLISHED', 'DRAFT', 'ARCHIVED']) }).strict(), body);
        operationAction(req, p.status === 'PUBLISHED' ? 'publish' : 'unpublish');
        const product = await this.shop.db.product.findUniqueOrThrow({ where: { id }, include: { category: true } });
        if (product.deletedAt) throw new BadRequestException('Restore deleted product first');
        let prepared: any, preparedCategory: any;
        operationStage(req, 'validate');
        if (p.status === 'PUBLISHED') {
            if (product.category.archived || !await this.shop.db.fileVersion.count({ where: { productId: id } }))
                throw new BadRequestException({ code: 'ORIGINAL_REQUIRED', message: 'Upload original successfully before publishing; category must be active' });
            operationStage(req, 'translate');
            const translator = new ContentTranslation(this.shop);
            prepared = await translator.product(product, product);
            preparedCategory = await translator.category(product.category, product.category);
        }
        operationStage(req, 'commit');
        return this.shop.db.$transaction(async (tx) => {
            await this.shop.lock(tx, 'category:' + product.categoryId);
            await this.shop.lock(tx, 'product:' + id);
            const current = await tx.product.findUniqueOrThrow({ where: { id }, include: { category: true } });
            if (current.updatedAt.getTime() !== product.updatedAt.getTime() || JSON.stringify(current.category) !== JSON.stringify(product.category))
                throw new ConflictException('Product or category changed; reload and retry');
            if (prepared) {
                if (current.deletedAt || current.category.archived || !await tx.fileVersion.count({ where: { productId: id } }))
                    throw new BadRequestException('Active category and original file are required');
                await tx.category.update({ where: { id: current.categoryId }, data: { translations: preparedCategory.data.translations, nameEn: preparedCategory.data.nameEn } });
                await tx.product.update({ where: { id }, data: { translations: prepared.data.translations, titleEn: prepared.data.titleEn, descriptionEn: prepared.data.descriptionEn, status: p.status } });
            } else await tx.product.update({ where: { id }, data: p });
            await this.shop.audit(tx, req.admin.adminId, 'PRODUCT_STATUS', id, p, req.requestId);
            return { saved: true };
        });
    }
    @Post('products/:id/restore')
    async restore(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { this.auth.requireAdmin(req, 'ADMIN'); await this.shop.db.$transaction(async (tx) => { await tx.product.update({ where: { id }, data: { deletedAt: null, status: 'DRAFT' } }); await this.shop.audit(tx, req.admin.adminId, 'PRODUCT_RESTORE', id, {}, req.requestId); }); return { saved: true }; }
    @Delete('categories/:id')
    async category(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { this.auth.requireAdmin(req, 'ADMIN'); await this.shop.db.$transaction(async (tx) => { await tx.category.update({ where: { id }, data: { archived: true } }); await tx.product.updateMany({ where: { categoryId: id, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } }); await this.shop.audit(tx, req.admin.adminId, 'CATEGORY_ARCHIVE', id, {}, req.requestId); }); return { archived: true }; }
    @Post('categories/:id/restore')
    async restoreCategory(
    @Req()
    req: Context, 
    @Param('id')
    id: string) { this.auth.requireAdmin(req, 'ADMIN'); await this.shop.db.$transaction(async (tx) => { await tx.category.update({ where: { id }, data: { archived: false } }); await this.shop.audit(tx, req.admin.adminId, 'CATEGORY_RESTORE', id, {}, req.requestId); }); return { saved: true }; }
    @Get('customers')
    async customers(
    @Req()
    req: Context, 
    @Query()
    query: unknown) { this.auth.requireAdmin(req, 'ADMIN'); const p = read(z.object({ page: z.coerce.number().int().min(1).default(1), search: z.string().max(100).default(''), country: z.enum(COUNTRIES).optional() }).strict(), query); const where = { ...(p.country ? { country: p.country } : {}), ...(p.search ? { OR: [{ email: { contains: p.search, mode: 'insensitive' as const } }, { name: { contains: p.search, mode: 'insensitive' as const } }] } : {}) }; const [rows, total] = await Promise.all([this.shop.db.customer.findMany({ where, skip: (p.page - 1) * 25, take: 25, select: { id: true, email: true, name: true, country: true, language: true, currency: true, emailVerifiedAt: true, disabled: true, createdAt: true, orders: { select: { id: true, number: true, currency: true, amount: true, status: true, isTest: true, country: true, createdAt: true, payments: { select: { status: true, amount: true, currency: true, provider: true, createdAt: true } }, refunds: { select: { status: true, amount: true } } } }, _count: { select: { orders: true } } }, orderBy: { createdAt: 'desc' } }), this.shop.db.customer.count({ where })]); return { rows, total, page: p.page }; }
    @Get('analytics')
    async analytics(
    @Req()
    req: Context, 
    @Query()
    query: unknown) {
        this.auth.requireAdmin(req, 'ADMIN');
        const p = read(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()), month: z.coerce.number().int().min(1).max(12).optional(), environment: z.enum(['test', 'live']).optional(), country: z.enum(COUNTRIES).optional() }).strict(), query);
        const start = new Date(Date.UTC(p.year, p.month ? p.month - 1 : 0, 1)), end = new Date(Date.UTC(p.year, p.month || 12, 1)), storeMode = (await this.shop.db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any, isTest = p.environment ? p.environment === 'test' : storeMode?.mode !== 'normal' && this.shop.config.PAYMENT_MODE === 'mock';
        const where = { createdAt: { gte: start, lt: end }, isTest, ...(p.country ? { country: p.country } : {}) };
        const [events, orders, refunds, customers] = await Promise.all([
            this.shop.db.analyticsEvent.groupBy({ by: ['kind', 'productId', 'country', 'day'], where, _count: true }),
            this.shop.db.order.findMany({ where, select: { id: true, amount: true, currency: true, country: true, paidPaymentId: true, createdAt: true, item: { select: { fileVersion: { select: { productId: true } }, snapshot: true } } } }),
            this.shop.db.refund.findMany({ where: { status: 'SUCCEEDED', updatedAt: { gte: start, lt: end }, order: { isTest, ...(p.country ? { country: p.country } : {}) } }, select: { amount: true, currency: true, updatedAt: true, order: { select: { country: true } } } }),
            this.shop.db.customer.count({ where: { createdAt: { gte: start, lt: end }, ...(p.country ? { country: p.country } : {}) } }),
        ]);
        const money: Record<string, any> = {}, countries: Record<string, any> = {}, products: Record<string, any> = {}, months: Record<string, any> = {};
        const country = (code: string | null) => countries[code || 'UNKNOWN'] ||= ({ country: code || 'UNKNOWN', views: 0, clicks: 0, orders: 0, purchases: 0, refunds: 0 });
        const month = (date: string) => months[date.slice(0, 7)] ||= ({ month: date.slice(0, 7), views: 0, clicks: 0, orders: 0, purchases: 0, refunds: 0 });
        const product = (id: string) => products[id] ||= ({ id, title: '', views: 0, clicks: 0, orders: 0, purchases: 0 });
        for (const event of events) {
            const count = event._count;
            const field = event.kind === 'PRODUCT_CLICK' ? 'clicks' : 'views';
            country(event.country)[field] += count;
            month(event.day)[field] += count;
            if (event.productId)
                product(event.productId)[field] += count;
        }
        for (const o of orders) {
            const c = country(o.country), m = month(o.createdAt.toISOString());
            c.orders++;
            m.orders++;
            const productId = o.item?.fileVersion.productId;
            const entry = productId ? product(productId) : null;
            if (entry) {
                entry.orders++;
                entry.title = (o.item?.snapshot as any)?.titleZh || '';
            }
            if (o.paidPaymentId) {
                c.purchases++;
                m.purchases++;
                if (entry)
                    entry.purchases++;
                const total = money[o.currency] ||= ({ currency: o.currency, purchases: 0, grossMinor: 0, refundMinor: 0 });
                total.purchases++;
                total.grossMinor += o.amount;
            }
        }
        for (const r of refunds) {
            country(r.order.country).refunds++;
            month(r.updatedAt.toISOString()).refunds++;
            (money[r.currency] ||= ({ currency: r.currency, purchases: 0, grossMinor: 0, refundMinor: 0 })).refundMinor += r.amount;
        }
        const names = await this.shop.db.product.findMany({ where: { id: { in: Object.keys(products) } }, select: { id: true, titleZh: true, titleEn: true, translations: true } });
        for (const p of names)
            Object.assign(products[p.id], { titleZh: p.titleZh, titleEn: p.titleEn, translations: p.translations });
        return { period: { year: p.year, month: p.month || null, start, end, isTest }, summary: { customers, orders: orders.length, purchases: orders.filter(o => o.paidPaymentId).length, refunds: refunds.length, views: events.filter(e => e.kind !== 'PRODUCT_CLICK').reduce((n, e) => n + e._count, 0), clicks: events.filter(e => e.kind === 'PRODUCT_CLICK').reduce((n, e) => n + e._count, 0) }, currencies: Object.values(money), countries: Object.values(countries).sort((a, b) => b.purchases - a.purchases), products: Object.values(products).sort((a, b) => b.purchases - a.purchases || b.views - a.views), months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)) };
    }
}
@Controller()
export class AnalyticsController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    @Get('markets')
    markets() { return { languages: LANGUAGES, currencies: CURRENCIES, countries: COUNTRIES }; }
    @Post('analytics/events')
    async event(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { await this.auth.rate(req, 'analytics', 120); const p = read(z.object({ kind: z.enum(['HOME_VIEW', 'CATALOG_VIEW', 'PRODUCT_VIEW', 'PRODUCT_CLICK']), productId: z.uuid().optional(), eventId: z.uuid().optional() }).strict(), body); if (p.kind.startsWith('PRODUCT_') && !p.productId)
        throw new BadRequestException('Product required'); if (p.productId && !await this.shop.db.product.count({ where: { id: p.productId, status: 'PUBLISHED', deletedAt: null } }))
        throw new BadRequestException('Product unavailable'); const s = this.auth.requireGuest(req); const day = new Date().toISOString().slice(0, 10); const dedupKey = p.kind === 'PRODUCT_CLICK' ? `${s.id}:click:${p.eventId || day}` : `${s.id}:${p.kind}:${p.productId || ''}:${day}`; await this.shop.db.analyticsEvent.createMany({ data: [{ sessionId: s.id, customerId: s.customerId, productId: p.productId, country: s.customer?.country || null, kind: p.kind, day, dedupKey, isTest: this.shop.config.PAYMENT_MODE === 'mock' }], skipDuplicates: true }); return { recorded: true }; }
}
