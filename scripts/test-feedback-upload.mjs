import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {chromium} from '@playwright/test';
import {root} from './common.mjs';
import {fixture} from './fixture.mjs';

// Uses the running production frontend with browser API traffic directed to a
// disposable backend/database. Business storage and credentials are never used.
const require=createRequire(import.meta.url),{createApp}=require('../backend/dist/app');
const {LocalStorage,validateUpload}=require('../backend/dist/storage/local');
const {BrowserSession}=require('../backend/test/integration.cjs');
const {zipSync,unzipSync}=require('../backend/node_modules/fflate');
const OTPAuth=require('../backend/node_modules/otpauth');
const dictionaries=require('../backend/dist/commerce/dictionaries').dictionaries,t=dictionaries.zh;
const origin='http://localhost:3000',mime='application/vnd.openxmlformats-officedocument.presentationml.presentation';
const report={date:new Date().toISOString(),scope:'Running production frontend, browser API routed to isolated backend/database/storage; no business data modified',checks:[],status:'FAIL'};
let f,server,browser,base,page,large,seedBytes,product;const pageErrors=[];
function largeDeck(seed,megabytes){const entries=unzipSync(seed);entries['[Content_Types].xml']=Buffer.from(Buffer.from(entries['[Content_Types].xml']).toString('utf8').replace('</Types>','<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));return Buffer.from(zipSync({...entries,'ppt/media/large.bin':[randomBytes(megabytes*1024*1024),{level:0}]}));}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=async(name,action)=>{report.currentCheck=name;delete report.currentStep;await action();report.checks.push(name);console.log('PASS '+name);};

async function shot(name){await page.screenshot({path:path.join(root,'docs/evidence',name+'.png'),fullPage:true});}
try{
  report.currentCheck='Initialize fixture';f=await fixture('browser',55434);report.currentCheck='Start isolated backend';server=await createApp(f.config);await server.app.listen(0,'127.0.0.1');base=await server.app.getUrl();
  report.currentCheck='Read fixture product';product=await f.db.product.findFirstOrThrow({include:{category:true,versions:{orderBy:{createdAt:'desc'}}}});
  seedBytes=await fs.readFile(new LocalStorage(f.config.STORAGE_ROOT,f.config.PURCHASE_ROOT).resolve(product.versions[0].key));
  report.currentCheck='Create related fixture order';const buyer=await new BrowserSession(base,f.config).init(false);await buyer.register(f.db,'feedback-buyer@example.test');const quote=await buyer.call('/quotes/'+product.id+'?currency=CNY');const order=await buyer.call('/orders','POST',{quoteToken:quote.data.quoteToken,productId:product.id,email:buyer.email,language:'zh',currency:'CNY',termsVersion:'demo-v1',idempotencyKey:randomUUID()});assert.equal(order.status,201);
  report.currentCheck='Seed feedback fixture';for(const data of [{title:'Download assistance',orderId:order.data.id,content:'Please help with my presentation download.',status:'OPEN'},{title:'Completed request',source:'MEMO',content:'Previous request resolved.',status:'RESOLVED'},{title:'Duplicate note',source:'MEMO',content:'Archived duplicate.',status:'IGNORED'}])await f.db.supportTicket.create({data});
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/api/v1/**',async route=>{const url=new URL(route.request().url());try{const response=await route.fetch({url:base+url.pathname+url.search,timeout:120000});await route.fulfill({response});}catch{await route.abort().catch(()=>{});}});page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors.push('Browser page error'));
  await record('Administrator logs in through production UI with isolated API',async()=>{
    await page.goto(origin+'/admin');await page.getByLabel(t.email,{exact:true}).fill(f.admin.email);await page.getByLabel(t.password,{exact:true}).fill(f.admin.password);await page.getByLabel(t.code).fill(new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(f.admin.secret)}).generate());
    await page.locator('form').getByRole('button',{name:new RegExp(t.login)}).click();await page.getByRole('heading',{name:t.dashboard,exact:true}).waitFor();await page.locator('.admin-sidebar').getByRole('button',{name:t.support,exact:true}).click();await page.locator('.feedback-item').waitFor();
  });
  await record('Feedback master/detail layout and customer reply persist',async()=>{
    const left=await page.locator('.feedback-inbox').boundingBox(),right=await page.locator('.feedback-detail').boundingBox();assert.ok(left.x+left.width<right.x);assert.equal(await page.locator('.feedback-item').count(),1);
    await page.locator('.feedback-item').getByLabel(t.reply,{exact:true}).fill('Download instructions sent.');await page.locator('.feedback-item').getByRole('button',{name:t.save,exact:true}).click();await page.getByRole('status').getByText(t.saved,{exact:true}).waitFor();assert.equal((await f.db.supportTicket.findFirstOrThrow({where:{title:'Download assistance'}})).reply,'Download instructions sent.');
  });
  let memo;
  await record('Create memo defaults to open and is selected in detail pane',async()=>{
    await page.getByRole('button',{name:new RegExp(t.newMemo)}).click();await page.locator('.memo-editor').getByLabel(t.memoTitle,{exact:true}).fill('Prepare next collection');await page.locator('.memo-editor').getByLabel(t.description,{exact:true}).fill('Review previews and upload the new original file.');await page.locator('.memo-editor').getByRole('button',{name:t.save,exact:true}).click();await page.locator('.feedback-item h2').getByText('Prepare next collection',{exact:true}).waitFor();memo=await f.db.supportTicket.findFirstOrThrow({where:{title:'Prepare next collection'}});assert.equal(memo.status,'OPEN');assert.equal(memo.source,'MEMO');
  });
  await record('Memo notes and resolved/ignored filters persist',async()=>{
    report.currentStep='Fill memo note';await page.locator('.feedback-item').getByLabel(t.memo,{exact:true}).fill('Check typography on Monday.');await page.locator('.feedback-item').getByLabel(t.status,{exact:true}).selectOption('RESOLVED');report.currentStep='Save resolved memo';await page.locator('.feedback-item').getByRole('button',{name:t.save,exact:true}).click();report.currentStep='Filter resolved memos';await page.locator('.feedback-status [data-status=RESOLVED]').click();report.currentStep='Select matching memo';await page.locator('.feedback-ticket').filter({hasText:'Prepare next collection'}).click();await page.locator('.feedback-item').getByLabel(t.memo,{exact:true}).waitFor();assert.equal(await page.locator('.feedback-item textarea').inputValue(),'Check typography on Monday.');assert.equal((await f.db.supportTicket.findUniqueOrThrow({where:{id:memo.id}})).status,'RESOLVED');
    await page.locator('.feedback-item').getByLabel(t.status,{exact:true}).selectOption('IGNORED');await page.locator('.feedback-item').getByRole('button',{name:t.save,exact:true}).click();await page.locator('.feedback-status [data-status=IGNORED]').click();await page.locator('.feedback-ticket').filter({hasText:'Prepare next collection'}).click();assert.equal((await f.db.supportTicket.findUniqueOrThrow({where:{id:memo.id}})).status,'IGNORED');
  });
  await record('Search, empty state, cancel memo, desktop and mobile layout',async()=>{
    await page.locator('.feedback-status [data-status=ALL]').click();await page.locator('.feedback-search input').fill('Prepare next');assert.equal(await page.locator('.feedback-ticket').count(),1);await shot('feedback-desktop');await page.locator('.feedback-search input').fill('no-matching-issue-zz');assert.equal(await page.locator('.feedback-ticket').count(),0);await page.locator('.feedback-empty-detail').waitFor();await page.locator('.feedback-search input').fill('');await page.getByRole('button',{name:new RegExp(t.newMemo)}).click();await page.locator('.memo-editor').getByRole('button',{name:t.cancel,exact:true}).click();assert.equal(await page.locator('.memo-editor').count(),0);
    await page.setViewportSize({width:390,height:844});const left=await page.locator('.feedback-inbox').boundingBox(),right=await page.locator('.feedback-detail').boundingBox();assert.ok(right.y>=left.y+left.height);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('feedback-mobile');await page.setViewportSize({width:1440,height:1000});
  });
  await record('English and Arabic feedback controls translate and fit',async()=>{
    await page.locator('.preferences select').first().selectOption('en');await page.locator('.feedback-search').getByText(dictionaries.en.search,{exact:true}).waitFor();await page.locator('.preferences select').first().selectOption('ar');await page.locator('.feedback-search').getByText(dictionaries.ar.search,{exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('feedback-arabic');await page.locator('.preferences select').first().selectOption('zh');
  });
  await record('24 MiB PPTX uploads from browser and completes after 16 seconds',async()=>{
    large=largeDeck(seedBytes,24);assert.ok(large.length>20*1024*1024);report.browserUploadBytes=large.length;
    // Delay only the isolated handler response. XHR must survive the previous 15s
    // frontend deadline. Browser uploads target only the isolated backend.
    const replace=server.shop.audit.bind(server.shop);server.shop.audit=async(...args)=>{const result=await replace(...args);if(args[2]==='FILE_REPLACE')await new Promise(resolve=>setTimeout(resolve,16000));return result;};
    await page.locator('.admin-sidebar').getByRole('button',{name:t.productsAdmin,exact:true}).click();await page.locator('.admin-product-list article').filter({hasText:product.slug}).getByRole('button',{name:t.edit,exact:true}).click();await page.locator('.reauth summary').click();await page.locator('.reauth').getByLabel(t.password,{exact:true}).fill(f.admin.password);await page.locator('.reauth').getByLabel(t.code).fill(new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(f.admin.secret)}).generate());const auth=page.waitForResponse(r=>r.url().endsWith('/admin/reauth')&&r.status()===201);await page.locator('.reauth').getByRole('button',{name:t.verify,exact:true}).click();await auth;
    const started=performance.now(),response=page.waitForResponse(r=>r.url().endsWith('/current-file')&&r.request().method()==='POST',{timeout:90000}).catch(()=>null);report.currentStep='Set large file and wait for progress';await page.locator('.editor input[type=file]').setInputFiles({name:'large-upload.pptx',mimeType:mime,buffer:large});await page.getByRole('progressbar').waitFor();report.currentStep='Wait for upload response';const result=await response;assert.ok(result);report.uploadHttpStatus=result.status();assert.equal(result.status(),201);report.currentStep='Verify successful filename and stored bytes';await page.locator('.editor .drop-zone').getByText(product.titleZh+'.pptx',{exact:true}).waitFor();assert.ok(performance.now()-started>=16000);report.browserUploadElapsedMs=Math.round(performance.now()-started);await page.getByRole('progressbar').waitFor({state:'detached'});server.shop.audit=replace;
    const version=await f.db.fileVersion.findFirstOrThrow({where:{productId:product.id},orderBy:{createdAt:'desc'}});assert.equal(version.size,large.length);assert.equal(version.sha256,sha(large));const storage=new LocalStorage(f.config.STORAGE_ROOT,f.config.PURCHASE_ROOT);assert.equal(sha(await fs.readFile(storage.resolve(storage.currentKey(product.category.nameZh,product.titleZh)))),sha(large));
  });
  const admin=await new BrowserSession(base,f.config).init(false);await admin.login(f.admin);await admin.reauth(f.admin);
  await record('90 MiB media PPTX bypasses old archive caps; current file replaced, old original preserved',async()=>{
    const bytes=largeDeck(seedBytes,90);report.largeUploadBytes=bytes.length;const form=new FormData();form.append('kind','original');form.append('file',new Blob([bytes],{type:mime}),'larger-upload.pptx');const previous=await f.db.fileVersion.findFirstOrThrow({where:{productId:product.id},orderBy:{createdAt:'desc'}});const r=await admin.call('/admin/products/'+product.id+'/current-file','POST',form);assert.equal(r.status,201);const storage=new LocalStorage(f.config.STORAGE_ROOT,f.config.PURCHASE_ROOT);assert.equal(sha(await fs.readFile(path.join(f.config.PURCHASE_ROOT,r.data.path))),sha(bytes));assert.equal(sha(await fs.readFile(storage.resolve(previous.key))),sha(large));assert.equal(await f.db.audit.count({where:{action:'FILE_REPLACE'}}),2);assert.equal((await f.db.orderItem.findFirstOrThrow({where:{orderId:order.data.id}})).fileVersionId,product.versions[0].id);
  });
  await record('Invalid files, unsafe archives and oversized previews still rejected',async()=>{
    for(const entries of [ {'../escape.txt':new Uint8Array([1])},{'_rels/.rels':Buffer.from('<Relationships><Relationship TargetMode="External"/></Relationships>')},{'ppt/vbaProject.bin':new Uint8Array([1])},{'ppt/media/bomb.bin':new Uint8Array(1024*1024)} ]){const bytes=Buffer.from(zipSync({...unzipSync(seedBytes),...entries}));await assert.rejects(()=>validateUpload({buffer:bytes,originalname:'unsafe.pptx',mimetype:mime,size:bytes.length},'original'));}
    await assert.rejects(()=>validateUpload({buffer:Buffer.alloc(1),originalname:'image.png',mimetype:'image/png',size:21*1024*1024},'preview'));const form=new FormData();form.append('kind','original');form.append('file',new Blob(['invalid file'],{type:mime}),'invalid.pptx');assert.equal((await admin.call('/admin/products/'+product.id+'/current-file','POST',form)).status,400);assert.equal(await f.db.audit.count({where:{action:'FILE_REPLACE'}}),2);
  });
  await record('Upload still requires administrator CSRF and recent verification',async()=>{
    const form=()=>{const f=new FormData();f.append('kind','original');f.append('file',new Blob([seedBytes],{type:mime}),'safe.pptx');return f;};assert.equal((await admin.call('/admin/products/'+product.id+'/current-file','POST',form(),{'X-CSRF-Token':''})).status,403);const fresh=await new BrowserSession(base,f.config).init(false);await fresh.login(f.admin);const denied=await fresh.call('/admin/products/'+product.id+'/current-file','POST',form());assert.equal(denied.status,403);assert.equal(denied.data.code,'REAUTH_REQUIRED');const support=await new BrowserSession(base,f.config).init(false);await support.login(f.support);assert.equal((await support.call('/admin/products/'+product.id+'/current-file','POST',form())).status,403);assert.deepEqual(pageErrors,[]);
  });
  report.status='PASS';delete report.currentCheck;
}catch(error){if(page&&await page.locator('.feedback-workbench').count())await page.locator('.feedback-workbench').screenshot({path:path.join(root,'docs/evidence/feedback-failure.png')}).catch(()=>{});report.failureType=error?.name||'UnknownError';report.failureSummary=String(error?.message||'').split('\n')[0];for(const value of [f?.admin?.password,f?.admin?.secret,f?.config?.DATABASE_URL])if(value)report.failureSummary=report.failureSummary.replaceAll(value,'[redacted]');report.failureCode=error?.code;report.failureModel=error?.meta?.modelName;process.exitCode=1;console.error('Feedback/upload check failed; private request details withheld.');}
finally{
  await browser?.close();
  await server?.app.close();await server?.db.$disconnect();await f?.stop();await fs.writeFile(path.join(root,'docs/evidence/feedback-upload.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(report.status==='PASS'?0:1);
}
