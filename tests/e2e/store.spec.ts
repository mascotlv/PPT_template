import {test,expect,Page,Browser,APIRequestContext} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {dictionaries} from '../../frontend/src/locales/dictionaries';import {LANGUAGES,DEFAULT_CURRENCY} from '../../frontend/src/locales/constants';
import {Client} from 'pg';
import {contentProvider, fixtureTranslation} from './content-provider';
import {cnyMinor} from '../../packages/contracts/cny.cjs';
let stopContentProvider: (() => Promise<void>) | undefined;
test.beforeEach(async ({}, info) => {
    if (info.title.startsWith('T03/T14') || info.title.startsWith('U10') || info.title.startsWith('CONTENT-UI')) stopContentProvider = await contentProvider(secrets.env.DATABASE_URL);
});
test.afterEach(async () => { await stopContentProvider?.(); stopContentProvider = undefined; });
test('CONTENT-UI Chinese-only category and product forms show every required marker', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('.auth-panel form .required-mark')).toHaveCount(3);
    await login(page);
    await page.getByRole('button', { name: t.categories, exact: true }).click();
    await page.getByRole('button', { name: t.newCategory, exact: true }).click();
    const categoryForm = page.locator('form.editor');
    await expect(categoryForm.getByLabel(t.name + ' / ID', { exact: true })).toHaveValue('');
    await expect(categoryForm.locator('select')).toHaveCount(0);
    await categoryForm.locator('input[maxlength="100"]').fill('浏览器中文分类');
    const categoryResponse = page.waitForResponse(r => r.url().endsWith('/admin/categories') && r.request().method() === 'POST');
    await categoryForm.getByRole('button', { name: t.save, exact: true }).click();
    const category = await (await categoryResponse).json();
    for (const language of LANGUAGES) expect(category.translations[language]).toBeTruthy();
    await page.getByRole('button', { name: t.productsAdmin, exact: true }).click();
    await page.getByRole('button', { name: t.newProduct, exact: true }).click();
    const editor = page.locator('.editor');
    await expect(editor.getByLabel(t.name + ' / URL', { exact: true })).toHaveValue('');
    await expect(editor.getByRole('combobox', { name: t.language, exact: true })).toHaveCount(0);
    await editor.getByLabel(t.category, { exact: true }).selectOption(category.id);
    await editor.getByLabel(t.title, { exact: true }).fill('只填写中文商品名称');
    await editor.getByLabel(t.description, { exact: true }).fill('只填写中文说明，其他语言自动生成。');
    const markers = await editor.locator('input[required], textarea[required], select[required]').evaluateAll(fields => fields.every(field => !!field.closest('label')?.querySelector('.required-mark')));
    expect(markers).toBeTruthy();
    await expect(editor).toContainText(t.autoTranslationHelp);
    await page.screenshot({ path: 'docs/evidence/content-chinese-required.png', fullPage: true });
    const response = page.waitForResponse(r => r.url().endsWith('/admin/products') && r.request().method() === 'POST');
    await editor.locator('form').first().getByRole('button', { name: t.save, exact: true }).click();
    const saved = await response; expect(saved.status()).toBe(201);
    const product = await saved.json();
    expect(product.titleZh).toBe('只填写中文商品名称'); expect(product.titleEn).toBe(fixtureTranslation('只填写中文商品名称', 'en'));
    for (const language of LANGUAGES) {
        expect(product.translations[language].title).toBeTruthy();
        for (const key of ['editable', 'fonts', 'images', 'license']) expect(product.translations[language].metadata[key]).toBeTruthy();
    }
    await expect(editor).toContainText('13/13');
});
const secrets=JSON.parse(fs.readFileSync('.runtime/e2e.json','utf8')),t=dictionaries.zh;let management:APIRequestContext;
test('ADMIN-WORKBENCH equal filters, refund and feedback alerts, revenue and complete customer identity', async ({ page }) => {
    await enter(page); await buy(page, 'workbench@example.test', 'en');
    await page.getByRole('button', { name: dictionaries.en.payNow, exact: true }).click();
    await expect(page.getByRole('button', { name: new RegExp(dictionaries.en.download) })).toBeVisible();
    const orderId = page.url().split('/').at(-1)!;
    await page.locator('.preferences select').first().selectOption('zh');
    let session = await (await page.request.get('/api/v1/session')).json();
    const buyerHeaders = { Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf };
    expect((await page.request.patch('/api/v1/account/profile', { headers: buyerHeaders, data: { name: 'Test Buyer', nickname: 'Template Fan', country: 'US', language: 'en', currency: 'USD' } })).status()).toBe(200);
    await login(page);
    await expect(page.locator('.summary-card').filter({ hasText: t.totalRevenue })).toBeVisible();
    await expect(page.locator('.summary-card').filter({ hasText: t.totalRevenue })).toContainText(/¥[\d,.]+/);
    const refund = await page.request.post('/api/v1/orders/' + orderId + '/refunds', { headers: buyerHeaders, data: { reason: 'Please refund this template' } });
    expect(refund.status()).toBe(201);
    const ticket = await page.request.post('/api/v1/orders/' + orderId + '/support', { headers: buyerHeaders, data: { content: 'Please help with editing' } });
    expect(ticket.status()).toBe(201);
    const sidebar = page.locator('.admin-sidebar');
    await expect(sidebar.getByRole('button', { name: t.refunds, exact: true }).locator('.unread-badge')).toHaveText('1', { timeout: 10000 });
    await expect(sidebar.getByRole('button', { name: t.support, exact: true }).locator('.unread-badge')).toHaveText('1');
    await expect(page.locator('.merchant-attention-alerts')).toContainText(t.refunds);
    await expect(page.locator('.merchant-attention-alerts')).toContainText(t.support);
    await sidebar.getByRole('button', { name: t.refunds, exact: true }).click();
    const identity = page.locator('.record-list .customer-summary').first();
    for (const value of ['Test Buyer', 'Template Fan', 'workbench@example.test', t.totalPurchases]) await expect(identity).toContainText(value);
    await expect(identity.locator('dd').last()).toHaveText('1');
    await expect(page.getByRole('button', { name: t.reject, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: t.approve, exact: true })).toBeDisabled();
    await reauth(page);
    await expect(page.getByLabel(t.reason, { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: t.reject, exact: true }).click();
    await expect(sidebar.getByRole('button', { name: t.refunds, exact: true }).locator('.unread-badge')).toHaveCount(0);
    await sidebar.getByRole('button', { name: t.support, exact: true }).click();
    await expect(page.locator('.feedback-item .customer-summary')).toContainText('Template Fan');
    await page.locator('.feedback-item').getByLabel(t.status, { exact: true }).selectOption('RESOLVED');
    await page.locator('.feedback-item button').last().click();
    await expect(sidebar.getByRole('button', { name: t.support, exact: true }).locator('.unread-badge')).toHaveCount(0);
    await sidebar.getByRole('button', { name: t.orders, exact: true }).click();
    await expect(page.locator('tbody .customer-summary')).toContainText('Template Fan');
    const heights = await page.locator('.management-filters input,.management-filters select').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(48);
    await page.locator('.operation-toast button').evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()));
    await page.screenshot({ path: 'docs/evidence/admin-order-filters-customers.png' });
    await sidebar.getByRole('button', { name: t.events, exact: true }).click();
    await expect(page.locator('.record-list .customer-summary').first()).toContainText('Template Fan');
    await sidebar.getByRole('button', { name: t.customers, exact: true }).click();
    await expect(page.locator('tbody .customer-summary').filter({ hasText: 'workbench@example.test' })).toContainText('Template Fan');
    session = await (await page.request.get('/api/v1/session')).json();
    const context = await page.request.post('/api/v1/admin/customer-context', { headers: { Origin: 'http://localhost:3000', 'X-CSRF-Token': session.adminCsrf }, data: { ids: [orderId, (await refund.json()).id, (await ticket.json()).id], emails: [] } });
    expect(context.status()).toBe(201);
    const records = (await context.json()).byId;
    expect(records[orderId].purchaseCount).toBe(1);
    expect(records[orderId].country).toBe('US');
});
test('ADMIN-POLISH redesigned feedback, wrapping chat identity, centered records, filters and database labels', async ({ page }) => {
    await enter(page); await buy(page, 'long.customer.email.for.layout.verification@example.test', 'zh');
    await page.getByRole('button', { name: t.payNow, exact: true }).click();
    await expect(page.getByRole('button', { name: /下载模板/ })).toBeVisible();
    const orderId = page.url().split('/').at(-1)!;
    let session = await (await page.request.get('/api/v1/session')).json();
    const headers = { Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrf };
    expect((await page.request.post(`/api/v1/orders/${orderId}/support`, { headers, data: { content: '模板字体排版需要帮助，请客服协助处理。' } })).status()).toBe(201);
    expect((await page.request.post('/api/v1/chat/messages', { headers, data: { content: '您好，我需要帮助。', clientId: randomUUID() } })).status()).toBe(201);
    await login(page);
    await expect(page.locator('a.admin-store-button')).toBeVisible();
    expect(await page.locator('a.admin-store-button').evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('solid');
    await page.locator('.storage-breakdown details summary').click();
    await expect(page.locator('.storage-breakdown details')).toContainText(t.orders);
    await expect(page.locator('.storage-breakdown details')).not.toContainText('FileVersion');
    await page.locator('.preferences select').first().selectOption('fr');
    await expect(page.locator('.storage-breakdown details')).toContainText(dictionaries.fr.databaseUsage);
    await expect(page.locator('.storage-breakdown details')).toContainText(dictionaries.fr.orders);
    await page.locator('.preferences select').first().selectOption('zh');
    const sidebar = page.locator('.admin-sidebar');
    await sidebar.getByRole('button', { name: t.support, exact: true }).click();
    await expect(page.locator('.feedback-redesigned')).toBeVisible();
    await page.locator('.feedback-search input').fill('模板字体排版');
    await expect(page.locator('.feedback-item')).toContainText('模板字体排版');
    await page.getByLabel(t.reply, { exact: true }).fill('您好，已收到，正在处理。');
    const replyResponse = page.waitForResponse(r => r.url().includes('/admin/support/') && r.request().method() === 'PATCH');
    await page.locator('.feedback-item button').last().click();
    expect((await replyResponse).status()).toBe(200);
    await page.locator('.admin-content').evaluate(el => el.scrollTop = 0);
    await page.locator('.operation-toast button').evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()));
    await page.screenshot({ path: 'docs/evidence/admin-feedback-redesigned.png' });
    await sidebar.getByRole('button', { name: t.chat, exact: true }).click();
    await expect(page.locator('.conversation-list .customer-summary').first()).toBeVisible();
    expect(await page.locator('.conversation-list').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.locator('.conversation-list button').first().click();
    await expect(page.locator('.chat-history')).toContainText('您好，我需要帮助。');
    await page.setViewportSize({ width: 1024, height: 900 });
    expect(await page.locator('.conversation-list').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'docs/evidence/admin-chat-redesigned.png' });
    await sidebar.getByRole('button', { name: t.orders, exact: true }).click();
    await page.locator('.management-filters input').first().fill('long.customer.email');
    await page.locator('tbody tr').first().getByRole('button', { name: t.details, exact: true }).click();
    await expect(page.locator('.record-details .customer-summary').first()).toBeVisible();
    await page.locator('.record-details').scrollIntoViewIfNeeded();
    expect(await page.locator('tbody td').evaluateAll(cells => cells.every(cell => getComputedStyle(cell).verticalAlign === 'middle'))).toBeTruthy();
    await page.screenshot({ path: 'docs/evidence/admin-record-details-redesigned.png' });
    await sidebar.getByRole('button', { name: t.customers, exact: true }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    expect(await page.locator('tbody td').evaluateAll(cells => cells.every(cell => getComputedStyle(cell).verticalAlign === 'middle'))).toBeTruthy();
    await sidebar.getByRole('button', { name: t.analytics, exact: true }).click();
    await expect(page.locator('.admin-content>.form-row input').first()).toBeVisible();
    const heights = await page.locator('.admin-content>.form-row input,.admin-content>.form-row select').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(1); expect(new Set(heights).size).toBe(1);
    await page.screenshot({ path: 'docs/evidence/admin-analytics-filters.png' });
    await sidebar.getByRole('button', { name: t.settings, exact: true }).click();
    await expect(page.locator('.form-panel button')).toBeDisabled();
    await page.getByRole('button', { name: '清空全部业务数据', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('商品、分类、价格、原文件、历史版本、预览图');
    await page.getByRole('dialog').getByRole('button', { name: t.cancel, exact: true }).click();
});

test('ADMIN-CONFIG private memo, four account panels and editable multilingual storefront text', async ({ page }) => {
    await login(page);
    const sidebar = page.locator('.admin-sidebar');
    for (const tab of [t.dashboard, t.categories, t.productsAdmin, t.support, t.chat, t.analytics]) {
        await sidebar.getByRole('button', { name: tab, exact: true }).click();
        await expect(page.locator('.reauth')).toHaveCount(0);
    }
    await sidebar.getByRole('button', { name: t.support, exact: true }).click();
    await page.getByRole('button', { name: new RegExp(t.newMemo) }).click();
    await page.locator('.memo-editor').getByLabel(t.memoTitle, { exact: true }).fill('需要跟进的个人问题');
    await page.locator('.memo-editor').getByLabel(t.problemDescription, { exact: true }).fill('这里仅展示一次问题内容。');
    await page.locator('.memo-editor').getByRole('button', { name: t.save, exact: true }).click();
    await expect(page.locator('.memo-detail')).toBeVisible();
    await expect(page.locator('.memo-detail textarea')).toHaveCount(1);
    await expect(page.locator('.memo-detail .feedback-original')).toHaveCount(0);
    await expect(page.locator('.memo-detail input')).toHaveValue('需要跟进的个人问题');
    const row = page.locator('.feedback-ticket-row').filter({ hasText: '需要跟进的个人问题' });
    await row.getByRole('button', { name: /解决 ·/ }).click();
    await expect(row).toHaveCount(0);
    await page.locator('.feedback-status').getByRole('button', { name: new RegExp(t.resolved) }).click();
    await expect(page.locator('.feedback-ticket-row').filter({ hasText: '需要跟进的个人问题' })).toBeVisible();
    await page.locator('.operation-toast button').evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()));
    await page.screenshot({ path: 'docs/evidence/admin-simple-memo.png' });
    await sidebar.getByRole('button', { name: t.account, exact: true }).click();
    await expect(page.locator('.account-setting-card')).toHaveCount(4);
    await expect(page.locator('.account-settings .primary')).toBeDisabled();
    await reauth(page);
    await expect(page.locator('.account-settings .primary')).toBeEnabled();
    const centers = await page.locator('.account-settings').evaluate(el => {
        const button = el.querySelector('.primary')!.getBoundingClientRect(), form = el.getBoundingClientRect();
        return Math.abs((button.left + button.right) / 2 - (form.left + form.right) / 2);
    }); expect(centers).toBeLessThan(2);
    const cards = await page.locator('.account-setting-card').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().left));
    expect(cards[0]).toBe(cards[2]); expect(cards[1]).toBe(cards[3]); expect(cards[1]).toBeGreaterThan(cards[0]);
    await page.locator('.account-settings .primary').click();
    await expect(page.locator('.account-settings [role=status]')).toContainText(t.saved);
    await page.locator('.operation-toast button').evaluateAll(buttons => buttons.forEach(button => (button as HTMLButtonElement).click()));
    await page.screenshot({ path: 'docs/evidence/admin-account-four-panels.png' });
    await sidebar.getByRole('button', { name: t.frontend, exact: true }).click();
    await page.locator('.frontend-text-toolbar').getByLabel(t.search, { exact: true }).fill('hero');
    await page.getByRole('textbox', { name: 'hero', exact: true }).fill('这是后台配置的首页标题');
    await page.locator('.frontend-text-settings .centered-save button').click();
    await page.screenshot({ path: 'docs/evidence/admin-frontend-text.png' });
    await page.goto('/'); await expect(page.locator('.hero h1')).toHaveText('这是后台配置的首页标题');
    await page.locator('.preferences select').first().selectOption('en');
    await expect(page.locator('.hero h1')).toContainText(dictionaries.en.hero.split('\n')[0]);
    await page.goto('/admin');
    await page.locator('.frontend-text-toolbar').getByLabel(t.search, { exact: true }).fill('hero');
    await page.locator('.frontend-text-field').filter({ has: page.getByRole('textbox', { name: 'hero', exact: true }) }).getByRole('button', { name: t.restoreDefault, exact: true }).click();
    await page.locator('.frontend-text-settings .centered-save button').click();
    await page.goto('/'); await page.locator('.preferences select').first().selectOption('zh');
    await expect(page.locator('.hero h1')).toContainText(t.hero.split('\n')[0]);
});

