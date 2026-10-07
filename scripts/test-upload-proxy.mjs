import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { fixture } from './fixture.mjs';
import { root, command, until } from './common.mjs';
const require = createRequire(import.meta.url);
const { createApp } = require('../backend/dist/app');
const { BrowserSession } = require('../backend/test/integration.cjs');
const { LocalStorage } = require('../backend/dist/storage/local');
const { renderPptxPreviews } = require('../backend/dist/storage/pptx-preview');
const Pptx = require('../backend/node_modules/pptxgenjs');
const sharp = require('../backend/node_modules/sharp');
const { zipSync, unzipSync } = require('../backend/node_modules/fflate');
const OTPAuth = require('../backend/node_modules/otpauth');
const t = require('../backend/dist/commerce/dictionaries').dictionaries.zh;
const origin = 'http://localhost:3001', mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const report = { scope: 'Isolated database and private files, real Next.js API proxy, 225 MiB PPTX, browser and preview renderer', checks: [], status: 'FAIL' };
let f, server, browser, frontend, page;
const record = async (name, action) => { report.current = name; await action(); report.checks.push(name); console.log('PASS ' + name); };
try {
    f = await fixture('integration', 55433); f.config.PUBLIC_ORIGIN = origin; f.config.STORE_ACCESS_MODE = 'account'; server = await createApp(f.config); await server.app.listen(4100, '127.0.0.1');
    const base = await server.app.getUrl(), storage = new LocalStorage(f.config.STORAGE_ROOT, f.config.PURCHASE_ROOT);
    frontend = command(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3001'], { cwd: path.join(root, 'frontend'), env: { ...process.env, BACKEND_URL: base } });
    await until('http://127.0.0.1:3001');
    const product = await f.db.product.findFirstOrThrow({ orderBy: { sort: 'asc' }, include: { category: true, versions: { orderBy: { createdAt: 'desc' } } } });
    const prior = product.versions[0], oldBytes = await fs.readFile(storage.resolve(prior.key));
    const buyer = await new BrowserSession(base, f.config).init(false); await buyer.register(f.db, 'preview-buyer@example.test');
    const admin = await new BrowserSession(base, f.config).init(false); await admin.login(f.admin); await admin.reauth(f.admin);
    const buy = async () => {
        const quote = (await buyer.call('/quotes/' + product.id + '?currency=CNY')).data;
        const order = await buyer.call('/orders', 'POST', { productId: product.id, email: buyer.email, language: 'zh', currency: 'CNY', quoteToken: quote.quoteToken, termsVersion: 'demo-v1', idempotencyKey: randomUUID() });
        assert.equal(order.status, 201); assert.equal((await buyer.call('/mock/orders/' + order.data.id + '/scenario', 'POST', { scenario: 'success' })).status, 201);
        return order.data.id;
    };
    const oldOrder = await buy();
    const deck = new Pptx(); deck.layout = 'LAYOUT_WIDE';
    const picture = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#FF6633' } }).png().toBuffer();
    for (let i = 0; i < 2; i++) {
        const slide = deck.addSlide(); slide.background = { color: i ? '224466' : 'F1EBDD' };
        slide.addText('自动预览 / Preview ' + (i + 1), { x: 1, y: 1, w: 10, h: 1, fontFace: 'Arial', fontSize: 32, color: i ? 'FFFFFF' : '224466' });
        slide.addShape(deck.ShapeType.rect, { x: 1, y: 3, w: 3, h: 2, fill: { color: '33AA66' } });
        slide.addImage({ data: 'image/png;base64,' + picture.toString('base64'), x: 5, y: 3, w: 3, h: 2 });
    }
    const entries = unzipSync(await deck.write({ outputType: 'nodebuffer' }));
    entries['ppt/media/padding.bin'] = randomBytes(225 * 1024 * 1024);
    const bytes = Buffer.from(zipSync(entries, { level: 0 }));
    const form = () => { const form = new FormData(); form.append('kind', 'original'); form.append('file', new Blob([bytes], { type: mime }), 'preview.pptx'); return form; };
    await record('Code renderer produces real slide colors, shapes and embedded images without Office', async () => {
        const result = await renderPptxPreviews(bytes); assert.equal(result.slideCount, 2);
        const { data, info } = await sharp(result.images[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
        assert.equal(info.width, 1200); assert.deepEqual(pixel(0, 0).map(v => Math.round(v / 10)), [24, 24, 22]);
        assert.ok(pixel(150, 330)[1] > pixel(150, 330)[0]); assert.ok(pixel(500, 330)[0] > 200);
        await fs.writeFile(path.join(root, 'docs/evidence/code-preview.webp'), result.images[0]);
        await assert.rejects(() => renderPptxPreviews(Buffer.from('invalid')), error => error.getResponse().code === 'PREVIEW_RENDER_FAILED');
    });
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(() => { window.feedbackEvents = []; window.addEventListener('operation-feedback', event => window.feedbackEvents.push(event.detail)); });
    page = await context.newPage(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await record('Admin browser upload shows transfer and processing, then refreshed preview images', async () => {
        await page.goto(origin + '/admin'); await page.getByLabel(t.email).fill(f.admin.email); await page.getByLabel(t.password, { exact: true }).fill(f.admin.password); await page.getByLabel(t.code).fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(f.admin.secret) }).generate());
        await page.locator('form').getByRole('button', { name: new RegExp(t.login) }).click(); await page.locator('.admin-sidebar').waitFor();
        await page.locator('.admin-sidebar').getByRole('button', { name: t.productsAdmin || t.products, exact: true }).click();
        await page.locator('.admin-product-list article').filter({ hasText: product.titleZh }).getByRole('button', { name: t.edit, exact: true }).click();
        const originalAudit = server.shop.audit.bind(server.shop);
        server.shop.audit = async (...args) => { if (args[2] === 'FILE_REPLACE') await new Promise(resolve => setTimeout(resolve, 1200)); return originalAudit(...args); };
        const response = page.waitForResponse(response => response.url().endsWith('/current-file') && response.request().method() === 'POST', { timeout: 120000 }).catch(() => null);
        const uploadPath = path.join(f.config.STORAGE_ROOT, 'upload-fixture.pptx'); await fs.writeFile(uploadPath, bytes);
        await page.locator('.editor select').filter({ has: page.locator('option[value="original"]') }).selectOption('original');
        await page.locator('.editor input[type=file]').setInputFiles(uploadPath);
        await page.locator('.operation-toast.pending').filter({ hasText: '正在生成' }).waitFor(); assert.equal((await response)?.status(), 201);
        await page.locator('.operation-toast.success').filter({ hasText: '已生成 2 张' }).waitFor();
        report.step = 'Wait for editor preview images'; await page.waitForFunction(() => { const images = [...document.querySelectorAll('.editor .admin-product-cover img')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0); });
        server.shop.audit = originalAudit;
        const latest = await f.db.fileVersion.findFirstOrThrow({ where: { productId: product.id }, orderBy: { createdAt: 'desc' } });
        assert.equal(latest.previews.length, 2); assert.notDeepEqual(latest.previews, prior.previews); assert.deepEqual(await fs.readFile(storage.resolve(prior.key)), oldBytes);
        await page.locator('.editor').screenshot({ path: path.join(root, 'docs/evidence/editor-generated-previews.png') });
    });
    await record('Failed rendering and transaction rollback preserve current file and previews', async () => {
        const previous = await f.db.fileVersion.findFirstOrThrow({ where: { productId: product.id }, orderBy: { createdAt: 'desc' } });
        const currentKey = storage.currentKey(product.category.nameZh, product.titleZh), current = await fs.readFile(storage.resolve(currentKey));
        const beforeFiles = await fs.readdir(storage.root);
        const audit = server.shop.audit; server.shop.audit = async (...args) => { if (args[2] === 'FILE_REPLACE') throw new Error('Fixture failure'); return audit.apply(server.shop, args); };
        try { assert.equal((await admin.call('/admin/products/' + product.id + '/current-file', 'POST', form())).status, 500); } finally { server.shop.audit = audit; }
        assert.deepEqual(await fs.readFile(storage.resolve(currentKey)), current); assert.deepEqual((await f.db.fileVersion.findFirstOrThrow({ where: { productId: product.id }, orderBy: { createdAt: 'desc' } })).previews, previous.previews);
        assert.deepEqual(await fs.readdir(storage.root), beforeFiles);
        const invalid = new FormData(); invalid.append('kind', 'original'); invalid.append('file', new Blob(['invalid'], { type: mime }), 'invalid.pptx');
        assert.equal((await admin.call('/admin/products/' + product.id + '/current-file', 'POST', invalid)).status, 400);
    });
    await record('Unpublish, publish, delete and restore each show the specific result', async () => {
        await page.locator('.editor').getByRole('button', { name: t.close, exact: true }).click();
        const row = page.locator('.admin-product-list article').filter({ hasText: product.titleZh });
        for (const [label, text] of [[t.unpublish, '下架成功'], [t.publish, '上架成功'], [t.delete, '删除成功']]) {
            await row.getByRole('button', { name: label, exact: true }).click(); await page.locator('.operation-toast.success').filter({ hasText: text }).waitFor();
        }
        await page.locator('.admin-sidebar').getByRole('button', { name: t.trash, exact: true }).click();
        await page.locator('.admin-product-list article').filter({ hasText: product.titleZh }).getByRole('button', { name: t.restore, exact: true }).click(); await page.locator('.operation-toast.success').filter({ hasText: t.restore }).waitFor();
        assert.equal((await admin.call('/admin/products/' + product.id + '/status', 'POST', { status: 'PUBLISHED' })).status, 201);
    });
    const buyerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await buyerContext.addInitScript(() => { window.downloadProgress = []; window.addEventListener('operation-feedback', event => { if (event.detail.action === 'download' && event.detail.progress !== undefined) window.downloadProgress.push(event.detail.progress); }); });
    await buyerContext.addCookies(Object.entries(buyer.jar).map(([name, value]) => ({ name, value, url: origin })));
    const buyerPage = await buyerContext.newPage(); buyerPage.setDefaultTimeout(20000);
    await record('Buyer product page displays both generated previews', async () => {
        await buyerPage.goto(origin + '/products/' + product.slug);
        await buyerPage.waitForFunction(() => { const images = [...document.querySelectorAll('.previews img')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth === 1200); });
        await buyerPage.locator('.previews').screenshot({ path: path.join(root, 'docs/evidence/buyer-generated-previews.png') });
    });
    await record('Manual preview larger than the former 20 MiB cap passes the real API proxy', async () => {
        const largeImage = Buffer.concat([picture, Buffer.alloc(24 * 1024 * 1024)]);
        const preview = new FormData(); preview.append('kind', 'preview'); preview.append('file', new Blob([largeImage], { type: 'image/png' }), 'large-preview.png');
        const client = new BrowserSession(origin, f.config); client.jar = { ...admin.jar }; client.adminCsrf = admin.adminCsrf;
        const result = await client.call('/admin/products/' + product.id + '/current-file', 'POST', preview); assert.equal(result.status, 201);
    });
    await record('Both buyer and seller chat attachments larger than 20 MiB pass the real API proxy', async () => {
        for (const [session, endpoint] of [[buyer, '/chat/attachments'], [admin, '/admin/chat/attachments']]) {
            const client = new BrowserSession(origin, f.config); client.jar = { ...session.jar }; client.csrf = session.csrf; client.adminCsrf = session.adminCsrf;
            const attachment = new FormData(); attachment.append('file', new Blob([bytes.subarray(0, 24 * 1024 * 1024)], { type: 'application/zip' }), 'large-attachment.zip');
            const result = await client.call(endpoint, 'POST', attachment); assert.equal(result.status, 201); assert.equal(result.data.size, 24 * 1024 * 1024);
        }
    });
    assert.deepEqual(errors, []); report.status = 'PASS'; delete report.current; delete report.step;
} catch (error) {
    report.feedbackEvents = await page?.evaluate(() => window.feedbackEvents).catch(() => []);
    report.errorLine = String(error?.stack).split('\n').find(line => line.includes('test-previews-interactions.mjs:'));
    report.error = String(error?.message || error).split('\n')[0].replace(/postgresql:\/\/\S+/g, '[redacted]');
    await page?.screenshot({ path: path.join(root, 'docs/evidence/upload-proxy-failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
    await browser?.close(); frontend?.kill(); server?.app.getHttpServer().closeAllConnections(); await server?.app.close(); await server?.db.$disconnect(); await f?.stop();
    await fs.writeFile(path.join(root, 'docs/evidence/upload-proxy.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
