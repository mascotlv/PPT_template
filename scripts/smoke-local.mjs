import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { root, until } from './common.mjs';

const require = createRequire(import.meta.url);
const OTPAuth = require('../backend/node_modules/otpauth/dist/otpauth.node.cjs');
const t = require('../backend/dist/commerce/dictionaries.js').dictionaries.zh;
const origin = 'http://localhost:3000';
const admin = JSON.parse(await fs.readFile(path.join(root, '.runtime/admin-local.json'), 'utf8'));
const report = {
  date: new Date().toISOString(),
  origin,
  backend: 'http://127.0.0.1:4100',
  mode: 'local/mock',
  checks: [],
  status: 'FAIL',
  containerRuntime: 'NOT_RUN',
  externalDeployment: 'NOT_RUN',
};
let browser;
try {
  await until(`${origin}/api/v1/health/ready`);
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src[^;]*'nonce-/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  report.checks.push('frontend production build and backend health in local environment', 'nonce CSP and noindex');

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', () => errors.push('browser page error'));
  await page.goto(origin);
  report.currentCheck = 'buyer login first';
  await page.locator('.auth-panel h1').waitFor();
  assert.equal(await page.locator('.auth-panel h1').innerText(), t.login);
  assert.equal(await page.locator('.product-card').count(), 0);
  assert.equal((await page.request.get(origin+'/api/v1/products')).status(), 401);
  report.checks.push('buyer login shown before storefront');
  await page.goto(origin+'/admin');
  page.on('response', response => {if(['/api/v1/access','/api/v1/admin/login'].some(route=>response.url()===origin+route))report.checks.push('login endpoint '+new URL(response.url()).pathname+' returned '+response.status());});
  report.currentCheck = 'administrator email input';
  await page.getByLabel(t.email, { exact: true }).fill(admin.email);
  report.currentCheck = 'administrator password input';
  await page.getByLabel(t.password, { exact: true }).fill(admin.password);
  report.currentCheck = 'administrator second factor input';
  await page.getByLabel(t.code).fill(new OTPAuth.TOTP({secret: OTPAuth.Secret.fromBase32(admin.secret)}).generate());
  report.currentCheck = 'administrator login submission';
  await page.getByRole('button', { name: t.login, exact: true }).click();
  report.currentCheck = 'administrator authenticated dashboard';
  await page.getByRole('heading', { name: t.dashboard, exact: true }).waitFor();
  const catalogResponse = await page.request.get(origin+'/api/v1/products');
  assert.equal(catalogResponse.status(),200);
  const products=await catalogResponse.json();assert.equal(Array.isArray(products),true);report.publishedProducts=products.length;report.checks.push('authenticated admin catalog read');
  const dashboard = await page.request.get(`${origin}/api/v1/admin/dashboard`);
  assert.equal(dashboard.status(), 200);
  assert.equal((await dashboard.json()).workerActive, true);
  report.currentCheck = 'order filters and mail inbox';
  await page.getByRole('button', { name: t.orders, exact: true }).click();
  await page.getByRole('combobox', { name: t.products, exact: true }).waitFor();
  await page.getByLabel(t.begin, { exact: true }).waitFor();
  await page.getByRole('button', { name: t.mailInbox, exact: true }).click();
  await page.getByRole('heading', { name: t.mailInbox, exact: true }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/v1/admin/mail`)).status(), 200);
  assert.deepEqual(errors, []);
  report.checks.push('random owner account and TOTP', 'independent worker heartbeat', 'admin order filters and isolated mail inbox', 'no browser page errors');
  await page.getByRole('button', { name: t.logout, exact: true }).click();
  delete report.currentCheck;
  report.status = 'PASS';
} catch(error) {
  report.failureType = error.name;
  process.exitCode = 1;
  console.error('Local smoke failed; credential values and browser call logs are withheld.');
} finally {
  await browser?.close();
  await fs.writeFile(path.join(root, 'docs/evidence/local-running.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