test('ADMIN-CNY all financial panels and exports report RMB while purchases retain their currency', async ({ page }) => {
    await enter(page); await buy(page, 'cny-report@example.test', 'en');
    await page.getByRole('button', { name: dictionaries.en.payNow, exact: true }).click();
    await expect(page.getByRole('button', { name: new RegExp(dictionaries.en.download) })).toBeVisible();
    const orderId = page.url().split('/').at(-1)!;
    await page.locator('.preferences select').first().selectOption('zh');
    await page.route('**/api/v1/admin/reporting-rates', route => route.fulfill({ json: { rates: { CNY: { rate: '1' }, USD: { rate: '0.14' } } } }));
    await page.route('**/api/v1/admin/dashboard', async route => {
        const response = await route.fetch(), data = await response.json();
        await route.fulfill({ json: { ...data, orders: [{ currency: 'USD', _sum: { amount: 1400 } }, { currency: 'CNY', _sum: { amount: 10000 } }], refunds: [{ currency: 'USD', _sum: { amount: 700 } }] } });
    });
    await login(page);
    await expect(page.locator('.preferences select').last()).toHaveValue('CNY');
    await expect(page.locator('.preferences select').last()).toBeDisabled();
    await expect(page.locator('.money-summary').first()).toContainText('¥200.00');
    await expect(page.locator('.money-summary').last()).toContainText('¥50.00');
    const record = { id: 'report-order', number: 'RMB-TEST', amount: 1400, currency: 'USD', email: 'report@example.test', language: 'en', country: 'US', status: 'PAID', createdAt: new Date().toISOString(), paymentAttempts: [{ id: 'payment', amount: 1400, currency: 'USD', status: 'SUCCEEDED' }], refunds: [{ id: 'refund', amount: 700, currency: 'USD', status: 'SUCCEEDED' }] };
    await page.route('**/api/v1/admin/orders?*', route => route.fulfill({ json: { rows: [record], page: 1, total: 1 } }));
    await page.locator('.admin-sidebar').getByRole('button', { name: t.orders, exact: true }).click();
    await expect(page.locator('tbody tr').first()).toContainText('¥100.00');
    await page.locator('tbody tr').first().getByRole('button', { name: t.details, exact: true }).click();
    await expect(page.locator('.record-details')).toContainText('¥100.00');
    await expect(page.locator('.record-details')).toContainText('¥50.00');
    await page.route('**/api/v1/admin/refunds', route => route.fulfill({ json: [{ id: 'refund', amount: 700, currency: 'USD', status: 'SUCCEEDED', order: { number: 'RMB-TEST' }, payment: { provider: 'mock' } }] }));
    await page.locator('.admin-sidebar').getByRole('button', { name: t.refunds, exact: true }).click();
    await expect(page.locator('.record-list h3')).toContainText('¥50.00');
    await page.route('**/api/v1/admin/events', route => route.fulfill({ json: [{ id: 'event', receivedAt: new Date().toISOString(), status: 'COMPLETED', payment: { amount: 1400, currency: 'USD', status: 'SUCCEEDED', order: { number: 'RMB-TEST' } } }] }));
    await page.locator('.admin-sidebar').getByRole('button', { name: t.events, exact: true }).click();
    await expect(page.locator('.record-list')).toContainText('¥100.00');
    await page.route('**/api/v1/admin/analytics?*', async route => { const response = await route.fetch(), data = await response.json(); await route.fulfill({ json: { ...data, currencies: [{ currency: 'USD', purchases: 1, grossMinor: 1400, refundMinor: 700 }] } }); });
    await page.locator('.admin-sidebar').getByRole('button', { name: t.analytics, exact: true }).click();
    await expect(page.locator('.table-scroll').first()).toContainText('¥100.00');
    await expect(page.locator('.table-scroll').first()).toContainText('¥50.00');
    await page.screenshot({ path: 'docs/evidence/admin-cny-analytics.png' });
    await page.route('**/api/v1/admin/mail', route => route.fulfill({ json: [{ id: 'money-mail', status: 'CAPTURED', subject: 'Money preview', html: '<html><body><p>付款金额：US$14.00 (USD)</p></body></html>' }] }));
    await page.locator('.admin-sidebar').getByRole('button', { name: t.mailInbox, exact: true }).click();
    await page.getByText('Money preview', { exact: false }).click();
    await expect(page.frameLocator('iframe[title="Money preview"]').locator('p')).toContainText('¥100.00 (CNY)');
    await page.locator('.admin-sidebar').getByRole('button', { name: t.productsAdmin, exact: true }).click();
    await expect(page.locator('.admin-product-list')).not.toContainText(/US\$|€|JP¥/);
    await page.locator('.admin-product-list article').first().getByRole('button', { name: t.edit, exact: true }).click();
    await expect(page.locator('.currency-grid')).toContainText('CNY');
    await expect(page.locator('.currency-grid span')).toHaveCount(1);
    const session = await (await page.request.get('/api/v1/session')).json();
    const headers = { Origin: 'http://localhost:3000', 'X-CSRF-Token': session.adminCsrf };
    expect((await page.request.post('/api/v1/admin/reauth', { headers, data: { password: secrets.admin.password, code: await otp() } })).status()).toBe(201);
    const exportResponse = await page.request.post('/api/v1/admin/orders/export', { headers });
    expect(exportResponse.status()).toBe(201);
    const csv = await exportResponse.text();
    expect(csv).toContain('CNY'); expect(csv).not.toContain('USD');
    const purchased = await (await page.request.get('/api/v1/orders/' + orderId)).json();
    expect(purchased.currency).toBe('USD');
    const rates = (await (await page.request.get('/api/v1/admin/reporting-rates')).json()).rates;
    const amount = cnyMinor(purchased.amount, purchased.currency, rates.USD.rate, 2);
    expect(csv).toContain('"CNY","' + amount + '"');
});
test('ADMIN-VIEW independent scrolling, settings 2048, pagination and reload position', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page);
    await page.locator('.admin-sidebar').getByRole('button', { name: t.settings, exact: true }).click();
    const content = page.locator('.admin-content'), sidebar = page.locator('.admin-sidebar');
    await expect(page.getByLabel(t.downloadTokenDuration, { exact: true })).toBeVisible();
    await content.evaluate(el => { el.scrollTop = 250; });
    const contentTop = await content.evaluate(el => el.scrollTop);
    await sidebar.evaluate(el => { el.scrollTop = 100; });
    const sideBox = (await sidebar.boundingBox())!;
    await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + sideBox.height / 2);
    await page.mouse.wheel(0, 160);
    await expect.poll(() => sidebar.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    expect(await content.evaluate(el => el.scrollTop)).toBe(contentTop);
    const sideTop = await sidebar.evaluate(el => el.scrollTop);
    const contentBox = (await content.boundingBox())!;
    await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
    await page.mouse.wheel(0, 160);
    await expect.poll(() => content.evaluate(el => el.scrollTop)).toBeGreaterThan(contentTop);
    expect(await sidebar.evaluate(el => el.scrollTop)).toBe(sideTop);
    const duration = page.getByLabel(t.downloadTokenDuration, { exact: true });
    await duration.fill('2048');
    const position = await content.evaluate(el => el.scrollTop);
    const response = page.waitForResponse(r => r.url().endsWith('/admin/settings') && r.request().method() === 'PATCH');
    await duration.press('Enter');
    expect((await response).status()).toBe(200);
    await expect(content.locator('>p[role=status]')).toHaveText(t.saved);
    expect(await content.evaluate(el => el.scrollTop)).toBe(position);
    await page.reload();
    await expect(page.getByLabel(t.downloadTokenDuration, { exact: true })).toHaveValue('2048');
    await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(position);
    await page.screenshot({ path: 'docs/evidence/admin-independent-scroll.png' });
    const db = new Client({ connectionString: secrets.env.DATABASE_URL });
    try {
        await db.connect();
        const rows = Array.from({ length: 55 }, (_, i) => ({ id: randomUUID(), email: `scroll-${i}@example.test`, name: `Scroll customer ${i}` }));
        await db.query('INSERT INTO "Customer" (id,email,name,country,language,currency,"passwordHash","updatedAt") SELECT id,email,name,\'CN\',\'zh\',\'CNY\',\'disabled-test-account\',now() FROM jsonb_to_recordset($1) AS x(id text,email text,name text)', [JSON.stringify(rows)]);
    } finally { await db.end(); }
    await sidebar.getByRole('button', { name: t.customers, exact: true }).click();
    await page.locator('.management-filters input').fill('scroll');
    await expect(content.locator('tbody tr')).toHaveCount(25);
    await content.getByRole('button', { name: t.next, exact: true }).click();
    await expect(content.locator('.button-row')).toContainText(t.page + ' 2');
    await expect(content.locator('tbody tr')).toHaveCount(25);
    await content.evaluate(el => { el.scrollTop = 450; });
    const customerTop = await content.evaluate(el => el.scrollTop);
    await content.locator('>.section-title>button').evaluate((el: HTMLButtonElement) => el.click());
    await expect(content.locator('>.section-title>button')).toBeEnabled();
    expect(await content.evaluate(el => el.scrollTop)).toBe(customerTop);
    await page.reload();
    await expect(content.locator('.button-row')).toContainText(t.page + ' 2');
    await expect(page.locator('.management-filters input')).toHaveValue('scroll');
    await expect(content.locator('tbody tr')).toHaveCount(25);
    await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(customerTop);
});
test.beforeEach(async()=>{if(!/^workshop_test_browser_[a-f\d]{8}$/.test(new URL(secrets.env.DATABASE_URL).pathname.slice(1)))throw new Error('Only disposable browser fixtures may reset test rate counters');const db=new Client({connectionString:secrets.env.DATABASE_URL});try{await db.connect();await db.query('DELETE FROM "RateLimit"');}finally{await db.end();}});
async function otp(){const o=await import('../../backend/node_modules/otpauth/dist/otpauth.node.cjs');return new o.TOTP({secret:o.Secret.fromBase32(secrets.admin.secret)}).generate();}
test.beforeAll(async({playwright})=>{management=await playwright.request.newContext({baseURL:'http://localhost:3000'});const s=await(await management.get('/api/v1/session')).json();await management.post('/api/v1/access',{data:{password:secrets.accessPassword},headers:{Origin:'http://localhost:3000','X-CSRF-Token':s.csrf}});const r=await management.post('/api/v1/admin/login',{data:{email:secrets.admin.email,password:secrets.admin.password,code:await otp()},headers:{Origin:'http://localhost:3000','X-CSRF-Token':s.csrf}});expect(r.status()).toBe(201);const registration=await management.post('/api/v1/account/register',{data:{name:'Browse Buyer',email:'browse@example.test',password:'browser-test-passphrase',country:'CN',language:'zh',currency:'CNY'},headers:{Origin:'http://localhost:3000','X-CSRF-Token':s.csrf}});if(registration.status()===201){const registered=await registration.json(),link=await mail('browse@example.test','kind=VERIFY'),token=new URLSearchParams(new URL(link).hash.slice(1)).get('token');expect((await management.post('/api/v1/account/verify',{data:{token},headers:{Origin:'http://localhost:3000','X-CSRF-Token':registered.csrf}})).status()).toBe(201);}else{expect((await registration.json()).code).toBe('ACCOUNT_EXISTS');const current=await(await management.get('/api/v1/session')).json();expect((await management.post('/api/v1/account/login',{data:{email:'browse@example.test',password:'browser-test-passphrase'},headers:{Origin:'http://localhost:3000','X-CSRF-Token':current.csrf}})).status()).toBe(201);}});test.afterAll(async()=>{await management.dispose();});
async function enter(page:Page,email='browse@example.test'){await page.goto('/');await expect(page.locator('.auth-panel h1')).toHaveText(t.login);await expect(page.locator('.product-card')).toHaveCount(0);await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill('browser-test-passphrase');await page.locator('form').getByRole('button',{name:t.login,exact:true}).click();await expect(page.locator('.hero h1')).toContainText(t.hero.split('\n')[0]);}
async function mail(email:string,fragment:string){let found:any;await expect.poll(async()=>{const rows=await(await management.get('/api/v1/admin/mail')).json();found=rows.find((m:any)=>m.recipient===email&&m.html.includes(fragment));return !!found;},{timeout:20000}).toBeTruthy();return /href="([^"]+)"/.exec(found.html)![1].replaceAll('&amp;','&');}
async function register(page:Page,email:string,next='/checkout/sage-strategy'){await page.goto(`/account?next=${encodeURIComponent(next)}`);await page.getByRole('button',{name:t.register,exact:true}).click();await page.getByLabel(t.name,{exact:true}).fill('Browser Buyer');await page.getByLabel(t.country,{exact:true}).selectOption('US');await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill('browser-test-passphrase');await page.locator('form').getByRole('button',{name:t.register,exact:true}).click();await expect(page.getByText(t.verificationRequired,{exact:true})).toBeVisible();const link=await mail(email,'kind=VERIFY');await page.goto(link);await expect(page).toHaveURL('/account');await page.getByRole('button',{name:t.confirm,exact:true}).click();await expect(page.getByText(t.verified,{exact:true})).toBeVisible();await page.goto(next);}
async function buy(page:Page,email:string,language:'zh'|'en'='zh'){await page.goto('/account');await page.getByRole('button',{name:t.logout,exact:true}).click();await page.goto('/checkout/sage-strategy');await expect(page.locator('.auth-panel h1')).toHaveText(t.login);await register(page,email);if(language!=='zh')await page.locator('.preferences select').first().selectOption(language);await expect(page.getByLabel(dictionaries[language].email,{exact:true})).toHaveValue(email);await page.getByRole('checkbox').check();await page.getByRole('button',{name:dictionaries[language].place,exact:true}).click();await expect(page).toHaveURL(/\/orders\//);}
async function login(page:Page){await page.goto('/admin');await page.getByLabel(t.email,{exact:true}).fill(secrets.admin.email);await page.getByLabel(t.password,{exact:true}).fill(secrets.admin.password);await page.getByLabel(t.code,{exact:true}).fill(await otp());await page.locator('form').getByRole('button',{name:t.login,exact:true}).click();await expect(page.getByRole('heading',{name:t.dashboard,exact:true})).toBeVisible();}
async function reauth(page:Page){if(!await page.locator('.reauth').evaluate(el=>(el as HTMLDetailsElement).open)) await page.locator('.reauth summary').click();await page.locator('.reauth').getByLabel(t.password,{exact:true}).fill(secrets.admin.password);await page.locator('.reauth').getByLabel(t.code,{exact:true}).fill(await otp());const verified=page.waitForResponse(r=>r.url().endsWith('/admin/reauth')&&r.request().method()==='POST');await page.locator('.reauth').getByRole('button',{name:t.verifyIdentity,exact:true}).click();expect((await verified).status()).toBe(201);await expect(page.locator('.verification-state')).toHaveText(t.verified);}
test('T02 responsive layouts, filters and all 13 language/currency switches',async({page})=>{const failures:string[]=[];page.on('pageerror',e=>failures.push(e.message));await enter(page);await expect(page.locator('.product-card')).toHaveCount(3);await page.screenshot({path:'docs/evidence/store-desktop.png',fullPage:true});await page.goto('/products');await page.getByRole('button',{name:'商业提案',exact:true}).click();await expect(page.locator('.product-card')).toHaveCount(1);await expect(page).toHaveURL(/category=business/);await page.reload();await expect(page.locator('.product-card')).toHaveCount(1);await page.getByRole('button',{name:t.all,exact:true}).click();await page.getByLabel(t.search,{exact:true}).fill('深蓝');await expect(page.locator('.product-card')).toHaveCount(1);await page.getByLabel(t.search,{exact:true}).fill('');for(const l of LANGUAGES){await page.locator('.preferences select').first().selectOption(l);await expect(page.locator('html')).toHaveAttribute('lang',l);await expect(page.locator('.preferences select').last()).toHaveValue(DEFAULT_CURRENCY[l]);await expect(page.locator('.product-card')).toHaveCount(3);await expect(page.locator('.product-card').first()).not.toContainText(dictionaries[l].translationMissing);await expect(page.locator('.header nav')).toContainText(dictionaries[l].navShop);await page.goto('/policies/privacy');await expect(page.locator('main')).toContainText(dictionaries[l].privacyPolicy);await page.goto('/products/sage-strategy');await expect(page.locator('main')).not.toContainText(dictionaries[l].translationMissing);await page.goto('/products');}await page.locator('.preferences select').first().selectOption('zh');await page.locator('.preferences select').last().selectOption('USD');await expect(page.locator('.product-card').first()).toContainText('4.33');for(const [name,width,height]of [['tablet',820,1180],['mobile',390,844]]as const){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`docs/evidence/store-${name}.png`,fullPage:true});}expect(failures).toEqual([]);});
test('T04/T05 registration, verified checkout, pending payment and title-named download',async({page})=>{await enter(page);await buy(page,'browser@example.test');await page.evaluate(async()=>{const session=await(await fetch('/api/v1/session')).json();const id=location.pathname.split('/').at(-1);const r=await fetch('/api/v1/mock/orders/'+id+'/scenario',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({scenario:'pending'})});if(!r.ok)throw Error('Pending scenario failed');});await page.reload();await expect(page.getByRole('heading',{name:t.processing,exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/下载模板/})).toHaveCount(0);await page.getByRole('button',{name:t.payNow,exact:true}).click();await expect(page.getByRole('heading',{name:t.ready,exact:true})).toBeVisible();const promise=page.waitForEvent('download');await page.getByRole('button',{name:/下载模板/}).click();const download=await promise;expect(download.suggestedFilename()).toBe('青岚 · 战略提案.pptx');await fs.promises.mkdir('.runtime/browser-downloads',{recursive:true});const target=path.resolve('.runtime/browser-downloads',download.suggestedFilename());await download.saveAs(target);expect(fs.statSync(target).size).toBeGreaterThan(5000);expect(fs.readFileSync(target).readUInt32LE()).toBe(0x04034b50);await page.screenshot({path:'docs/evidence/paid-order.png',fullPage:true});});
test('T03/T14 actual admin product edit, customer records, support and refund',async({page})=>{await enter(page);await buy(page,'refund@example.test');await page.getByRole('button',{name:t.payNow,exact:true}).click();await expect(page.getByRole('button',{name:/下载模板/})).toBeVisible();const orderUrl=page.url();await page.getByLabel(t.reason,{exact:true}).fill('浏览器退款与售后测试');await page.getByRole('button',{name:t.support,exact:true}).click();await page.getByRole('button',{name:t.requestRefund,exact:true}).click();await expect(page.getByRole('heading',{name:t.refundRequested})).toBeVisible();await login(page);await page.getByRole('button',{name:t.orders,exact:true}).click();await page.getByLabel(t.search,{exact:true}).fill('refund@example.test');await expect(page.locator('tbody tr')).toHaveCount(1);await page.getByRole('button',{name:t.details,exact:true}).click();await expect(page.locator('.record-details')).toContainText(t.paymentAttempts);await expect(page.locator('.record-details')).toContainText(t.mailRecords);await page.getByRole('button',{name:t.customers,exact:true}).click();await page.getByLabel(t.search,{exact:true}).fill('refund@example.test');await expect(page.locator('tbody tr')).toHaveCount(1);await expect(page.locator('tbody tr')).toContainText('美国');await page.getByRole('button',{name:t.productsAdmin,exact:true}).click();await page.locator('.admin-product-list').getByRole('button',{name:t.edit,exact:true}).first().click();await page.locator('.editor').getByLabel(t.title,{exact:true}).fill('青岚 · 浏览器编辑验证');await page.locator('.editor form').first().getByRole('button',{name:t.save,exact:true}).click();await expect(page.locator('.admin-product-list')).toContainText('浏览器编辑验证');await page.getByRole('button',{name:t.support,exact:true}).click();await page.getByLabel(t.reply,{exact:true}).fill('已收到您的测试申请');await page.locator('.feedback-item').getByRole('combobox',{name:t.status,exact:true}).selectOption('RESOLVED');await page.locator('.record-list').getByRole('button',{name:t.save,exact:true}).click();await page.locator('.feedback-status').getByRole('button',{name:new RegExp(t.resolved)}).click();await expect(page.locator('.feedback-item')).toContainText(t.resolved);await page.getByRole('button',{name:t.refunds,exact:true}).click();await reauth(page);await page.locator('.record-list').getByLabel(t.reason,{exact:true}).fill('通过浏览器审核并原路退款');const reviewed=page.waitForResponse(r=>r.url().includes('/review')&&r.request().method()==='POST');await page.getByRole('button',{name:t.approve,exact:true}).click();expect((await reviewed).status()).toBe(201);await page.goto(orderUrl);await expect(page.getByRole('heading',{name:t.refunded})).toBeVisible({timeout:20000});await expect(page.getByRole('button',{name:/下载模板/})).toHaveCount(0);await expect(page.locator('.support-panel')).toContainText('已收到您的测试申请');});
test('T06/T26 recovery email prefetch safe and explicit confirmation restores customer orders',async({page,browser})=>{await enter(page);await buy(page,'recover-browser@example.test');await page.getByRole('button',{name:t.payNow,exact:true}).click();await expect(page.getByRole('button',{name:/下载模板/})).toBeVisible();await expect(page).toHaveURL(/\/orders\/[a-f0-9-]+$/);const orderUrl=page.url();await page.goto('/recover');await page.getByLabel(t.email,{exact:true}).fill('recover-browser@example.test');await page.getByRole('button',{name:t.send,exact:true}).click();const link=await mail('recover-browser@example.test','/recover#token=');const context=await browser.newContext({baseURL:'http://localhost:3000'}),fresh=await context.newPage();await enter(fresh,'recover-browser@example.test');await fresh.goto(link);await expect(fresh).toHaveURL('/recover');const redeemed=fresh.waitForResponse(r=>r.url().endsWith('/recover/redeem')&&r.request().method()==='POST');await fresh.getByRole('button',{name:t.confirm,exact:true}).click();expect((await redeemed).status()).toBe(201);await expect(fresh.locator('p[role=status]')).toHaveText(t.queued);await expect(fresh.locator('.recovered-order')).toHaveCount(1);await fresh.goto(orderUrl);await expect(fresh.getByRole('button',{name:/下载模板/})).toBeVisible();await fresh.goto('/account');await expect(fresh.getByText(t.verified,{exact:true})).toBeVisible();await context.close();});
test('U10 admin drag upload, full translations, auto currency prices, publish/delete/restore/category archive',async({page})=>{await enter(page);await login(page);await page.getByRole('button',{name:t.productsAdmin,exact:true}).click();const p=await(await management.get('/api/v1/products/sage-strategy')).json();const session=await(await management.get('/api/v1/session')).json(),idSlug='browser-drag-'+randomUUID().slice(0,8),body={slug:idSlug,titleZh:'拖入文件测试',titleEn:'Drag upload test',descriptionZh:'拖入文件功能测试',descriptionEn:'Drag upload feature test',categoryId:p.category.id,status:'DRAFT',sort:500,metadata:p.metadata,translations:p.translations,prices:[{currency:'CNY',amount:4900}]};const result=await management.post('/api/v1/admin/products',{data:body,headers:{Origin:'http://localhost:3000','X-CSRF-Token':session.adminCsrf}});expect(result.status()).toBe(201);const created=await result.json();await page.getByRole('button',{name:t.refresh,exact:true}).click();const card=page.locator('.admin-product-list article').filter({hasText:idSlug});await card.getByRole('button',{name:t.edit,exact:true}).click();await reauth(page);const fileRoot=secrets.env.PURCHASE_ROOT,fileProduct=secrets.env.STORAGE_ROOT,folders=fs.readdirSync(fileRoot),first=folders.map((name:string)=>path.join(fileRoot,name)).find((folder:string)=>fs.statSync(folder).isDirectory()&&fs.readdirSync(folder).some((v:string)=>v.endsWith('.pptx')))!,file=path.join(first,fs.readdirSync(first).find((v:string)=>v.endsWith('.pptx'))!),bytes=Array.from(fs.readFileSync(file));const transfer=await page.evaluateHandle(data=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(data)],'uploaded.pptx',{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}));return dt;},bytes);const uploadResponse=page.waitForResponse(r=>r.url().endsWith('/current-file')&&r.request().method()==='POST');await page.locator('.drop-zone').dispatchEvent('drop',{dataTransfer:transfer});expect((await uploadResponse).status()).toBe(201);await expect(page.locator('.drop-zone')).toContainText('uploaded.pptx');await expect(card).toContainText('拖入文件测试.pptx');expect(fs.existsSync(path.join(fileRoot,p.category.nameZh,'拖入文件测试.pptx'))).toBeTruthy();await card.getByRole('button',{name:t.publish,exact:true}).click();await expect(card).toContainText(t.published);const product=await(await management.get('/api/v1/products/'+idSlug)).json();expect(product.prices).toHaveLength(29);await card.getByRole('button',{name:t.unpublish,exact:true}).click();await expect(card).toContainText(t.draft);await card.getByRole('button',{name:t.delete,exact:true}).click();await expect(card).toHaveCount(0);await page.getByRole('button',{name:t.trash,exact:true}).click();const trash=page.locator('.admin-product-list article').filter({hasText:idSlug});await trash.getByRole('button',{name:t.restore,exact:true}).click();await expect(trash).toHaveCount(0);await page.getByRole('button',{name:t.categories,exact:true}).click();const category=page.locator('.record-list article').filter({hasText:'品牌创意'});await category.getByRole('button',{name:t.delete,exact:true}).click();await expect(category).toContainText(t.archived);await category.getByRole('button',{name:t.restore,exact:true}).click();await expect(category).toContainText(t.active);expect(fileProduct).toBeTruthy();await page.getByRole('button',{name:t.productsAdmin,exact:true}).click();await page.getByRole('button',{name:t.newProduct,exact:true}).click();await page.locator('.editor').getByLabel(t.name+' / URL',{exact:true}).fill('browser-partial-draft');await page.locator('.editor').getByLabel(t.title,{exact:true}).fill('\u4e2d\u6587\u8349\u7a3f');await page.locator('.editor').getByLabel(t.description,{exact:true}).fill('\u540e\u53f0\u521b\u5efa\u5546\u54c1\u6d4b\u8bd5');const saved=page.waitForResponse(r=>r.url().endsWith('/admin/products')&&r.request().method()==='POST');await page.locator('.editor form').first().getByRole('button',{name:t.save,exact:true}).click();expect((await saved).status()).toBe(201);await expect(page.locator('.admin-product-list')).toContainText('\u4e2d\u6587\u8349\u7a3f');});
test('U11 analytics filters and all 13 admin languages without missing translations',async({page})=>{await enter(page);await login(page);await page.getByRole('button',{name:t.analytics,exact:true}).click();await expect(page.locator('.dashboard-cards')).toContainText(t.clicks);await expect(page.locator('.dashboard-cards')).toContainText(t.purchases);await page.getByLabel(t.month,{exact:true}).selectOption(String(new Date().getUTCMonth()+1));await expect(page.locator('main')).toContainText('CNY');for(const l of LANGUAGES){await page.locator('.preferences select').first().selectOption(l);await expect(page.locator('h1')).toHaveText(dictionaries[l].analytics);await expect(page.locator('main')).not.toContainText(dictionaries[l].translationMissing);await expect(page.locator('main')).not.toContainText('undefined');if(!['zh','zh-TW','ja'].includes(l)){const text=await page.locator('main').innerText();expect(text).not.toMatch(/[\u3400-\u9fff]/);}}await page.locator('.preferences select').first().selectOption('ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');await page.screenshot({path:'docs/evidence/admin-analytics-ar.png',fullPage:true});await page.locator('.preferences select').first().selectOption('zh');await page.screenshot({path:'docs/evidence/admin-analytics.png',fullPage:true});});

