import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';
import {root,taskEnv} from './common.mjs';
import {fixture} from './fixture.mjs';

const require=createRequire(import.meta.url);
const {createApp}=require('../backend/dist/app');
const {decrypt}=require('../backend/dist/security');
const OTPAuth=require('../backend/node_modules/otpauth');
const t=require('../backend/dist/commerce/dictionaries').dictionaries.zh;
const origin='http://localhost:3000';
const checkIdle=process.argv.includes('--idle');
const report={date:new Date().toISOString(),scope:'Current frontend build with isolated backend/database; no business account changes',checks:[],status:'FAIL'};
let f,server,browser,closing=false,staleLoginRequests=0,invalidLoginOrigin=false;const closingContexts=new WeakSet(),routingFailures=[];
const record=async(name,action)=>{report.currentCheck=name;await action();report.checks.push(name);console.log('PASS '+name);};
try{
  await record('Running frontend refuses rebuild without changing BUILD_ID',async()=>{
    const file=path.join(root,'frontend/.next/BUILD_ID'),digest=async()=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const before=await digest();
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts/frontend-build.mjs')],{cwd:root,env:taskEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('exit',code=>resolve({code,output}));});
    assert.equal(result.code,1);assert.match(result.output,/3000/);assert.equal(await digest(),before);
  });
  report.currentCheck='Initialize isolated database and backend';f=await fixture('browser',55434);server=await createApp(f.config);await server.app.listen(0,'127.0.0.1');const base=await server.app.getUrl();
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  async function isolatedContext(){const context=await browser.newContext();await context.route('**/api/v1/**',async route=>{try{const url=new URL(route.request().url()),headers={...route.request().headers()};if(url.pathname==='/api/v1/account/login'&&route.request().method()==='POST'){if(staleLoginRequests>0){staleLoginRequests--;headers['x-csrf-token']='deliberately-stale';}if(invalidLoginOrigin)headers.origin='https://untrusted.example.test';}const response=await route.fetch({url:base+url.pathname+url.search,headers});await route.fulfill({response});}catch{if(!closing&&!closingContexts.has(context))routingFailures.push('Isolated API routing failed');await route.abort().catch(()=>{});}});return context;}
  const context=await isolatedContext();
  const page=await context.newPage();page.setDefaultTimeout(15000);
  const pageErrors=[];page.on('pageerror',()=>pageErrors.push('page error'));
  async function submit(route,expected){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+route&&r.request().method()==='POST');await page.locator('form').first().locator('button[type=submit],button.primary').last().click();const r=await response;assert.equal(r.status(),expected);return r.json();}
  const email='login-repair-buyer@example.test',password='Login-repair-buyer-2026!';
  await record('Buyer registration and email verification through current UI',async()=>{
    report.currentStep='Open registration';await page.goto(origin+'/account');await page.getByRole('button',{name:t.register,exact:true}).click();await page.getByLabel(t.name,{exact:true}).fill('Login Repair Buyer');await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill(password);report.currentStep='Submit registration';await submit('/account/register',201);
    report.currentStep='Wait for unverified account';await page.getByText(t.verificationRequired,{exact:true}).waitFor();
    const customer=await f.db.customer.findUniqueOrThrow({where:{email}}),job=await f.db.job.findFirstOrThrow({where:{kind:'ACCOUNT',relatedId:customer.id},orderBy:{createdAt:'desc'}}),token=decrypt(job.payload.encryptedToken,f.config.ADMIN_ENCRYPTION_KEY);
    report.currentStep='Open verification link in same account tab';await page.goto(origin+'/account#token='+encodeURIComponent(token)+'&kind=VERIFY');await page.getByRole('button',{name:t.confirm,exact:true}).click();report.currentStep='Wait for verified account';await page.getByText(t.verified,{exact:true}).waitFor();report.currentStep='Log out buyer';await page.getByRole('button',{name:t.logout,exact:true}).click();await page.getByLabel(t.email,{exact:true}).waitFor();delete report.currentStep;
  });
  await record('Unregistered buyer displays the specific registration error',async()=>{await page.getByLabel(t.email,{exact:true}).fill('missing-login-repair@example.test');await page.getByLabel(t.password,{exact:true}).fill(password);const b=await submit('/account/login',401);assert.equal(b.code,'INVALID_CREDENTIALS');await page.locator('.error').getByText(t.invalidLogin,{exact:true}).waitFor();});
  await record('Wrong buyer password displays the specific password error',async()=>{await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill('Deliberately-wrong-buyer-password!');const b=await submit('/account/login',401);assert.equal(b.code,'INVALID_CREDENTIALS');await page.locator('.error').getByText(t.invalidLogin,{exact:true}).waitFor();});
  if(checkIdle){
    async function logoutBuyer(){await page.goto(origin+'/account');await page.getByRole('button',{name:t.logout,exact:true}).click();await page.getByLabel(t.email,{exact:true}).waitFor();}
    await record('Changed login cookie refreshes automatically without resetting entered fields',async()=>{await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill(password);await context.clearCookies();await submit('/account/login',201);await page.waitForURL(origin+'/');await page.locator('.product-card').first().waitFor();await logoutBuyer();});
    await record('CSRF rejection during login recovers once and succeeds',async()=>{
      await page.getByLabel(t.password,{exact:true}).fill(password);const statuses=[];const observe=r=>{if(new URL(r.url()).pathname==='/api/v1/account/login'&&r.request().method()==='POST')statuses.push(r.status());};page.on('response',observe);staleLoginRequests=1;
      try{const success=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/account/login'&&r.status()===201);await page.locator('form').getByRole('button',{name:new RegExp(t.login)}).click();await success;await page.waitForURL(origin+'/');assert.deepEqual(statuses,[403,201]);await logoutBuyer();}finally{page.off('response',observe);staleLoginRequests=0;}
    });
    await record('Incorrect Origin stays rejected with only one retry and no login handler execution',async()=>{
      await page.getByLabel(t.password,{exact:true}).fill(password);const statuses=[];const observe=r=>{if(new URL(r.url()).pathname==='/api/v1/account/login'&&r.request().method()==='POST')statuses.push(r.status());};page.on('response',observe);invalidLoginOrigin=true;
      const key=createHash('sha256').update('customer-login:127.0.0.1:'+email).digest('hex'),before=await f.db.rateLimit.findUnique({where:{key}});assert.ok(before);
      try{await page.locator('form').getByRole('button',{name:new RegExp(t.login)}).click();await page.locator('.error').getByText(t.csrfError,{exact:true}).waitFor();assert.deepEqual(statuses,[403,403]);assert.equal((await f.db.rateLimit.findUniqueOrThrow({where:{key}})).count,before.count);}finally{page.off('response',observe);invalidLoginOrigin=false;}
    });
    await record('Real five-minute idle preserves login inputs and submits successfully',async()=>{
      await page.getByLabel(t.email,{exact:true}).fill(email);await page.getByLabel(t.password,{exact:true}).fill(password);console.log('Real idle observation started: 301 seconds, no page interactions.');const started=performance.now();await page.waitForTimeout(301000);const elapsed=performance.now()-started;assert.ok(elapsed>=300000);assert.equal(await page.getByLabel(t.email,{exact:true}).inputValue(),email);assert.equal(await page.getByLabel(t.password,{exact:true}).inputValue(),password);await submit('/account/login',201);await page.waitForURL(origin+'/');await page.locator('.product-card').first().waitFor();report.idleMeasuredMs=Math.round(elapsed);await logoutBuyer();
    });
  }
  await record('Verified buyer logs in and enters the storefront',async()=>{await page.getByLabel(t.password,{exact:true}).fill(password);await submit('/account/login',201);await page.waitForURL(origin+'/');await page.locator('.product-card').first().waitFor();await page.goto(origin+'/account');await page.getByRole('button',{name:t.logout,exact:true}).click();});
  await record('Verification in a new browser session returns to a working login form',async()=>{
    const customer=await f.db.customer.findUniqueOrThrow({where:{email}}),token=randomBytes(32).toString('hex');await f.db.customerToken.create({data:{customerId:customer.id,kind:'VERIFY',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+60000)}});
    const visitor=await isolatedContext(),verifyPage=await visitor.newPage();verifyPage.setDefaultTimeout(15000);
    try{await verifyPage.goto(origin+'/account#token='+token+'&kind=VERIFY');await verifyPage.getByRole('button',{name:t.confirm,exact:true}).click();await verifyPage.getByLabel(t.email,{exact:true}).fill(email);await verifyPage.getByLabel(t.password,{exact:true}).fill(password);const response=verifyPage.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/v1/account/'));await verifyPage.locator('form').getByRole('button',{name:new RegExp(t.login)}).click();const result=await response;assert.equal(new URL(result.url()).pathname,'/api/v1/account/login');assert.equal(result.status(),201);await verifyPage.waitForURL(origin+'/');await verifyPage.locator('.product-card').first().waitFor();}finally{closingContexts.add(visitor);await visitor.close();}
  });
  await record('Wrong administrator password displays the specific password error',async()=>{await page.goto(origin+'/admin');await page.getByLabel(t.email,{exact:true}).fill(f.admin.email);await page.getByLabel(t.password,{exact:true}).fill('Deliberately-wrong-admin-password!');await page.getByLabel(t.code).fill('not-a-valid-code');const b=await submit('/admin/login',401);assert.equal(b.code,'INVALID_CREDENTIALS');await page.locator('.error').getByText(t.invalidLogin,{exact:true}).waitFor();});
  await record('Wrong administrator verification code displays the specific code error',async()=>{await page.getByLabel(t.password,{exact:true}).fill(f.admin.password);const b=await submit('/admin/login',401);assert.equal(b.code,'INVALID_CREDENTIALS');await page.locator('.error').getByText(t.invalidLogin,{exact:true}).waitFor();});
  await record('Administrator logs in with TOTP and opens the dashboard',async()=>{await page.getByLabel(t.code).fill(new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(f.admin.secret)}).generate());const dashboard=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/admin/dashboard'&&r.status()===200);await submit('/admin/login',201);await dashboard;await page.getByRole('heading',{name:t.dashboard,exact:true}).waitFor();assert.deepEqual(pageErrors,[]);assert.deepEqual(routingFailures,[]);});
  report.status='PASS';delete report.currentCheck;
}catch(error){report.failureType=error?.name||'UnknownError';process.exitCode=1;console.error('Login check failed; credentials and browser call details withheld.');}
finally{closing=true;await browser?.close();await server?.app.close();await server?.db.$disconnect();await f?.stop();await fs.writeFile(path.join(root,'docs/evidence',checkIdle?'login-idle.json':'login-repair.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
