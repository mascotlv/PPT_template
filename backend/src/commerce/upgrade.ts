import fs from 'node:fs/promises';
import { DB } from '../db';
import { Config } from '../config';
import { LocalStorage } from '../storage/local';
import { normalizePurchaseFiles } from '../storage/purchase-files';
import { FxService } from './fx';
import { demoProducts, demoCategories } from './demo';
import { dictionaries } from './dictionaries';
import { LANGUAGES } from './constants';
export async function upgradeCommerce(db: DB, c: Config) {
    const storage = new LocalStorage(c.STORAGE_ROOT, c.PURCHASE_ROOT);
    await fs.mkdir(c.PURCHASE_ROOT, { recursive: true });
    for (const [id, translations] of Object.entries(demoCategories)) {
        const category = await db.category.findUnique({ where: { id } });
        if (category) {
            const current = category.translations as any;
            await db.category.update({ where: { id }, data: { translations: { ...translations, ...current, zh: category.nameZh, en: category.nameEn } } });
        }
    }
    let products = 0, files = 0;
    for (const [slug, translations] of Object.entries(demoProducts)) {
        const p = await db.product.findUnique({ where: { slug }, include: { prices: true, versions: true } });
        if (!p || !p.isDemo)
            continue;
        const current = p.translations as any;
        await db.product.update({ where: { id: p.id }, data: { translations: { ...translations, ...current, zh: { ...translations.zh, ...current.zh, title: p.titleZh, description: p.descriptionZh }, en: { ...translations.en, ...current.en, title: p.titleEn, description: p.descriptionEn } } } });
        const base = p.prices.find(v => v.currency === 'CNY')?.amount;
        if (base) {
            const result = await new FxService(db).prices(base);
            await db.$transaction(async (tx) => { for (const price of result.prices)
                await tx.price.upsert({ where: { productId_currency: { productId: p.id, currency: price.currency } }, create: { productId: p.id, ...price }, update: { amount: price.amount, active: true } }); await tx.setting.upsert({ where: { key: 'pricing:' + p.id }, create: { key: 'pricing:' + p.id, value: { baseAmount: base, snapshotId: result.snapshot.id } }, update: { value: { baseAmount: base, snapshotId: result.snapshot.id } } }); });
            products++;
            for (const file of p.versions) {
                if (file.key.startsWith('purchased/') || file.key.startsWith('history/'))
                    continue;
                const bytes = await fs.readFile(storage.resolve(file.key));
                const target = await storage.putHistory(bytes, file.id, p.titleZh);
                try {
                    await db.fileVersion.update({ where: { id: file.id }, data: { key: target.key, filename: target.filename } });
                    files++;
                }
                catch (e) {
                    await fs.unlink(storage.resolve(target.key));
                    throw e;
                }
            }
        }
    }
    const brand = await db.setting.findUnique({ where: { key: 'brand' } });
    if (brand) {
        const original = brand.value as any;
        await db.setting.update({ where: { key: 'brand' }, data: { value: { ...original, translations: { ...Object.fromEntries(LANGUAGES.map(l => [l, { name: l === 'zh' ? original.nameZh : l === 'en' ? original.nameEn : dictionaries[l].brand, footer: dictionaries[l].footer }])), ...original.translations } } } });
    }
    await normalizePurchaseFiles(db, c);
    return { products, files, currencies: 29, languages: 13 };
}
