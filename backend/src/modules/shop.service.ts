import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LANGUAGES, DIGITS } from '../commerce/constants';
import { DB } from '../db';
import { Config } from '../config';
import { hash, token, canonical, mac, same } from '../security';
import { registry, PaymentEvent } from '../payments/adapters';
import { purchaseFilename } from '../storage/local';
import { ContentTranslation } from '../commerce/content';
export class ShopService {
    readonly adapters;
    failNextEvent = false;
    constructor(readonly db: DB, readonly config: Config) { this.adapters = registry(db, config.MOCK_SIGNING_KEY || 'disabled'); }
    async lock(tx: any, key: string) { await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${key}))`; }
    async job(tx: any, kind: string, relatedId: string, idempotencyKey: string, payload: any = {}) { return tx.job.upsert({ where: { idempotencyKey }, create: { kind, relatedId, idempotencyKey, payload }, update: {} }); }
    async audit(tx: any, actorId: string, action: string, objectId: string, summary: any, requestId: string) { await tx.audit.create({ data: { actorId, action, objectId, summary, requestId } }); }
    async canCheckout() { const mode = (await this.db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any; return this.config.PAYMENT_MODE === 'mock' && this.config.APP_ENV !== 'production' && mode?.mode !== 'normal'; }
    async products(query: {
        search?: string;
        category?: string;
        currency?: string;
        priceSort?: 'default' | 'asc' | 'desc';
        minPrice?: string;
        maxPrice?: string;
    }) {
        const currency = query.currency || 'CNY';
        const minor = (value: string | undefined) => { if (value === undefined)
            return undefined; const [whole, fraction = ''] = value.split('.'), digits = DIGITS[currency]; if (fraction.length > digits)
            throw new BadRequestException({ code: 'INVALID_PRICE_RANGE', message: 'Invalid price precision' }); const amount = Number(BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0')); if (amount > 100000000)
            throw new BadRequestException({ code: 'INVALID_PRICE_RANGE', message: 'Price out of range' }); return amount; };
        const min = minor(query.minPrice), max = minor(query.maxPrice);
        if (min !== undefined && max !== undefined && min > max)
            throw new BadRequestException({ code: 'INVALID_PRICE_RANGE', message: 'Minimum price exceeds maximum' });
        const rows = await this.db.product.findMany({ where: { ...(min !== undefined || max !== undefined ? { prices: { some: { currency, active: true, amount: { ...(min !== undefined ? { gte: min } : {}), ...(max !== undefined ? { lte: max } : {}) } } } } : {}), status: 'PUBLISHED', deletedAt: null, category: { archived: false }, ...(this.config.PAYMENT_MODE === 'mock' ? { isDemo: true } : {}), ...(query.category ? { categoryId: query.category } : {}), ...(query.search ? { OR: [{ titleZh: { contains: query.search, mode: 'insensitive' } }, { titleEn: { contains: query.search, mode: 'insensitive' } }, ...LANGUAGES.map(language => ({ translations: { path: [language, 'title'], string_contains: query.search, mode: 'insensitive' as const } }))] } : {}) }, include: { prices: true, category: true, versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, version: true, previews: true } } }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
        if (query.priceSort && query.priceSort !== 'default') {
            const cost = (p: any) => p.prices.find((v: any) => v.currency === currency && v.active)?.amount ?? Number.MAX_SAFE_INTEGER;
            rows.sort((a, b) => (query.priceSort === 'asc' ? cost(a) - cost(b) : cost(b) - cost(a)) || a.id.localeCompare(b.id));
        }
        return rows;
    }
    async product(slug: string) { const p = await this.db.product.findUnique({ where: { slug }, include: { prices: true, category: true, versions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, version: true, previews: true, format: true, filename: true, licenseVersion: true } } } }); if (!p || p.category.archived || p.deletedAt || p.status !== 'PUBLISHED' || (this.config.PAYMENT_MODE === 'mock' && !p.isDemo))
        throw new NotFoundException('Product unavailable'); return { ...p, downloadNames: Object.fromEntries(LANGUAGES.map(language => [language, purchaseFilename({ language, item: { snapshot: p } })])) }; }
    async quote(productId: string, currency: string) { const p = await this.db.product.findUnique({ where: { id: productId }, include: { category: true, prices: { where: { currency, active: true } }, versions: { orderBy: { createdAt: 'desc' }, take: 1 } } }); if (!p || p.category.archived || p.deletedAt || p.status !== 'PUBLISHED' || !p.prices.length || !p.versions.length || !p.isDemo && this.config.PAYMENT_MODE === 'mock')
        throw new BadRequestException('Product unavailable'); const pricingSetting = (await this.db.setting.findUnique({ where: { key: 'pricing:' + p.id } }))?.value as any; const fx = pricingSetting?.snapshotId ? await this.db.fxSnapshot.findUnique({ where: { id: pricingSetting.snapshotId } }) : null; const rate = (fx?.rates as any)?.[currency]; const pricing = fx && rate ? { base: 'CNY', baseAmount: pricingSetting.baseAmount, source: fx.source, rate: rate.rate, asOf: rate.date, fxId: fx.id } : { mode: 'legacy' }; const result = { pricing, productId, currency, amount: p.prices[0].amount, fileVersionId: p.versions[0].id, termsVersion: 'demo-v1', expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), checkoutEnabled: await this.canCheckout() }; const encoded = Buffer.from(canonical(result)).toString('base64url'); return { ...result, quoteToken: `${encoded}.${mac(this.config.SESSION_SECRET, 'quote:' + encoded)}` }; }
    verifyQuote(raw: string) { const [encoded, signature, ...extra] = raw.split('.'); if (extra.length || !signature || !same(mac(this.config.SESSION_SECRET, 'quote:' + encoded), signature))
        throw new BadRequestException('Invalid quote'); try {
        const q = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (new Date(q.expiresAt) <= new Date())
            throw new Error();
        return q;
    }
    catch {
        throw new BadRequestException('Quote expired; refresh product');
    } }
    async createOrder(sessionId: string, input: {
        productId: string;
        currency: string;
        email: string;
        language: string;
        idempotencyKey: string;
        termsVersion: string;
        quoteToken: string;
        source?: string;
    }) {
        if (!await this.canCheckout())
            throw new ForbiddenException({ code: 'PURCHASE_DISABLED', message: 'Purchases are not enabled' });
        const buyer = await this.db.session.findUnique({ where: { id: sessionId }, include: { customer: true } });
        if (!buyer?.customer || buyer.revokedAt || buyer.expiresAt <= new Date() || buyer.customer.disabled)
            throw new ForbiddenException({ code: 'REGISTRATION_REQUIRED', message: 'Registered account required' });
        if (!buyer.customer.emailVerifiedAt)
            throw new ForbiddenException({ code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Email verification required' });
        if (input.email.toLowerCase() !== buyer.customer.email)
            throw new BadRequestException('Order email must match account');
        const customer = buyer.customer;
        const requestHash = hash(JSON.stringify(input));
        // Translate a missing purchase title before entering the transaction.
        const source = await this.db.product.findUnique({ where: { id: input.productId }, select: { titleZh: true, titleEn: true, translations: true } });
        const translatedTitle = source ? await new ContentTranslation(this).purchaseTitle(source, input.language) : undefined;
        return this.db.$transaction(async (tx) => {
            await this.lock(tx, `create:${sessionId}:${input.idempotencyKey}`);
            const old = await tx.order.findUnique({ where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: input.idempotencyKey } }, include: { payments: true } });
            if (old) {
                if (old.requestHash !== requestHash)
                    throw new BadRequestException('Idempotency key reused with different input');
                return { id: old.id, number: old.number };
            }
            await this.lock(tx, `product:${input.productId}`);
            const p = await tx.product.findUnique({ where: { id: input.productId }, include: { category: true, prices: { where: { currency: input.currency, active: true } }, versions: { orderBy: { createdAt: 'desc' }, take: 1 } } });
            if (!p || p.category.archived || p.deletedAt || p.status !== 'PUBLISHED' || !p.isDemo || !p.prices.length || !p.versions.length || input.termsVersion !== 'demo-v1')
                throw new BadRequestException('Quote unavailable; refresh product');
            const v = p.versions[0];
            const translations = { ...(p.translations as any) };
            if (translatedTitle && p.titleZh === source?.titleZh && !translations[input.language]?.title)
                translations[input.language] = { ...translations[input.language], title: translatedTitle };
            const amount = p.prices[0].amount;
            const quote = this.verifyQuote(input.quoteToken);
            if (quote.productId !== p.id || quote.currency !== input.currency || quote.amount !== amount || quote.fileVersionId !== v.id || quote.termsVersion !== input.termsVersion)
                throw new BadRequestException({ code: 'QUOTE_STALE', message: 'Quote changed; refresh and confirm the updated price' });
            const o = await tx.order.create({ data: { number: `TW-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`, sessionId, customerId: buyer.customerId, country: customer.country, pricingSnapshot: quote.pricing || {}, email: customer.email, language: input.language, currency: input.currency, amount, isTest: true, idempotencyKey: input.idempotencyKey, requestHash, source: input.source?.replace(/[^\w .-]/g, '').slice(0, 80), termsVersion: input.termsVersion, expiresAt: new Date(Date.now() + 30 * 60000), item: { create: { fileVersionId: v.id, snapshot: { titleZh: p.titleZh, titleEn: p.titleEn, translations, amount, currency: input.currency, version: v.version, license: v.licenseVersion, metadata: p.metadata } } }, payments: { create: { provider: 'mock', merchant: 'mock-test-v1', amount, currency: input.currency, channelOrderId: `mock_order_${randomUUID()}`, idempotencyKey: 'initial' } } }, include: { payments: true } });
            await tx.mockPayment.create({ data: { paymentId: o.payments[0].id, transactionId: `mock_tx_${randomUUID()}` } });
            return { id: o.id, number: o.number };
        });
    }
    async authorizeOrder(id: string, session: any) { const o = await this.db.order.findUnique({ where: { id }, include: { item: { include: { fileVersion: true, entitlement: true } }, payments: { orderBy: { createdAt: 'asc' } }, refunds: { orderBy: { createdAt: 'desc' } }, tickets: true } }); if (!o || (o.sessionId !== session.id && !(session.customerId && session.customerId === o.customerId) && !(session.verifiedEmail && session.verifiedEmail === o.email)))
        throw new NotFoundException('Order not found'); return o; }
    publicOrder(o: any) { return { id: o.id, number: o.number, email: o.email, country: o.country, customerId: o.customerId, pricingSnapshot: o.pricingSnapshot, language: o.language, currency: o.currency, amount: o.amount, status: o.status, deliveryStatus: o.deliveryStatus, isTest: o.isTest, createdAt: o.createdAt, item: { snapshot: o.item?.snapshot, version: o.item?.fileVersion.version, filename: purchaseFilename(o) }, entitlement: o.item?.entitlement?.status, refunds: o.refunds.map((r: any) => ({ id: r.id, status: r.status, reason: r.reason, reviewReason: r.reviewReason, amount: r.amount })), payments: o.payments.map((p: any) => ({ id: p.id, provider: p.provider, status: p.status })), tickets: o.tickets }; }
    async mockScenario(o: any, scenario: string) { const p = o.payments.at(-1); if (p.provider !== 'mock')
        throw new BadRequestException('Not simulated'); const event = await this.adapters.mock.confirmPayment({ paymentId: p.id, scenario }); if (event) {
        await this.signedEvent(event);
        if (scenario === 'duplicate')
            await Promise.all([this.signedEvent(event), this.signedEvent(event)]);
        if (scenario === 'different')
            await this.signedEvent({ ...event, eventId: randomUUID() });
    } return { accepted: true }; }
    async signedEvent(event: PaymentEvent) { const body = Buffer.from(JSON.stringify(event)); return this.receive(body, this.adapters.mock.sign(body, event.eventId)); }
    async receive(raw: Buffer, headers: Record<string, any>) {
        const event = this.adapters.mock.verifyAndParseNotification(raw, headers);
        const eventKey = `mock:${event.eventId}`;
        await this.db.paymentEvent.createMany({ data: [{ eventKey, provider: 'mock', payload: event }], skipDuplicates: true });
        try {
            return await this.db.$transaction(async (tx) => {
                await this.lock(tx, `order:${event.orderId}`);
                await this.lock(tx, `event:${eventKey}`);
                const record = await tx.paymentEvent.findUniqueOrThrow({ where: { eventKey } });
                if (hash(canonical(record.payload)) !== hash(canonical(event)))
                    throw new BadRequestException('Event identity reused');
                if (record.status === 'PROCESSED')
                    return { acknowledged: true, duplicate: true };
                if (this.failNextEvent) {
                    this.failNextEvent = false;
                    throw new Error('TEST_TRANSACTION_FAILURE');
                }
                const p = await tx.payment.findUnique({ where: { id: event.paymentId }, include: { order: { include: { item: true } }, channel: true } });
                if (!p || p.orderId !== event.orderId || p.channelOrderId !== event.channelOrderId || p.merchant !== event.merchant || p.amount !== event.amount || p.currency !== event.currency || p.provider !== 'mock' || p.channel?.transactionId !== event.transactionId)
                    throw new BadRequestException('PAYMENT_MISMATCH');
                await tx.paymentEvent.update({ where: { eventKey }, data: { paymentId: p.id } });
                if (event.status === 'SUCCEEDED') {
                    await tx.payment.update({ where: { id: p.id }, data: { status: 'SUCCEEDED', transactionId: event.transactionId } });
                    let order = p.order;
                    if (order.status === 'AWAITING_PAYMENT' && order.expiresAt <= new Date())
                        order = await tx.order.update({ where: { id: order.id }, data: { status: 'CLOSED' } }) as any;
                    if (order.status === 'CLOSED' || order.paidPaymentId && order.paidPaymentId !== p.id) {
                        const r = await tx.refund.upsert({ where: { idempotencyKey: `auto:${p.id}` }, create: { orderId: order.id, paymentId: p.id, amount: p.amount, currency: p.currency, reason: order.status === 'CLOSED' ? 'late payment' : 'duplicate payment', status: 'APPROVED', idempotencyKey: `auto:${p.id}` }, update: {} });
                        await this.job(tx, 'REFUND', r.id, `refund:${r.id}`);
                    }
                    else if (!order.paidPaymentId) {
                        await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', deliveryStatus: 'READY', paidPaymentId: p.id } });
                        await tx.entitlement.upsert({ where: { orderItemId: p.order.item!.id }, create: { orderItemId: p.order.item!.id, fileVersionId: p.order.item!.fileVersionId }, update: {} });
                        await this.job(tx, 'MAIL', order.id, `delivery:${order.id}`, { template: 'delivery' });
                        await this.job(tx, 'OWNER_MAIL', order.id, `owner-purchase:${order.id}`, { template: 'purchase-owner' });
                    }
                }
                else if (p.status !== 'SUCCEEDED' && p.status !== 'REVERSED') {
                    await tx.payment.update({ where: { id: p.id }, data: { status: event.status === 'CANCELLED' ? 'FAILED' : event.status } });
                }
                await tx.paymentEvent.update({ where: { eventKey }, data: { status: 'PROCESSED', error: null, processedAt: new Date() } });
                return { acknowledged: true };
            }, { timeout: 15000 });
        }
        catch (e) {
            await this.db.paymentEvent.updateMany({ where: { eventKey, status: { not: 'PROCESSED' } }, data: { status: 'FAILED', error: e instanceof BadRequestException ? 'PAYMENT_MISMATCH' : 'PROCESSING_FAILED' } });
            throw e;
        }
    }
    async reconcilePayment(paymentId: string) { const event = await this.adapters.mock.queryPayment({ paymentId }); return this.signedEvent(event); }
    async requestRefund(o: any, reason: string) { if (!o.paidPaymentId || reason.trim().length < 5)
        throw new BadRequestException('Paid order and refund reason required'); return this.db.$transaction(async (tx) => { await this.lock(tx, `order:${o.id}`); const r = await tx.refund.upsert({ where: { idempotencyKey: `buyer:${o.paidPaymentId}` }, create: { orderId: o.id, paymentId: o.paidPaymentId, amount: o.amount, currency: o.currency, reason: reason.trim(), idempotencyKey: `buyer:${o.paidPaymentId}` }, update: {} }); await this.job(tx, 'MAIL', o.id, `refund-request:${r.id}`, { template: 'refund-request' }); await this.job(tx, 'OWNER_MAIL', o.id, `owner-refund:${r.id}`, { template: 'refund-owner', refundId: r.id }); return { id: r.id, status: r.status }; }); }
    async approveRefund(id: string, actor: string, requestId: string, decision: string, reason: string, scenario: string) {
        return this.db.$transaction(async (tx) => {
            const existing = await tx.refund.findUniqueOrThrow({ where: { id } });
            await this.lock(tx, `order:${existing.orderId}`);
            const r = await tx.refund.findUniqueOrThrow({ where: { id }, include: { payment: true, order: { include: { item: true } } } });
            if (r.status !== 'REQUESTED')
                return { id: r.id, status: r.status };
            if (decision === 'reject') {
                await tx.refund.update({ where: { id }, data: { status: 'REJECTED', reviewerId: actor, reviewReason: reason } });
                await this.audit(tx, actor, 'REFUND_REJECT', id, { reason }, requestId);
                await this.job(tx, 'MAIL', r.orderId, `refund-rejected:${id}`, { template: 'refund-rejected' });
                return { id, status: 'REJECTED' };
            }
            const total = await tx.refund.aggregate({ where: { paymentId: r.paymentId, id: { not: id }, status: { in: ['APPROVED', 'PROCESSING', 'SUCCEEDED'] } }, _sum: { amount: true } });
            if ((total._sum.amount || 0) + r.amount > r.payment.amount || r.currency !== r.payment.currency)
                throw new BadRequestException('Refund exceeds original payment');
            await tx.refund.update({ where: { id }, data: { status: 'APPROVED', reviewerId: actor, reviewReason: reason, scenario } });
            if (r.order.item)
                await tx.entitlement.updateMany({ where: { orderItemId: r.order.item.id, status: 'ACTIVE' }, data: { status: 'SUSPENDED' } });
            await this.job(tx, 'REFUND', id, `refund:${id}`);
            await this.audit(tx, actor, 'REFUND_APPROVE', id, { amount: r.amount, currency: r.currency, reason }, requestId);
            return { id, status: 'APPROVED' };
        });
    }
    async processRefund(id: string) {
        let r = await this.db.refund.findUniqueOrThrow({ where: { id }, include: { payment: true } });
        if (['SUCCEEDED', 'REJECTED'].includes(r.status))
            return;
        const adapter = this.adapters[r.payment.provider as keyof typeof this.adapters];
        if (!adapter)
            throw new Error('Original payment adapter unavailable');
        await this.db.refund.update({ where: { id }, data: { status: 'PROCESSING' } });
        let result;
        try {
            result = r.channelRefundId ? await adapter.queryRefund({ refundId: id }) : await adapter.refund({ refundId: id });
        }
        catch {
            result = await adapter.queryRefund({ refundId: id });
        }
        if (['PENDING', 'UNKNOWN'].includes(result.status))
            throw new Error('REFUND_RESULT_PENDING');
        await this.db.$transaction(async (tx) => {
            await this.lock(tx, `order:${r.orderId}`);
            r = await tx.refund.findUniqueOrThrow({ where: { id }, include: { payment: true } });
            if (r.status === 'SUCCEEDED')
                return;
            const succeeded = result.status === 'SUCCEEDED';
            await tx.refund.update({ where: { id }, data: { status: succeeded ? 'SUCCEEDED' : 'FAILED' } });
            const o = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, include: { item: true } });
            if (o.paidPaymentId === r.paymentId && o.item) {
                await tx.entitlement.updateMany({ where: { orderItemId: o.item.id, status: { not: 'REVOKED' } }, data: { status: succeeded ? 'REVOKED' : 'ACTIVE', revokedAt: succeeded ? new Date() : null } });
                if (succeeded)
                    await tx.downloadToken.updateMany({ where: { entitlement: { orderItemId: o.item.id } }, data: { revokedAt: new Date() } });
            }
            await this.job(tx, 'MAIL', o.id, `refund-result:${id}`, { template: succeeded ? 'refund-success' : 'refund-failure' });
            await this.audit(tx, 'worker', 'REFUND_RESULT', id, { status: result.status }, randomUUID());
        });
    }
    async downloadGrant(o: any, sessionId: string) { if (o.status !== 'PAID' || o.item?.entitlement?.status !== 'ACTIVE')
        throw new ForbiddenException('Download permission unavailable'); const rules = (await this.db.setting.findUnique({ where: { key: 'downloadRules' } }))?.value as any; const seconds = Math.max(30, Math.min(86400, Number(rules?.tokenSeconds) || 120)); const raw = token(); await this.db.downloadToken.create({ data: { tokenHash: hash(raw), sessionId, entitlementId: o.item.entitlement.id, expiresAt: new Date(Date.now() + seconds * 1000) } }); await this.db.downloadLog.create({ data: { entitlementId: o.item.entitlement.id, status: 'AUTHORIZED' } }); return { url: `/api/v1/downloads/${raw}`, expiresIn: seconds }; }
    async recover(email: string) {
        const exists = await this.db.order.findFirst({ where: { email, status: 'PAID' } });
        if (exists) {
            const raw = token();
            const r = await this.db.recoveryToken.create({ data: { email, tokenHash: hash(raw), expiresAt: new Date(Date.now() + 15 * 60000) } });
            // Token is encrypted inside durable mail payload; plaintext never enters logs.
            const { encrypt } = await import('../security');
            await this.job(this.db, 'RECOVERY', r.id, `recovery:${r.id}`, { email, encryptedToken: encrypt(raw, this.config.ADMIN_ENCRYPTION_KEY) });
        }
        return { message: 'If this email has eligible orders, a recovery message has been queued.' };
    }
    async redeem(raw: string, sessionId: string) { return this.db.$transaction(async (tx) => { const r = await tx.recoveryToken.findUnique({ where: { tokenHash: hash(raw) } }); if (!r || r.expiresAt <= new Date() || r.consumedAt)
        throw new BadRequestException('Recovery link expired or already used'); const changed = await tx.recoveryToken.updateMany({ where: { id: r.id, consumedAt: null }, data: { consumedAt: new Date() } }); if (!changed.count)
        throw new BadRequestException('Recovery link already used'); const customer = await tx.customer.findUnique({ where: { email: r.email } }); if (customer?.disabled)
        throw new ForbiddenException('Account disabled'); if (customer && !customer.emailVerifiedAt)
        await tx.customer.update({ where: { id: customer.id }, data: { emailVerifiedAt: new Date() } }); await tx.session.update({ where: { id: sessionId }, data: { verifiedEmail: r.email, customerId: customer?.id } }); return { verified: true }; }); }
}