test('N08 first page is login in all languages; wrong login cannot reveal the store',async({page})=>{await page.goto('/products');await expect(page.locator('.auth-panel h1')).toHaveText(t.login);await expect(page.locator('.product-card')).toHaveCount(0);await page.screenshot({path:'docs/evidence/login-desktop.png',fullPage:true});for(const language of LANGUAGES){await page.locator('.preferences select').first().selectOption(language);await expect(page.locator('.auth-panel h1')).toHaveText(dictionaries[language].login);await expect(page.locator('main')).toContainText(dictionaries[language].loginFirst);await expect(page.locator('main')).not.toContainText('undefined');}await page.locator('.preferences select').first().selectOption('zh');await page.getByLabel(t.email,{exact:true}).fill('browse@example.test');await page.getByLabel(t.password,{exact:true}).fill('incorrect-test-password');await page.locator('form').getByRole('button',{name:t.login,exact:true}).click();await expect(page.locator('.auth-panel .error[role=alert]')).toBeVisible();await expect(page.locator('.auth-panel h1')).toHaveText(t.login);await expect(page.locator('.product-card')).toHaveCount(0);const session=await page.request.get('/api/v1/session');expect((await session.json()).customer).toBeNull();for(const [width,height]of [[820,1180],[390,844]]){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}await page.getByLabel(t.email,{exact:true}).clear();await page.getByLabel(t.password,{exact:true}).clear();await page.screenshot({path:'docs/evidence/login-mobile.png',fullPage:true});await page.goto('/admin');await expect(page.locator('.auth-panel h1')).toHaveText(t.admin+' · '+t.login);await expect(page.locator('.admin-sidebar')).toHaveCount(0);});

