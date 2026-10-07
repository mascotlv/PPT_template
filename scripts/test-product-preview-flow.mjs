import assert from 'node:assert/strict';
import { makePdf } from './pdf-preview-fixture.mjs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './fixture.mjs';
const require = createRequire(import.meta.url);
const { createApp } = require('../backend/dist/app');
const { BrowserSession } = require('../backend/test/integration.cjs');
const { LocalStorage } = require('../backend/dist/storage/local');
const renderer = require('../backend/dist/storage/pptx-preview');
const sharp = require('../backend/node_modules/sharp');
const { BadRequestException } = require('../backend/node_modules/@nestjs/common');
const { withTranslation } = require('../backend/test/content.cjs');
const { translateSavedProduct } = require('../backend/dist/commerce/content');
let f, server;
const report = { checks: [], status: 'FAIL' };
try {
    f = await fixture('integration', 55434); server = await createApp(f.config); await server.app.listen(0, '127.0.0.1');
    const client = await new BrowserSession(await server.app.getUrl(), f.config).init();
    await client.login(f.admin);
    const adminSession = await f.db.session.findFirstOrThrow({ where: { adminId: f.admin.id, revokedAt: null, kind: 'ADMIN' }, orderBy: { createdAt: 'desc' } });
    await f.db.session.update({ where: { id: adminSession.id }, data: { reauthAt: null } });
    const product = await f.db.product.findFirstOrThrow({ include: { category: true, versions: true, prices: true }, orderBy: { sort: 'asc' } });
    const storage = new LocalStorage(f.config.STORAGE_ROOT, f.config.PURCHASE_ROOT);
    const bytes = await fs.readFile(storage.resolve(product.versions[0].key));
    const upload = () => { const form = new FormData(); form.append('kind', 'original'); form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'fixture.pptx'); return client.call('/admin/products/' + product.id + '/current-file', 'POST', form); };
    const sensitive = await client.call('/admin/orders/export', 'POST', {});
    assert.equal(sensitive.status, 403); assert.equal(sensitive.data.code, 'REAUTH_REQUIRED');
    const noCsrf = new FormData(); noCsrf.append('file', new Blob([bytes]), 'fixture.pptx');
    assert.equal((await client.call('/admin/products/' + product.id + '/current-file', 'POST', noCsrf, { 'X-CSRF-Token': '' })).status, 403);
    report.checks.push('Upload retains CSRF protection; other sensitive actions still require reauthentication');
    const originalRenderer = renderer.renderPptxPreviews;
    renderer.renderPptxPreviews = async () => { throw new BadRequestException({ code: 'PREVIEW_RENDER_FAILED', reason: 'Fixture unsupported slide' }); };
    let failed;
    try { failed = await upload(); } finally { renderer.renderPptxPreviews = originalRenderer; }
    assert.equal(failed.status, 201); assert.equal(failed.data.previewWarning, 'PREVIEW_RENDER_FAILED');
    assert.deepEqual(await fs.readFile(storage.resolve(storage.currentKey(product.category.nameZh, product.titleZh))), bytes);
    await new Promise(resolve => setTimeout(resolve, 150));
    let traces = (await client.call('/admin/products/' + product.id + '/traces')).data;
    assert.ok(traces.some(trace => trace.state === 'warning' && trace.steps.some(step => step.stage === 'render' && step.state === 'error' && step.reason === 'Fixture unsupported slide')));
    report.checks.push('Preview failure preserves and files original, with durable failed-stage trace');
    await f.db.product.update({ where: { id: product.id }, data: { translations: {}, titleEn: '', descriptionEn: '' } });
    assert.equal((await client.call('/admin/products/' + product.id + '/status', 'POST', { status: 'PUBLISHED' })).status, 201);
    report.checks.push('Chinese-only product publishes without translation provider');
    const regenerated = await client.call('/admin/products/' + product.id + '/previews/regenerate', 'POST', {});
    assert.equal(regenerated.status, 201); assert.equal(regenerated.data.previews.length, product.metadata.slides);
    for (const key of regenerated.data.previews) {
        assert.ok(key.endsWith('.png')); assert.equal((await fs.readFile(storage.resolve(key))).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    report.checks.push('Regeneration renders every page as real PNG and fills page count');
    const previewForm = new FormData(); previewForm.append('kind', 'preview');
    previewForm.append('file', new Blob([await fs.readFile(storage.resolve(regenerated.data.previews[0]))], { type: 'image/png' }), 'manual.png');
    assert.equal((await client.call('/admin/products/' + product.id + '/current-file', 'POST', previewForm)).status, 201);
    const legacy = new FormData(); legacy.append('version', 'no-reauth'); legacy.append('kind', 'original');
    legacy.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'fixture.pptx');
    assert.equal((await client.call('/admin/products/' + product.id + '/files', 'POST', legacy)).status, 201);
    assert.equal((await f.db.session.findUniqueOrThrow({ where: { id: adminSession.id } })).reauthAt, null);
    report.checks.push('Original upload, manual preview, legacy upload and regeneration all work without reauthentication');
    const pdf = makePdf(product.metadata.slides);
    const paired = new FormData(); paired.append('kind', 'original-pdf');
    paired.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'fixture.pptx');
    paired.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'preview.pdf');
    renderer.renderPptxPreviews = async () => { throw new Error('Paired mode must not use the PPTX renderer'); };
    let pairResult;
    try { pairResult = await client.call('/admin/products/' + product.id + '/current-file', 'POST', paired); }
    finally { renderer.renderPptxPreviews = originalRenderer; }
    assert.equal(pairResult.status, 201, JSON.stringify(pairResult.data));
    assert.equal(pairResult.data.previewWarning, undefined);
    assert.equal(pairResult.data.previewCount, product.metadata.slides);
    const pdfVersion = await f.db.fileVersion.findUniqueOrThrow({ where: { id: pairResult.data.fileVersionId } });
    assert.deepEqual(await fs.readFile(storage.resolve(pdfVersion.key)), bytes);
    for (const key of pairResult.data.previews) {
        const image = await sharp(await fs.readFile(storage.resolve(key))).raw().toBuffer({ resolveWithObject: true });
        assert.equal(image.info.width, 1200);
        assert.ok(image.data[0] > 240 && image.data[1] < 10 && image.data[2] < 10, 'PDF red background renders correctly');
    }
    report.checks.push('Paired PPTX + PDF bypasses PPTX conversion, renders all PDF pages correctly and preserves original bytes');
    const replacePdf = (payload) => { const form = new FormData(); form.append('kind', 'preview-pdf'); form.append('file', new Blob([payload], { type: 'application/pdf' }), 'replacement.pdf'); return client.call('/admin/products/' + product.id + '/current-file', 'POST', form); };
    const replaced = await replacePdf(pdf); assert.equal(replaced.status, 201);
    assert.equal(replaced.data.fileVersionId, pdfVersion.id);
    assert.equal(replaced.data.previewCount, product.metadata.slides);
    const mismatch = await replacePdf(makePdf(product.metadata.slides + 1));
    assert.equal(mismatch.status, 400); assert.equal(mismatch.data.code, 'PDF_PAGE_COUNT_MISMATCH');
    const broken = await replacePdf(Buffer.from('%PDF-1.7 invalid'));
    assert.equal(broken.status, 400); assert.equal(broken.data.code, 'PDF_RENDER_FAILED');
    assert.deepEqual((await f.db.fileVersion.findUniqueOrThrow({ where: { id: pdfVersion.id } })).previews, replaced.data.previews);
    assert.equal((await f.db.session.findUniqueOrThrow({ where: { id: adminSession.id } })).reauthAt, null);
    await new Promise(resolve => setTimeout(resolve, 150));
    const pdfTraces = (await client.call('/admin/products/' + product.id + '/traces')).data;
    assert.ok(pdfTraces.some(trace => trace.steps.some(step => step.stage === 'render' && step.error === 'PDF_PAGE_COUNT_MISMATCH') || trace.error === 'PDF_PAGE_COUNT_MISMATCH'));
    report.checks.push('PDF-only replacement retains original/version; invalid PDF and wrong page count preserve existing previews and report durable failures without reauthentication');
    const category = await f.db.category.findFirstOrThrow({ where: { id: { not: product.categoryId } } });
    const payload = { slug: product.slug, titleZh: product.titleZh, descriptionZh: product.descriptionZh, categoryId: category.id, status: 'PUBLISHED', sort: product.sort, metadata: { ...product.metadata, slides: 499 }, prices: [{ currency: 'CNY', amount: 2900 }] };
    const moved = await client.call('/admin/products/' + product.id, 'PATCH', payload);
    assert.equal(moved.status, 200); assert.equal(moved.data.metadata.slides, product.metadata.slides);
    await assert.rejects(() => fs.access(storage.resolve(storage.currentKey(product.category.nameZh, product.titleZh))));
    assert.deepEqual(await fs.readFile(storage.resolve(storage.currentKey(category.nameZh, product.titleZh))), bytes);
    report.checks.push('Category changes move current file; manual page-count edits cannot override original');
    await withTranslation(f.config, async () => { await translateSavedProduct(server.shop, product.id); });
    const translated = await f.db.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.ok(translated.translations.ja.title); assert.equal(translated.status, 'PUBLISHED');
    report.checks.push('Connecting a provider later fills saved product translations without changing publication');
    await new Promise(resolve => setTimeout(resolve, 150));
    await server.app.close(); await server.db.$disconnect();
    server = await createApp(f.config); await server.app.listen(0, '127.0.0.1');
    const restarted = await new BrowserSession(await server.app.getUrl(), f.config).init(); await restarted.login(f.admin);
    traces = (await restarted.call('/admin/products/' + product.id + '/traces')).data;
    assert.ok(traces.some(trace => trace.state === 'warning')); assert.ok(traces.some(trace => trace.action === 'publish' && trace.state === 'success'));
    report.checks.push('Per-product traces survive server restart'); report.status = 'PASS';
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
    await fs.writeFile('docs/evidence/product-preview-flow.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    server?.app.getHttpServer().closeAllConnections(); await server?.app.close(); await server?.db.$disconnect(); await f?.stop();
}
