import { BadRequestException } from '@nestjs/common';
import { DB } from '../db';
import { CURRENCIES, DIGITS } from './constants';
export type Rate = {
    rate: string;
    date: string;
};
export function convertMinor(baseMinor: number, rate: string, currency: string) {
    if (!Number.isSafeInteger(baseMinor) || baseMinor < 1 || !(currency in DIGITS) || !/^\d+(\.\d{1,12})?$/.test(rate))
        throw new BadRequestException('Invalid currency conversion');
    const [integer, fraction = ''] = rate.split('.');
    const numerator = BigInt(integer + fraction);
    const denominator = 100n * 10n ** BigInt(fraction.length);
    const result = (BigInt(baseMinor) * numerator * 10n ** BigInt(DIGITS[currency]) + denominator / 2n) / denominator;
    if (result < 1n || result > 100000000n)
        throw new BadRequestException('Converted amount outside supported range');
    return Number(result);
}
export class FxService {
    constructor(readonly db: DB) { }
    valid(snapshot: any) { return snapshot?.base === 'CNY' && CURRENCIES.every(code => { const value = snapshot.rates?.[code]; if (!value || !/^\d+(\.\d{1,12})?$/.test(value.rate) || Number(value.rate) <= 0)
        return false; const at = new Date(value.date + 'T00:00:00Z').getTime(); return Number.isFinite(at) && at <= Date.now() + 86400000 && Date.now() - at <= 7 * 86400000; }); }
    async latest(force = false) {
        const old = await this.db.fxSnapshot.findFirst({ orderBy: { fetchedAt: 'desc' } });
        if (!force && this.valid(old) && Date.now() - old!.fetchedAt.getTime() < 15 * 60000)
            return old!;
        try {
            const url = 'https://api.frankfurter.dev/v2/rates?base=CNY&quotes=' + CURRENCIES.filter(c => c !== 'CNY').join(',');
            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok)
                throw new Error();
            const rows = await response.json() as unknown;
            if (!Array.isArray(rows) || rows.length > 100)
                throw new Error();
            const rates: Record<string, Rate> = { CNY: { rate: '1', date: new Date().toISOString().slice(0, 10) } };
            for (const row of rows) {
                if (!CURRENCIES.includes(row.quote) || row.base !== 'CNY' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || typeof row.rate !== 'number' || row.rate <= 0 || !/^\d+(\.\d{1,12})?$/.test(String(row.rate)))
                    throw new Error();
                if (!Number.isFinite(new Date(row.date + 'T00:00:00Z').getTime()) || new Date(row.date + 'T00:00:00Z').getTime() > Date.now() + 86400000 || Date.now() - new Date(row.date + 'T00:00:00Z').getTime() > 7 * 86400000)
                    throw new Error();
                rates[row.quote] = { rate: String(row.rate), date: row.date };
            }
            if (CURRENCIES.some(code => !rates[code]))
                throw new Error();
            return this.db.fxSnapshot.create({ data: { source: 'Frankfurter', base: 'CNY', rates } });
        }
        catch {
            if (!force && this.valid(old) && Date.now() - old!.fetchedAt.getTime() < 7 * 86400000)
                return old!;
            throw new BadRequestException({ code: 'FX_UNAVAILABLE', message: 'Current exchange rates unavailable; price update was not saved' });
        }
    }
    async prices(baseMinor: number) { const snapshot = await this.latest(); const rates = snapshot.rates as Record<string, Rate>; return { snapshot, prices: CURRENCIES.map(currency => ({ currency, amount: convertMinor(baseMinor, rates[currency].rate, currency) })) }; }
    async refreshPrices() {
        const snapshot = await this.latest(true);
        const rates = snapshot.rates as Record<string, Rate>;
        let products = 0;
        for (const product of await this.db.product.findMany({ select: { id: true } })) {
            await this.db.$transaction(async (tx) => {
                await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${'product:' + product.id}))`;
                const base = await tx.price.findUnique({ where: { productId_currency: { productId: product.id, currency: 'CNY' } } });
                if (!base)
                    return;
                for (const currency of CURRENCIES) {
                    const amount = convertMinor(base.amount, rates[currency].rate, currency);
                    await tx.price.upsert({ where: { productId_currency: { productId: product.id, currency } }, create: { productId: product.id, currency, amount }, update: { amount, active: base.active } });
                }
                await tx.setting.upsert({ where: { key: 'pricing:' + product.id }, create: { key: 'pricing:' + product.id, value: { snapshotId: snapshot.id, baseAmount: base.amount } }, update: { value: { snapshotId: snapshot.id, baseAmount: base.amount } } });
            });
            products++;
        }
        await this.db.setting.upsert({ where: { key: 'fxLastRefresh' }, create: { key: 'fxLastRefresh', value: { at: new Date().toISOString(), snapshotId: snapshot.id, products } }, update: { value: { at: new Date().toISOString(), snapshotId: snapshot.id, products } } });
        return { ...snapshot, products };
    }
}