test('N09 English purchase filename stays English after language change; same email logs in and downloads again',async({page})=>{await enter(page);const englishName=(await(await management.get('/api/v1/products/sage-strategy')).json()).downloadNames.en;await buy(page,'history@example.test','en');await page.getByRole('button',{name:dictionaries.en.payNow,exact:true}).click();await expect(page.getByRole('button',{name:new RegExp(dictionaries.en.download)})).toBeVisible();const orderUrl=page.url(),firstPromise=page.waitForEvent('download');await page.getByRole('button',{name:new RegExp(dictionaries.en.download)}).click();const first=await firstPromise;expect(first.suggestedFilename()).toBe(englishName);await page.locator('.preferences select').first().selectOption('zh');await page.goto('/account');await expect(page.locator('.recovered-order')).toHaveCount(1);await page.getByRole('button',{name:t.logout,exact:true}).click();await page.getByLabel(t.email,{exact:true}).fill('history@example.test');await page.getByLabel(t.password,{exact:true}).fill('browser-test-passphrase');await page.locator('form').getByRole('button',{name:t.login,exact:true}).click();await expect(page.locator('.hero h1')).toBeVisible();await page.goto('/account');await expect(page.locator('.recovered-order')).toHaveCount(1);await page.locator('.recovered-order').click();await expect(page).toHaveURL(orderUrl);const againPromise=page.waitForEvent('download');await page.getByRole('button',{name:/下载模板/}).click();const again=await againPromise;expect(again.suggestedFilename()).toBe(first.suggestedFilename());});


