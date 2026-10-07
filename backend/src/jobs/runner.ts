import { ShopService } from '../modules/shop.service';
import { MailTransport } from '../mail/transport';
import { FxService } from '../commerce/fx';
import { translateSavedProduct } from '../commerce/content';
export class JobRunner {
    readonly mail: MailTransport;
    constructor(readonly shop: ShopService) { this.mail = new MailTransport(shop.db, shop.config); }
    async tick() {
        const db = this.shop.db;
        const now = new Date();
        await db.setting.upsert({ where: { key: 'workerPulse' }, create: { key: 'workerPulse', value: { at: now.toISOString() } }, update: { value: { at: now.toISOString() } } });
        await db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 86400000) } } });
        if (this.shop.config.FX_AUTOMATIC_REFRESH) {
            const day = now.toISOString().slice(0, 10), scheduledAt = day + 'T00:00:00.000Z';
            await db.job.upsert({ where: { idempotencyKey: 'fx-daily:' + day }, create: { kind: 'FX_REFRESH', relatedId: day, idempotencyKey: 'fx-daily:' + day, runAt: new Date(scheduledAt), payload: { scheduledAt } }, update: {} });
        }
        const jobs = await db.$queryRaw<any[]> `WITH picked AS (SELECT id FROM "Job" WHERE ((status='PENDING' AND "runAt" <= ${now}) OR (status='RUNNING' AND "leaseUntil" < ${now})) AND attempts < 8 ORDER BY "runAt" LIMIT 8 FOR UPDATE SKIP LOCKED) UPDATE "Job" SET status='RUNNING',"leaseUntil"=${new Date(Date.now() + 30000)},attempts=attempts+1 FROM picked WHERE "Job".id=picked.id RETURNING "Job".*`;
        for (const j of jobs) {
            try {
                if (j.kind === 'CONTENT_TRANSLATION') {
                    await db.job.update({ where: { id: j.id }, data: { leaseUntil: new Date(Date.now() + 300000) } });
                    await translateSavedProduct(this.shop, j.relatedId);
                }
                else if (j.kind === 'REFUND')
                    await this.shop.processRefund(j.relatedId);
                else if (j.kind === 'FX_REFRESH') {
                    const result = await new FxService(db).refreshPrices();
                    await this.shop.audit(db, 'worker', 'FX_REFRESH', result.id, { source: result.source, products: result.products, scheduled: true }, 'job:' + j.id);
                }
                else
                    await this.mail.send(j);
                await db.job.update({ where: { id: j.id }, data: { status: 'DONE', leaseUntil: null, error: null } });
            }
            catch {
                await db.job.update({ where: { id: j.id }, data: { status: j.attempts >= 8 ? 'FAILED' : 'PENDING', runAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** j.attempts)), leaseUntil: null, error: j.kind === 'CONTENT_TRANSLATION' ? 'TRANSLATION_UNAVAILABLE' : j.kind === 'REFUND' ? 'REFUND_PENDING_OR_FAILED' : j.kind === 'FX_REFRESH' ? 'FX_REFRESH_FAILED' : 'MAIL_TRANSPORT_FAILED' } });
            }
        }
        await db.order.updateMany({ where: { status: 'AWAITING_PAYMENT', expiresAt: { lte: now } }, data: { status: 'CLOSED' } });
        const payments = await db.payment.findMany({ where: { provider: 'mock', OR: [{ status: { in: ['CREATED', 'PENDING'] } }, { status: 'FAILED', channel: { status: 'SUCCEEDED' } }] }, orderBy: { queriedAt: { sort: 'asc', nulls: 'first' } }, take: 30 });
        for (const p of payments)
            try {
                await this.shop.reconcilePayment(p.id);
                await db.payment.update({ where: { id: p.id }, data: { queriedAt: now } });
            }
            catch { /* persisted event shows error for admin */ }
        const refunds = await db.refund.findMany({ where: { status: 'PROCESSING' }, take: 30 });
        for (const r of refunds)
            try {
                await this.shop.processRefund(r.id);
            }
            catch { /* result unknown, next tick queries */ }
    }
}
