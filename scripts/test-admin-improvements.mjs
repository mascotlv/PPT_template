import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { root } from './common.mjs';
import { fixture } from './fixture.mjs';
const require = createRequire(import.meta.url);
const { createApp } = require('../backend/dist/app');
const { BrowserSession } = require('../backend/test/integration.cjs');
const OTPAuth = require('../backend/node_modules/otpauth');
let f, server;
try {
    f = await fixture('integration', 55433);
    f.config.STORE_ACCESS_MODE = 'account';
    server = await createApp(f.config); await server.app.listen(0, '127.0.0.1');
    const admin = await new BrowserSession(await server.app.getUrl(), f.config).init(); await admin.login(f.admin);
    const credentials = () => ({ email: f.admin.email, password: f.admin.password, code: new OTPAuth.TOTP({secret: OTPAuth.Secret.fromBase32(f.admin.secret)}).generate() });
    const dashboard = await admin.call('/admin/dashboard'); assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.storage.maxBytes, 400 * 1024 ** 3);
    assert.ok(dashboard.data.storage.categories.database > 0);
    assert.equal(dashboard.data.storage.usedBytes, Object.values(dashboard.data.storage.categories).reduce((a,b)=>a+b,0));
    console.log('PASS storage totals, database and 400 GiB quota');
    const job = await f.db.job.create({data:{kind:'MAIL',relatedId:'test',idempotencyKey:'admin-improvements',payload:{},status:'FAILED',attempts:8}});
    assert.equal((await admin.call('/admin/jobs/run-all','POST',{})).status,201);
    const queued = await f.db.job.findUniqueOrThrow({where:{id:job.id}}); assert.equal(queued.status,'PENDING'); assert.equal(queued.attempts,0);
    console.log('PASS all failed tasks queued');
    const memo = await admin.call('/admin/support','POST',{title:'Saved note',content:'Original note'});
    assert.equal((await admin.call('/admin/support/'+memo.data.id,'PATCH',{title:'Edited note',content:'Edited content',reply:'',status:'RESOLVED'})).status,200);
    const buyer = await new BrowserSession(await server.app.getUrl(), f.config).init(); await buyer.register(f.db,'improvements-buyer@example.test');
    const product = await f.db.product.findFirstOrThrow();
    const quote = await buyer.call('/quotes/'+product.id+'?currency=CNY');
    const order = await buyer.call('/orders','POST',{productId:product.id,email:buyer.email,currency:'CNY',language:'zh',quoteToken:quote.data.quoteToken,idempotencyKey:'admin-improvements-order',termsVersion:'demo-v1'}); assert.equal(order.status,201);
    const ticket = await buyer.call('/orders/'+order.data.id+'/support','POST',{content:'Please help with this order'});
    assert.equal((await admin.call('/admin/support/'+ticket.data.id,'PATCH',{title:'Customer help',content:'Edited customer issue',reply:'Your issue has been fixed',status:'RESOLVED'})).status,200);
    assert.equal((await buyer.call('/orders/'+order.data.id)).data.tickets[0].reply,'Your issue has been fixed');
    console.log('PASS saved feedback editing and customer reply visibility');
    await admin.call('/admin/products/'+product.id,'DELETE');
    assert.equal((await buyer.call('/admin/products/'+product.id+'/purge','POST', {})).status,401);
    const support = await new BrowserSession(await server.app.getUrl(), f.config).init(); await support.login(f.support);
    assert.equal((await support.call('/admin/products/'+product.id+'/purge','POST', {})).status,403);
    const blocked = await admin.call('/admin/products/'+product.id+'/purge','POST',{}); assert.equal(blocked.status,400); assert.equal(blocked.data.code,'PRODUCT_HAS_ORDERS');
    assert.equal((await admin.call('/admin/maintenance/cleanup','POST', {...credentials(),code:'invalid'})).status,401);
    assert.equal((await admin.call('/admin/maintenance/cleanup','POST', {...credentials(),email:'other@example.test'})).status,401);
    console.log('PASS single-product purge requires administrator session, no reauthentication; bulk deletion requires credentials');
    const removable = await f.db.product.findFirstOrThrow({where:{id:{not:product.id}},include:{versions:true}});
    const { LocalStorage } = require('../backend/dist/storage/local'); const storage = new LocalStorage(f.config.STORAGE_ROOT,f.config.PURCHASE_ROOT);
    const originalPath = storage.resolve(removable.versions[0].key); await fs.access(originalPath);
    await admin.call('/admin/products/'+removable.id,'DELETE');
    assert.equal((await admin.call('/admin/products/'+removable.id+'/purge','POST',{})).status,201);
    assert.equal(await f.db.product.count({where:{id:removable.id}}),0);
    await assert.rejects(fs.access(originalPath));
    console.log('PASS unpurchased product and original permanently removed');
    const { assertStorageCapacity } = require('../backend/dist/storage/maintenance');
    await assert.rejects(assertStorageCapacity({...server.shop,db:f.db,config:{...f.config,STORAGE_MAX_BYTES:1}},1), e=>e.getResponse().code==='STORAGE_QUOTA_REACHED');
    console.log('PASS storage budget enforced');
    const { cleanRuntimeFiles } = require('../backend/dist/storage/maintenance');
    const runtime = path.join(f.config.STORAGE_ROOT, 'isolated-runtime'); await fs.mkdir(runtime);
    await fs.writeFile(path.join(runtime,'example.log'),'old log'); await fs.writeFile(path.join(runtime,'example.tmp'),'temp'); await fs.writeFile(path.join(runtime,'keep.json'),'business data');
    // For this helper test, business roots are elsewhere and no real runtime log is touched.
    const result = await cleanRuntimeFiles({config:{STORAGE_ROOT:path.join(runtime,'private'),PURCHASE_ROOT:path.join(runtime,'purchases')}}, runtime);
    assert.equal(result.removedFiles,2); assert.equal(result.failedFiles,0); assert.equal(await fs.readFile(path.join(runtime,'keep.json'),'utf8'),'business data');
    console.log('PASS isolated cleanup removes only logs and temporary files');
    const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    try {
        const context = await browser.newContext({viewport:{width:1440,height:1000}});
        const base = await server.app.getUrl();
        await context.route('**/api/v1/**',async route=>{const url=new URL(route.request().url());try { const response=await route.fetch({url:base+url.pathname+url.search});await route.fulfill({response}); } catch { await route.abort().catch(()=>{}); }});
        const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
        const t=require('../backend/dist/commerce/dictionaries').dictionaries.zh;
        await page.goto('http://localhost:3000/admin');
        // Fixture storefront uses a test-access gate.
        if (await page.locator('input[type=password]').count()===1 && !await page.getByLabel(t.email,{exact:true}).count()) {
            await page.locator('input[type=password]').fill(f.config.TEST_ACCESS_PASSWORD);await page.locator('form button[type=submit],form button.primary').first().click();
        }
        await page.getByLabel(t.email,{exact:true}).fill(f.admin.email);await page.getByLabel(t.password,{exact:true}).fill(f.admin.password);await page.getByLabel(t.code,{exact:true}).fill(credentials().code);await page.getByRole('button',{name:t.login,exact:true}).click();
        await page.locator('.admin-sidebar').getByRole('button',{name:t.orders,exact:true}).click();
        await page.locator('.management-filters').waitFor();
        const end=page.locator('input[type=datetime-local]').nth(1);assert.ok(await end.inputValue());
        assert.ok(await page.locator('.date-filter input').first().evaluate(e=>e.getBoundingClientRect().width>=290));
        assert.equal(await page.locator('.management-filters label').first().evaluate(e=>getComputedStyle(e).textAlign),'center');
        await fs.mkdir(path.join(root,'docs/evidence'),{recursive:true});await page.screenshot({path:path.join(root,'docs/evidence/admin-improvements-orders.png'),fullPage:true});
        await page.locator('.admin-sidebar').getByRole('button',{name:t.dashboard,exact:true}).click();
        await page.locator('.admin-sidebar').getByRole('button',{name:t.orders,exact:true}).click();
        await page.locator('.management-filters').waitFor();assert.ok(await end.inputValue());
        await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('.management-filters').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
        assert.equal(errors.length,0);console.log('PASS desktop/mobile order fields, centered labels and page reentry');
    } finally { await browser.close(); }
    const before = await f.db.order.count();
    assert.equal((await admin.call('/admin/maintenance/clear-business','POST',{...credentials(),password:'wrong'})).status,401);
    assert.equal(await f.db.order.count(),before);
    const reset = await admin.call('/admin/maintenance/clear-business','POST',credentials());
    assert.equal(reset.status,201,JSON.stringify(reset.data));assert.equal(reset.data.failedFiles,0);
    for(const name of ['product','category','order','payment','customer','supportTicket','chatMessage','job','mailMessage','fileVersion','analyticsEvent']) assert.equal(await f.db[name].count(),0,name);
    assert.ok(await f.db.admin.count());assert.equal((await admin.call('/admin/dashboard')).status,200);
    async function fileCount(folder) { let count=0; for(const entry of await fs.readdir(folder,{withFileTypes:true})) count+=entry.isDirectory()?await fileCount(path.join(folder,entry.name)):1;return count; }
    assert.equal(await fileCount(f.config.STORAGE_ROOT),0);assert.equal(await fileCount(f.config.PURCHASE_ROOT),0);
    console.log('PASS authenticated full business reset clears records/files and preserves administrator access');

} finally {
    await server?.app.close(); await server?.db.$disconnect(); await f?.stop();
}