test('N19 currency price sorting and limits persist; storefront has no admin or test controls',async({page})=>{
  await enter(page);await page.goto('/products');await page.getByLabel(t.sort,{exact:true}).selectOption('asc');
  const products=await(await management.get('/api/v1/products?currency=CNY&priceSort=asc')).json();
  await expect(page.locator('.product-card')).toHaveCount(products.length);await expect(page).toHaveURL(/priceSort=asc/);
  const amounts=products.map((p:any)=>p.prices.find((v:any)=>v.currency==='CNY').amount);
  await expect(page.locator('.product-card').first().locator('strong')).toContainText((amounts[0]/100).toFixed(2));
  await page.getByLabel(t.minPrice,{exact:true}).fill(String(amounts[0]/100));await page.getByLabel(t.maxPrice,{exact:true}).fill(String(amounts[0]/100));await page.getByRole('button',{name:t.applyFilters,exact:true}).click();
  await expect(page.locator('.product-card')).toHaveCount(amounts.filter((v:number)=>v===amounts[0]).length);await page.reload();await expect(page.getByLabel(t.minPrice,{exact:true})).toHaveValue(String(amounts[0]/100));
  await page.getByRole('button',{name:t.resetFilters,exact:true}).click();await page.getByLabel(t.sort,{exact:true}).selectOption('desc');await expect(page.locator('.product-card')).toHaveCount(products.length);await expect(page.locator('.product-card').first().locator('strong')).toContainText((amounts.at(-1)/100).toFixed(2));
  expect(await page.locator('.preferences select').count()).toBe(2);expect(await page.locator('.preferences button').count()).toBe(0);expect(await page.locator('a[href="/admin"]').count()).toBe(0);expect(await page.locator('.test-note,.mock-panel,.mode-bar').count()).toBe(0);
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe('light');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:'docs/evidence/price-filters-mobile.png',fullPage:true});
});
test('N20 richer overview, logical navigation and private memo status controls',async({page})=>{
  await login(page);await expect(page.locator('.summary-card')).toHaveCount(12);
  await expect(page.locator('.admin-sidebar button').first()).toHaveText(t.dashboard);const navigation=await page.locator('.admin-sidebar button').allTextContents();expect(navigation.slice(0,5)).toEqual([t.dashboard,t.categories,t.productsAdmin,t.trash,t.orders]);
  await page.screenshot({path:'docs/evidence/admin-overview.png',fullPage:true});await page.getByRole('button',{name:t.support,exact:true}).click();await page.getByRole('button',{name:new RegExp(t.newMemo)}).click();await page.getByLabel(t.memoTitle,{exact:true}).fill('本周经营备忘');await page.locator('.memo-editor').getByLabel(t.problemDescription,{exact:true}).fill('整理商品封面与邮件设置');await page.locator('.memo-editor').getByRole('button',{name:t.save,exact:true}).click();
  const memo=page.locator('.memo-detail');await expect(memo.getByLabel(t.memoTitle,{exact:true})).toHaveValue('本周经营备忘');await expect(memo).toContainText(t.unresolved);await memo.getByLabel(t.status,{exact:true}).selectOption('IGNORED');await memo.getByRole('button',{name:t.save,exact:true}).click();await page.locator('.feedback-status').getByRole('button',{name:new RegExp(t.ignored)}).click();await expect(memo).toContainText(t.ignored);await memo.getByLabel(t.status,{exact:true}).selectOption('RESOLVED');await memo.getByRole('button',{name:t.save,exact:true}).click();await page.locator('.feedback-status').getByRole('button',{name:new RegExp(t.resolved)}).click();await expect(memo).toContainText(t.resolved);await page.screenshot({path:'docs/evidence/admin-feedback.png',fullPage:true});
});
test('N21 two browsers exchange persistent messages through SSE without manual refresh',async({page,browser})=>{
  await enter(page);await page.locator('.header nav a[href="/contact"]').click();await expect(page.locator('.chat-connection')).toContainText(t.chatConnected);
  const ownerContext=await browser.newContext({baseURL:'http://localhost:3000'}),owner=await ownerContext.newPage();
  try{await login(owner);await owner.getByRole('button',{name:t.chat,exact:true}).click();await page.locator('.chat-composer textarea').fill('你好，想咨询模板编辑');await expect(page.locator('.chat-composer button.primary')).toContainText(t.sendMessage);await page.locator('.chat-composer button.primary').click();const conversation=owner.locator('.conversation-list button').filter({hasText:'browse@example.test'});await expect(conversation).toBeVisible({timeout:10000});await conversation.click();await expect(owner.locator('.chat-history')).toContainText('你好，想咨询模板编辑');await owner.locator('.chat-composer textarea').fill('您好，模板文字和图表均可编辑');await owner.locator('.chat-composer button.primary').click();await expect(page.locator('.chat-history')).toContainText('您好，模板文字和图表均可编辑',{timeout:10000});await page.reload();await expect(page.locator('.chat-history')).toContainText('您好，模板文字和图表均可编辑');await page.goto('/products');await expect(page.locator('.chat-launcher')).toBeVisible();
    for(const message of ['客服未读回复一','客服未读回复二']){await owner.locator('.chat-composer textarea').fill(message);await owner.locator('.chat-composer button.primary').click();await expect(owner.locator('.chat-composer textarea')).toHaveValue('');}
    await expect(page.locator('.chat-launcher .unread-badge')).toHaveText('2',{timeout:10000});await expect(page.locator('.header a[href="/contact"] .unread-badge')).toHaveText('2');
    await page.reload();await expect(page.locator('.chat-launcher .unread-badge')).toHaveText('2');
    await page.locator('.chat-launcher').click();await expect(page.locator('.chat-drawer .chat-history')).toContainText('客服未读回复二');await expect(page.locator('.header a[href="/contact"] .unread-badge')).toHaveCount(0);
    await page.keyboard.press('Escape');await expect(page.locator('.chat-launcher .unread-badge')).toHaveCount(0);await page.goto('/contact');
    await owner.screenshot({path:'docs/evidence/admin-chat.png',fullPage:true});await page.screenshot({path:'docs/evidence/customer-chat.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:'docs/evidence/chat-mobile.png',fullPage:true});}
  finally{await ownerContext.close();}
});
test('N22 mode is set only in admin settings; normal mode disables purchase',async({page})=>{
  await login(page);await reauth(page);await page.getByRole('button',{name:t.settings,exact:true}).click();await page.getByLabel(t.shopMode,{exact:true}).selectOption('normal');
  try{const response=page.waitForResponse(r=>r.url().endsWith('/admin/settings')&&r.request().method()==='PATCH');await page.locator('.form-panel').getByRole('button',{name:t.save,exact:true}).click();expect((await response).status()).toBe(200);await expect.poll(async()=> (await(await management.get('/api/v1/session')).json()).checkoutEnabled).toBe(false);await page.getByRole('button',{name:t.dashboard,exact:true}).click();await expect(page.locator('.summary-card').filter({hasText:t.ordersCount})).toContainText('0');expect(await page.getByLabel(t.shopMode,{exact:true}).count()).toBe(0);}
  finally{await page.getByRole('button',{name:t.settings,exact:true}).click();await page.getByLabel(t.shopMode,{exact:true}).selectOption('test');await page.locator('.form-panel').getByRole('button',{name:t.save,exact:true}).click();await expect.poll(async()=> (await(await management.get('/api/v1/session')).json()).checkoutEnabled).toBe(true);}
});

test('Customer support drag, persistence, touch and keyboard',async({page})=>{
  await enter(page);
  const button=page.locator('.chat-launcher'),drawer=page.locator('.chat-drawer');
  await expect(button).toBeVisible();
  const initial=(await button.boundingBox())!;
  await page.mouse.move(30,30);await page.waitForTimeout(350);
  expect(await button.boundingBox()).toEqual(initial);
  await button.click();await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);
  const restored=(await button.boundingBox())!;expect(restored).toEqual(initial);
  await page.mouse.move(initial.x+initial.width/2,initial.y+initial.height/2);await page.mouse.down();
  await page.mouse.move(220,250,{steps:15});await page.mouse.up();
  await expect(drawer).toHaveCount(0);const moved=(await button.boundingBox())!;
  expect(moved.x).toBeLessThan(initial.x-100);
  await page.reload();await expect(button).toBeVisible();
  await expect.poll(async()=>Math.round((await button.boundingBox())!.x)).toBe(Math.round(moved.x));
  await button.click();await expect(drawer).toBeVisible();await page.keyboard.press('Escape');
  expect(Math.round((await button.boundingBox())!.x)).toBe(Math.round(moved.x));
  await button.focus();await page.keyboard.press('ArrowLeft');
  expect(Math.round((await button.boundingBox())!.x)).toBe(Math.round(moved.x-16));
  await page.setViewportSize({width:390,height:600});
  const small=(await button.boundingBox())!;expect(small.x).toBeGreaterThanOrEqual(8);expect(small.x+small.width).toBeLessThanOrEqual(382);
  await button.focus();await page.keyboard.press('Home');
  expect(await page.evaluate(()=>localStorage.getItem('workshop-chat-position-v1'))).toBeNull();
  await page.locator('.operation-toast button').evaluateAll(buttons=>buttons.forEach(button=>(button as HTMLButtonElement).click()));
  const reset=(await button.boundingBox())!;expect(Math.round(reset.y+reset.height)).toBe(584);
  const cdp=await page.context().newCDPSession(page);
  const touchX=reset.x+reset.width/2,touchY=reset.y+reset.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchX,y:touchY}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:110,y:320}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(drawer).toHaveCount(0);expect((await button.boundingBox())!.y).toBeLessThan(reset.y-100);
  await page.screenshot({path:'docs/evidence/chat-drag-mobile.png'});
});


