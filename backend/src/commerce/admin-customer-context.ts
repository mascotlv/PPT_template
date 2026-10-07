import type { DB } from '../db';
import { customerProfileKey } from './chat-profile';

export async function adminCustomerContext(db: DB, ids: string[], emails: string[]) {
    const jobs = await db.job.findMany({ where: { id: { in: ids } }, select: { id: true, relatedId: true } });
    const refs = [...new Set([...ids, ...jobs.map(j => j.relatedId)])];
    const orders = await db.order.findMany({ where: { OR: [{ id: { in: refs } }, { customerId: { in: refs } }, { email: { in: emails } }, { payments: { some: { OR: [{ id: { in: refs } }, { events: { some: { id: { in: refs } } } }] } } }, { refunds: { some: { id: { in: refs } } } }, { tickets: { some: { id: { in: refs } } } }] }, select: { id: true, customerId: true, email: true, payments: { select: { id: true, events: { select: { id: true } } } }, refunds: { select: { id: true } }, tickets: { select: { id: true } } } });
    const customers = await db.customer.findMany({ where: { OR: [{ id: { in: [...refs, ...orders.flatMap(o => o.customerId ? [o.customerId] : [])] } }, { email: { in: [...emails, ...orders.map(o => o.email)] } }] }, select: { id: true, name: true, email: true, country: true, language: true } });
    const [profiles, purchases] = await Promise.all([
        db.setting.findMany({ where: { key: { in: customers.map(c => customerProfileKey(c.id)) } }, select: { key: true, value: true } }),
        db.order.groupBy({ by: ['customerId'], where: { customerId: { in: customers.map(c => c.id) }, paidPaymentId: { not: null } }, _count: true }),
    ]);
    const profilesByKey = new Map(profiles.map(p => [p.key, p.value as any])), purchasesById = new Map(purchases.map(p => [p.customerId, p._count]));
    const contexts = customers.map(c => ({ ...c, nickname: profilesByKey.get(customerProfileKey(c.id))?.nickname || c.name, purchaseCount: purchasesById.get(c.id) || 0 }));
    const byId: Record<string, any> = {}, byEmail: Record<string, any> = {};
    for (const c of contexts) { byId[c.id] = c; byEmail[c.email] = c; }
    for (const o of orders) {
        const customer = (o.customerId && byId[o.customerId]) || byEmail[o.email];
        if (!customer) continue;
        for (const id of [o.id, ...o.payments.flatMap(p => [p.id, ...p.events.map(e => e.id)]), ...o.refunds.map(r => r.id), ...o.tickets.map(t => t.id)]) byId[id] = customer;
    }
    for (const j of jobs) if (byId[j.relatedId]) byId[j.id] = byId[j.relatedId];
    return { byId, byEmail };
}
