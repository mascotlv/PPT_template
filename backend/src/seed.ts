import pptxgen from 'pptxgenjs';
import { randomUUID } from 'node:crypto';
import { demoProducts, demoCategories } from './commerce/demo';
import { dictionaries } from './commerce/dictionaries';
import { LANGUAGES } from './commerce/constants';
import { FxService } from './commerce/fx';
import sharp from 'sharp';
import { Config, parseConfig } from './config';
import { database, DB } from './db';
import { LocalStorage } from './storage/local';
import { escapeHtml } from './security';
export async function seed(db: DB, c: Config) {
    const storage = new LocalStorage(c.STORAGE_ROOT, c.PURCHASE_ROOT);
    const themes = [{ slug: 'sage-strategy', zh: '青岚 · 战略提案', en: 'Sage Strategy', category: 'business', color: '244F46', background: 'F1F4EB', price: 2900, usd: 900 }, { slug: 'coral-story', zh: '珊瑚 · 品牌叙事', en: 'Coral Brand Story', category: 'creative', color: 'BE5039', background: 'FFF0E5', price: 3900, usd: 1200 }, { slug: 'midnight-report', zh: '深蓝 · 数据报告', en: 'Midnight Report', category: 'report', color: '284D85', background: 'EDF1FA', price: 4900, usd: 1500 }];
    for (const category of [{ id: 'business', nameZh: '商业提案', nameEn: 'Business' }, { id: 'creative', nameZh: '品牌创意', nameEn: 'Creative' }, { id: 'report', nameZh: '数据报告', nameEn: 'Reports' }])
        await db.category.upsert({ where: { id: category.id }, create: { ...category, translations: demoCategories[category.id as keyof typeof demoCategories] }, update: {} });
    for (const [index, t] of themes.entries()) {
        if (await db.product.findUnique({ where: { slug: t.slug } }))
            continue;
        const id = randomUUID(), pricing = await new FxService(db).prices(t.price);
        const deck = new pptxgen();
        deck.layout = 'LAYOUT_WIDE';
        deck.author = 'Template Workshop';
        deck.subject = 'Original editable demonstration template';
        deck.title = t.en;
        deck.company = 'Template Workshop';
        deck.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' };
        const previews: string[] = [];
        const titles = [t.en, 'Our direction', 'Three priorities', 'Illustrative data', 'Next steps'];
        for (let page = 0; page < 5; page++) {
            const slide = deck.addSlide();
            slide.background = { color: t.background };
            slide.addText('TEMPLATE WORKSHOP / DEMO', { x: 0.75, y: 0.5, w: 10, h: 0.3, fontFace: 'Arial', fontSize: 16, color: t.color });
            slide.addText(titles[page], { x: 0.75, y: 1.3, w: 11.8, h: 1.2, fontSize: page === 0 ? 50 : 36, bold: true, color: t.color, breakLine: false, margin: 0 });
            slide.addText(page === 0 ? 'An editable starting point for your next presentation.' : 'Replace the sample copy with your own story.', { x: 0.75, y: 2.65, w: 10.5, h: 0.65, fontSize: 24, color: t.color, margin: 0 });
            if (page === 3)
                slide.addChart(deck.ChartType.bar, [{ name: 'Illustrative series', labels: ['A', 'B', 'C'], values: [24, 42, 66] }], { x: 0.75, y: 3.8, w: 10.5, h: 2.4, showLegend: false, showTitle: false, catAxisLabelFontSize: 16, valAxisLabelFontSize: 16, chartColors: [t.color], showValue: true });
            else if (page > 0)
                for (let k = 0; k < 3; k++) {
                    slide.addShape(deck.ShapeType.rect, { x: 0.75 + k * 4.1, y: 3.8, w: 3.7, h: 0.035, fill: { color: t.color }, line: { color: t.color } });
                    slide.addText(`${String(k + 1).padStart(2, '0')}\n${['Focus', 'Build', 'Share'][k]}`, { x: 0.75 + k * 4.1, y: 4.05, w: 3.7, h: 1.4, fontSize: 24, color: t.color, margin: 0 });
                }
            slide.addText(`ORIGINAL DEMONSTRATION • EDITABLE TEXT & SHAPES     ${page + 1}/5`, { x: 0.75, y: 6.8, w: 11.8, h: 0.25, fontSize: 16, color: t.color, margin: 0 });
            slide.addNotes('Original sample copy, shapes and illustrative data. Arial system font. No external images. Demo license v1.');
            // The shop preview is an original raster cover; structural verification checks the PPTX itself.
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#${t.background}"/><text x="70" y="75" font-family="Arial" font-size="20" fill="#${t.color}">TEMPLATE WORKSHOP / DEMO</text><text x="70" y="235" font-family="Arial" font-size="${page === 0 ? 76 : 62}" font-weight="bold" fill="#${t.color}">${escapeHtml(titles[page])}</text><text x="70" y="310" font-family="Arial" font-size="27" fill="#${t.color}">An editable starting point for your story.</text>${page === 0 ? `<circle cx="1050" cy="470" r="145" fill="#${t.color}" opacity=".14"/><circle cx="1060" cy="475" r="90" fill="#${t.color}" opacity=".18"/>` : [0, 1, 2].map(k => `<rect x="${70 + k * 390}" y="410" width="340" height="4" fill="#${t.color}"/><text x="${70 + k * 390}" y="475" font-size="24" font-family="Arial" fill="#${t.color}">0${k + 1} / ${['Focus', 'Build', 'Share'][k]}</text>`).join('')}<text x="70" y="660" font-size="18" font-family="Arial" fill="#${t.color}">ORIGINAL DEMONSTRATION / ${page + 1} OF 5</text></svg>`;
            const preview = await storage.put(await sharp(Buffer.from(svg)).png().toBuffer(), 'png');
            previews.push(preview.key);
        }
        const bytes = await deck.write({ outputType: 'nodebuffer' }) as Buffer;
        const file = await storage.putPurchased(bytes, id, '1.0', t.zh);
        await db.product.create({ data: { id, translations: demoProducts[t.slug as keyof typeof demoProducts], slug: t.slug, titleZh: t.zh, titleEn: t.en, descriptionZh: demoProducts[t.slug as keyof typeof demoProducts].zh.description, descriptionEn: demoProducts[t.slug as keyof typeof demoProducts].en.description, categoryId: t.category, status: 'PUBLISHED', sort: index, isDemo: true, metadata: { slides: 5, ratio: '16:9', software: 'PowerPoint / WPS', editable: '文字、形状、原生图表 / Text, shapes, native chart', fonts: 'Arial 系统字体，不包含字体文件 / Arial system font; font files not bundled', images: '自有几何元素，无第三方图片 / Original geometry, no external images', license: 'demo-v1：仅供测试与评估，正式商业许可待运营者完善' }, prices: { create: pricing.prices }, versions: { create: { version: '1.0', ...file, filename: file.filename, licenseVersion: 'demo-v1', previews } } } });
        await db.setting.create({ data: { key: 'pricing:' + id, value: { baseAmount: t.price, snapshotId: pricing.snapshot.id } } });
    }
    await db.setting.upsert({ where: { key: 'brand' }, create: { key: 'brand', value: { nameZh: '模板工坊', nameEn: 'Template Workshop', contact: '经营者联系方式待完善', footer: '原创可编辑演示模板', translations: Object.fromEntries(LANGUAGES.map(l => [l, { name: dictionaries[l].brand, footer: dictionaries[l].footer }])) } }, update: {} });
}
if (require.main === module) {
    const c = parseConfig(process.env);
    if (c.APP_ENV === 'production')
        throw new Error('Demo seeding forbidden in production');
    const db = database(c.DATABASE_URL);
    seed(db, c).then(() => console.log('Demo products initialized without overwriting existing data')).finally(() => db.$disconnect());
}