test('CHAT-PROFILE Unicode files, account nicknames, unread badges and bidirectional automatic translation',async({page,browser})=>{
  const {createServer}=await import('node:http');
  const service=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({translatedText:input.target+': '+input.q}));});
  await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));
  const address=service.address() as {port:number},context=await browser.newContext(),owner=await context.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));owner.on('pageerror',e=>errors.push(e.message));
  try {
    await enter(page);await page.goto('/account');await page.getByLabel(t.nickname,{exact:true}).fill('小李同学');await page.locator('.account-page form').getByRole('button',{name:t.save,exact:true}).click();await expect(page.locator('.account-identity')).toContainText('小李同学');
    await login(owner);await owner.getByRole('button',{name:t.account,exact:true}).click();await reauth(owner);await owner.getByLabel(t.nickname,{exact:true}).fill('模板顾问');await owner.locator('form.merchant-account').getByRole('button',{name:t.save,exact:true}).click();await expect(owner.locator('.merchant-nickname')).toContainText('模板顾问');
    await owner.locator('.merchant-account select').selectOption('libretranslate');await owner.getByLabel('LibreTranslate URL',{exact:true}).fill('http://127.0.0.1:'+address.port+'/translate');await owner.locator('section.merchant-account form').getByRole('button',{name:t.save,exact:true}).click();await expect(owner.locator('section.merchant-account [role=status]')).toHaveText(t.saved);
    await page.goto('/contact');await page.locator('.preferences select').first().selectOption('en');await expect(page.locator('html')).toHaveAttribute('lang','en');
    await owner.getByRole('button',{name:t.chat,exact:true}).click();const row=owner.locator('.conversation-list>button').filter({hasText:'browse@example.test'});await row.click();await expect(row.locator('.unread-badge')).toHaveCount(0);await owner.getByRole('button',{name:t.account,exact:true}).click();
    for(const message of ['Hello seller one','Hello seller two','Hello seller three']) {await page.locator('.chat-composer textarea').fill(message);await page.locator('.chat-composer button.primary').click();await expect(page.locator('.chat-composer textarea')).toHaveValue('');}
    await expect(owner.locator('.merchant-nickname .unread-badge')).toHaveText('3',{timeout:10000});await expect(owner.locator('.merchant-message-alert')).toBeVisible();
    await owner.locator('.merchant-message-alert').click();await row.click();await expect(owner.locator('.chat-message').filter({hasText:'Hello seller three'}).locator('.chat-nickname')).toHaveText('小李同学');await expect(owner.locator('.merchant-nickname .unread-badge')).toHaveCount(0);
    const incoming=owner.locator('.chat-message').filter({hasText:'Hello seller three'});await expect(incoming.locator('.chat-translation p')).toHaveText('zh: Hello seller three');await expect(incoming.locator('.chat-avatar')).toBeVisible();
    await owner.locator('.chat-composer textarea').fill('您好，已收到您的消息');await owner.locator('.chat-composer button.primary').click();
    const reply=page.locator('.chat-message').filter({hasText:'您好，已收到您的消息'});await expect(reply.locator('.chat-nickname')).toHaveText('模板顾问');await expect(reply.locator('.chat-translation p')).toHaveText('en: 您好，已收到您的消息');await expect(owner.locator('.chat-message.mine').filter({hasText:'您好，已收到您的消息'}).locator('.chat-translation p')).toHaveText('en: 您好，已收到您的消息');
    await page.locator('.chat-composer input[type=file]').setInputFiles({name:'中文资料 😀.txt',mimeType:'text/plain',buffer:Buffer.from('attachment content')});await expect(page.locator('.chat-pending-name')).toHaveText('中文资料 😀.txt');await page.locator('.chat-composer button.primary').click();await expect(owner.locator('.chat-attachment-meta strong')).toContainText(['中文资料 😀.txt']);
    await owner.screenshot({path:'docs/evidence/chat-profile-admin.png',fullPage:true});await page.screenshot({path:'docs/evidence/chat-profile-customer.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:'docs/evidence/chat-profile-mobile.png',fullPage:true});expect(errors).toEqual([]);
  } finally {await context.close();await new Promise<void>(resolve=>service.close(()=>resolve()));}
});
