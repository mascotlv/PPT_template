import { BadRequestException } from '@nestjs/common';
import { LANGUAGES } from './constants';
import { ChatTranslation } from './chat-translation';
import type { ShopService } from '../modules/shop.service';

const metadataKeys = ['editable', 'fonts', 'images', 'license'] as const;
const filled = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

// Network calls run before database transactions. Never store source text as a translation.
export class ContentTranslation {
    readonly translator: ChatTranslation;
    constructor(shop: ShopService) { this.translator = new ChatTranslation(shop); }
    private async complete(tasks: Array<() => Promise<void>>) {
        if (!tasks.length) return undefined;
        if (!await this.translator.configured()) return 'TRANSLATION_NOT_CONFIGURED';
        let next = 0, failure: string | undefined;
        await Promise.all(Array.from({ length: Math.min(12, tasks.length) }, async () => {
            while (next < tasks.length) {
                const task = tasks[next++];
                try { await task(); } catch { failure = 'TRANSLATION_UNAVAILABLE'; }
            }
        }));
        return failure;
    }
    private async text(source: string, language: string) {
        const result = await this.translator.translate(source, language);
        if (result.status !== 'ready' || !filled(result.text)) throw new Error('Translation unavailable');
        return result.text;
    }
    async purchaseTitle(product: any, language: string): Promise<string | undefined> {
        if (language === 'zh' || filled(product.translations?.[language]?.title) || (language === 'en' && filled(product.titleEn))) return undefined;
        if (!filled(product.titleZh) || !await this.translator.configured()) return undefined;
        try { return await this.text(product.titleZh, language); } catch { return undefined; }
    }
    async product(product: any, existing?: any) {
        const translations: any = structuredClone({ ...existing?.translations, ...product.translations });
        const source = { title: product.titleZh, description: product.descriptionZh, metadata: Object.fromEntries(metadataKeys.map(key => [key, product.metadata?.[key]])) };
        const previous = existing && { title: existing.titleZh, description: existing.descriptionZh, metadata: existing.metadata };
        translations.zh = source;
        const tasks: Array<() => Promise<void>> = [];
        for (const language of LANGUAGES.filter(l => l !== 'zh')) {
            const row = translations[language] = { ...translations[language], metadata: { ...translations[language]?.metadata } };
            for (const key of ['title', 'description', ...metadataKeys]) {
                const meta = metadataKeys.includes(key as any), value = meta ? source.metadata[key] : (source as any)[key];
                const old = meta ? previous?.metadata?.[key] : (previous as any)?.[key];
                const destination = meta ? row.metadata : row;
                if (previous && old !== value) delete destination[key];
                if (!filled(destination[key]) && filled(value)) tasks.push(async () => { destination[key] = await this.text(value, language); });
            }
        }
        const warning = await this.complete(tasks);
        return { data: { ...product, translations, titleEn: translations.en?.title || '', descriptionEn: translations.en?.description || '' }, warning };
    }
    async category(category: any, existing?: any) {
        const translations: any = { ...existing?.translations, ...category.translations, zh: category.nameZh };
        const tasks: Array<() => Promise<void>> = [];
        for (const language of LANGUAGES.filter(l => l !== 'zh')) {
            if (existing && existing.nameZh !== category.nameZh) delete translations[language];
            if (!filled(translations[language])) tasks.push(async () => { translations[language] = await this.text(category.nameZh, language); });
        }
        const warning = await this.complete(tasks);
        return { data: { ...category, translations, nameEn: translations.en || '' }, warning };
    }
}

// Publishing requires Chinese source content; foreign translations are optional.
export function requireTranslations(product: any, category: any) {
    if (!filled(category.nameZh) || !filled(product.titleZh) || !filled(product.descriptionZh))
        throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Chinese product and category fields are required' });
}

// Called by a durable worker after a provider is connected. Network calls stay
// outside transactions; revision checks avoid overwriting concurrent Chinese edits.
export async function translateSavedProduct(shop: ShopService, id: string) {
    const product = await shop.db.product.findUnique({ where: { id }, include: { category: true } });
    if (!product || product.deletedAt) return;
    const translator = new ContentTranslation(shop);
    if (!await translator.translator.configured()) return;
    const prepared = await translator.product(product, product);
    const category = await translator.category(product.category, product.category);
    if (prepared.warning || category.warning) throw new Error('Translation unavailable');
    await shop.db.$transaction(async tx => {
        await shop.lock(tx, 'category:' + product.categoryId);
        await shop.lock(tx, 'product:' + id);
        const current = await tx.product.findUniqueOrThrow({ where: { id } });
        const currentCategory = await tx.category.findUniqueOrThrow({ where: { id: product.categoryId } });
        if (current.updatedAt.getTime() !== product.updatedAt.getTime() || currentCategory.nameZh !== product.category.nameZh)
            throw new Error('Source changed; retry translation');
        await tx.product.update({ where: { id }, data: { translations: prepared.data.translations, titleEn: prepared.data.titleEn, descriptionEn: prepared.data.descriptionEn } });
        await tx.category.update({ where: { id: product.categoryId }, data: { translations: category.data.translations, nameEn: category.data.nameEn } });
    });
}
