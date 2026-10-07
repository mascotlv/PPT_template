const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { LANGUAGES } = require('../dist/commerce/constants');
const { LocalStorage } = require('../dist/storage/local');

// A local provider exercises the actual HTTP translator and its persistent cache.
exports.withTranslation = async (config, action) => {
    const previous = config.CHAT_TRANSLATION_URL, state = { fail: false, calls: 0 };
    const server = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); state.calls++;
        res.writeHead(state.fail ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ translatedText: `${input.target}: ${input.q}` }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    config.CHAT_TRANSLATION_URL = `http://127.0.0.1:${server.address().port}/translate`;
    try { return await action(state); }
    finally { config.CHAT_TRANSLATION_URL = previous; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
};

exports.run = async (ctx, record) => {
    await record('CONTENT-AUTO', '中文商品和分类自动翻译、更新、断线草稿和重试上架', () => exports.withTranslation(ctx.config, async state => {
        const { admin, db, product, buyer } = ctx;
        await admin.reauth(ctx.adminCredentials);
        const category = await admin.call('/admin/categories', 'POST', { id: 'chinese-only', nameZh: '自动翻译分类' });
        assert.equal(category.status, 201, JSON.stringify(category.data));
        for (const language of LANGUAGES) assert.ok(category.data.translations[language]);
        const input = { slug: 'chinese-only', titleZh: '中文商品名称', descriptionZh: '只填写中文介绍', categoryId: category.data.id, status: 'DRAFT', sort: 123, metadata: { ...product.metadata, editable: '文字可修改', fonts: '中文字体', images: '图片可替换', license: '商业使用说明' }, prices: [{ currency: 'CNY', amount: 2300 }] };
        const created = await admin.call('/admin/products', 'POST', input); assert.equal(created.status, 201, JSON.stringify(created.data));
        const id = created.data.id;
        for (const language of LANGUAGES) {
            const row = created.data.translations[language]; assert.ok(row.title); assert.ok(row.description);
            for (const key of ['editable', 'fonts', 'images', 'license']) assert.ok(row.metadata[key]);
        }
        assert.equal(created.data.titleEn, 'en: 中文商品名称');
        const file = product.versions[0], bytes = await fs.readFile(new LocalStorage(ctx.config.STORAGE_ROOT, ctx.config.PURCHASE_ROOT).resolve(file.key));
        const form = new FormData(); form.append('kind', 'original'); form.append('version', '1.0'); form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), '中文文件.pptx');
        const uploaded = await admin.call(`/admin/products/${id}/files`, 'POST', form);
        assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
        const published = await admin.call(`/admin/products/${id}/status`, 'POST', { status: 'PUBLISHED' });
        assert.equal(published.status, 201, JSON.stringify(published.data));
        input.titleZh = '修改后的中文名称'; input.status = 'PUBLISHED';
        const edited = await admin.call(`/admin/products/${id}`, 'PATCH', input); assert.equal(edited.status, 200, JSON.stringify(edited.data));
        assert.equal(edited.data.translations.fr.title, 'fr: 修改后的中文名称');
        const renamed = await admin.call('/admin/categories', 'POST', { id: category.data.id, nameZh: '修改后的分类' });
        assert.equal(renamed.status, 201); assert.equal(renamed.data.translations.en, 'en: 修改后的分类');
        assert.equal((await buyer.call('/products/chinese-only')).data.category.translations.ja, 'ja: 修改后的分类');
        assert.equal((await admin.call(`/admin/products/${id}/status`, 'POST', { status: 'DRAFT' })).status, 201);
        ctx.config.CHAT_TRANSLATION_URL = undefined; input.status = 'DRAFT'; input.titleZh = '服务未配置时保存';
        const draft = await admin.call(`/admin/products/${id}`, 'PATCH', input); assert.equal(draft.status, 200);
        assert.equal(draft.data.translationWarning, 'TRANSLATION_NOT_CONFIGURED'); assert.equal(draft.data.titleEn, '');
        const blocked = await admin.call(`/admin/products/${id}/status`, 'POST', { status: 'PUBLISHED' });
        assert.equal(blocked.status, 201); assert.equal((await db.product.findUnique({ where: { id } })).status, 'PUBLISHED');
        // Restore provider and publish the saved draft without filling any foreign fields.
        await exports.withTranslation(ctx.config, async () => {
            assert.equal((await admin.call(`/admin/products/${id}/status`, 'POST', { status: 'PUBLISHED' })).status, 201);
        });
        assert.equal((await db.product.findUnique({ where: { id } })).titleEn, 'en: 服务未配置时保存');
        assert.ok(state.calls > 0);
        assert.equal((await admin.call(`/admin/products/${id}`, 'DELETE')).status, 200);
        assert.equal((await admin.call(`/admin/categories/${category.data.id}`, 'DELETE')).status, 200);
    }));
};
