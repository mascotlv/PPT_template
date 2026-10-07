import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'frontend/package.json'))('typescript');
const buildRoot = path.join(root, '.cache', 'pages-preview');
const source = path.join(buildRoot, 'frontend');
const basePath = process.env.PAGES_BASE_PATH || '';
if (basePath && !/^\/[A-Za-z0-9_.-]+$/.test(basePath)) throw Error('Invalid Pages base path');
await fs.mkdir(buildRoot, {recursive:true});
// Only the disposable build copy is replaced. Local frontend output and data stay separate.
if (path.dirname(source) !== buildRoot) throw Error('Invalid build path');
await fs.rm(source, {recursive:true, force:true});
await fs.mkdir(source, {recursive:true});
await fs.cp(path.join(root,'packages'), path.join(buildRoot,'packages'), {recursive:true});
for (const name of ['src', 'tsconfig.json', 'next-env.d.ts', 'package.json']) {
  await fs.cp(path.join(root, 'frontend', name), path.join(source, name), {recursive:true});
}
await fs.symlink(path.join(root, 'frontend', 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await fs.rm(path.join(source, 'src/proxy.ts'), {force:true});
await fs.writeFile(path.join(source, 'next.config.mjs'), `export default {output:'export',trailingSlash:true,basePath:${JSON.stringify(basePath)},images:{unoptimized:true},outputFileTracingRoot:${JSON.stringify(root)}};\n`);

const demoText = await fs.readFile(path.join(root, 'backend/src/commerce/demo.ts'), 'utf8');
const demo = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(demoText, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));
const categories = ['business', 'creative', 'report'].map(id => ({id, translations:demo.demoCategories[id], nameZh:demo.demoCategories[id].zh, nameEn:demo.demoCategories[id].en}));
// Fixed illustrative rates for presentation only, never used for transactions.
const rates = {CNY:1,USD:.14,EUR:.13,JPY:20,KRW:190,GBP:.11,CAD:.19,AUD:.21,CHF:.12,HKD:1.09,SGD:.19,NZD:.23,TWD:4.5,BRL:.8,MXN:2.8,INR:12,AED:.51,SAR:.52,RUB:12,SEK:1.4,NOK:1.5,DKK:.97,PLN:.56,THB:4.7,IDR:2200,MYR:.63,PHP:8,ZAR:2.5,TRY:5};
const themes = [
 {slug:'sage-strategy',category:categories[0],color:'#244F46',background:'#F1F4EB',amount:2900},
 {slug:'coral-story',category:categories[1],color:'#BE5039',background:'#FFF0E5',amount:3900},
 {slug:'midnight-report',category:categories[2],color:'#284D85',background:'#EDF1FA',amount:4900}
];
const assets = path.join(source, 'public/preview-assets');
await fs.mkdir(assets, {recursive:true});
for (const theme of themes) {
 const labels = [demo.demoProducts[theme.slug].en.title,'Our direction','Three priorities','Illustrative data','Next steps'];
 for (const [index,label] of labels.entries()) {
   const elements = index === 0 ? `<circle cx="1050" cy="470" r="145" fill="${theme.color}" opacity=".14"/><circle cx="1060" cy="475" r="90" fill="${theme.color}" opacity=".18"/>` : [0,1,2].map(k => `<rect x="${70+k*390}" y="410" width="340" height="4" fill="${theme.color}"/><text x="${70+k*390}" y="475" font-size="28" fill="${theme.color}">${['01 Focus','02 Build','03 Share'][k]}</text>`).join('');
   await fs.writeFile(path.join(assets, `${theme.slug}-${index}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${theme.background}"/><g font-family="Arial,sans-serif" fill="${theme.color}"><text x="70" y="75" font-size="20">TEMPLATE WORKSHOP / PREVIEW</text><text x="70" y="235" font-size="70" font-weight="bold">${label}</text><text x="70" y="310" font-size="27">An editable starting point for your story.</text>${elements}<text x="70" y="660" font-size="20">ORIGINAL DEMONSTRATION · ${index+1}/5</text></g></svg>`);
 }
}
const products = themes.map(theme => ({id:theme.slug,slug:theme.slug,category:theme.category,titleZh:demo.demoProducts[theme.slug].zh.title,titleEn:demo.demoProducts[theme.slug].en.title,translations:demo.demoProducts[theme.slug],descriptionZh:demo.demoProducts[theme.slug].zh.description,descriptionEn:demo.demoProducts[theme.slug].en.description,metadata:{slides:5,ratio:'16:9',software:'PowerPoint / WPS'},downloadNames:Object.fromEntries(Object.entries(demo.demoProducts[theme.slug]).map(([lang,t])=>[lang,t.title+'.pptx'])),prices:Object.entries(rates).map(([currency,rate])=>({currency,active:true,amount:Math.round(theme.amount*rate/(['JPY','KRW'].includes(currency)?100:1))})),versions:[{previews:Array.from({length:5},(_,i)=>`${theme.slug}-${i}.svg`)}]}));
await fs.writeFile(path.join(source, 'src/lib/preview-data.ts'), `export const categories = ${JSON.stringify(categories)};\nexport const products = ${JSON.stringify(products)};\n`);
await fs.copyFile(path.join(root,'scripts/preview-api.ts'), path.join(source,'src/lib/preview-api.ts'));

async function transform(file, fn) {
 const location = path.join(source, file);
 const text = await fs.readFile(location, 'utf8');
 const next = fn(text);
 if (next === text) throw Error('Expected preview transformation missing: '+file);
 await fs.writeFile(location, next);
}
await fs.writeFile(path.join(source,'src/lib/api/index.ts'), `import {previewRequest} from '../preview-api';
export class ApiError extends Error {constructor(readonly code:string,message:string,readonly requestId?:string){super(message);}}
export function setTokens(_data:{csrf?:string;adminCsrf?:string|null}){}
export async function api<T=any>(path:string,method='GET',_body?:unknown,_action?:string):Promise<T>{return previewRequest(path,method) as Promise<T>;}
function unavailable():never{throw new ApiError('FRONTEND_PREVIEW','This feature requires a backend.');}
export async function downloadFile(_path:string,_filename?:string,_method='GET',_action='download'){unavailable();}
export async function exportOrders(){unavailable();}
export async function uploadAttachment<T=any>(_path:string,_file:File,_progress?:(percent:number)=>void):Promise<T>{unavailable();}
export async function uploadForm<T=any>(_path:string,_form:FormData,_progress?:(percent:number)=>void):Promise<T>{unavailable();}
`);
// Keep the original API implementation available to the full application; this copy uses local preview data.
await transform('src/components/store.tsx', text => text.replace(': !session.customer?.verified && !session.admin ?', ': !session.previewMode && !session.customer?.verified && !session.admin ?').replace('<OperationFeedback />', '<OperationFeedback /><div className="preview-notice" role="status">{lang.startsWith("zh") ? "前端展示版 · 示例商品与参考价格 · 登录、付款和文件交付未开放" : "Frontend preview · Sample products and illustrative prices · Sign-in, payments and delivery are unavailable"}</div>').replace("code === 'PRODUCT_HAS_ORDERS' ?", "code === 'FRONTEND_PREVIEW' ? (lang.startsWith('zh') ? '这是前端展示版，此功能需要连接后端后使用。' : 'This feature requires a connected backend.') : code === 'PRODUCT_HAS_ORDERS' ?"));
await transform('src/components/storefront.tsx', text => text.replace('`/api/v1/previews/${keys[index]}`', '`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/preview-assets/${keys[index]}`').replace('`/products?${q}`', '`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/products/?${q}`').replace("history.replaceState(null, '', '/recover')", "history.replaceState(null, '', (process.env.NEXT_PUBLIC_BASE_PATH || '') + '/recover/')"));
await transform('src/components/account.tsx', text => text.replace("history.replaceState(null, '', '/account')", "history.replaceState(null, '', (process.env.NEXT_PUBLIC_BASE_PATH || '') + '/account/')"));
await fs.writeFile(path.join(source,'src/app/layout.tsx'), `import {Store} from '@/components/store';\nimport './globals.css';\nexport const metadata={title:'模板工坊 · 前端展示',description:'原创演示模板商城前端展示版'};\nexport default function Layout({children}:{children:React.ReactNode}) {return <html lang="zh"><body><Store>{children}</Store></body></html>;}\n`);
await fs.appendFile(path.join(source,'src/app/globals.css'), '\n.preview-notice {padding:12px 20px;text-align:center;background:#eaf3ff;color:#244a80;font-size:13px;line-height:1.6;border-bottom:1px solid #d1e2f5;}\n');
for (const [route, component, key, values] of [
 ['products/[slug]','ProductDetail','slug',themes.map(t=>t.slug)],
 ['checkout/[slug]','ProductDetail','slug',themes.map(t=>t.slug)],
 ['policies/[type]','Policy','type',['license','refund','privacy','contact']]
]) {
 await fs.writeFile(path.join(source, `src/app/${route}/page.tsx`), `import {${component}} from '@/components/storefront';\nexport function generateStaticParams(){return ${JSON.stringify(values.map(value=>({[key]:value})))};}\nexport default async function Page({params}:{params:Promise<{${key}:string}>}) {return <${component} ${key}={(await params).${key}}/>;}\n`);
}
await fs.rm(path.join(source,'src/app/orders'),{recursive:true,force:true});
await fs.writeFile(path.join(source,'src/app/contact/page.tsx'), `import {Policy} from '@/components/storefront';\nexport default function Page(){return <Policy type="contact"/>;}\n`);
await fs.writeFile(path.join(source,'src/app/sitemap.ts'), `export const dynamic='force-static';\nexport default function sitemap(){return ${JSON.stringify(['','/products',...themes.map(t=>'/products/'+t.slug)].map(p=>({url:(process.env.PAGES_ORIGIN || 'https://mascotlv.github.io')+basePath+p+'/'})))};}\n`);
await fs.writeFile(path.join(source,'src/app/robots.ts'), `export const dynamic='force-static';\nexport default function robots(){return {rules:{userAgent:'*',disallow:'/'}};}\n`);

await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[path.join(root,'frontend/node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:source,stdio:'inherit',windowsHide:true,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_BASE_PATH:basePath,NEXT_PUBLIC_STATIC_PREVIEW:'1'}});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Preview build failed: '+code)));
});
await fs.writeFile(path.join(source,'out/.nojekyll'),'');
console.log('Static preview ready: '+path.join(source,'out'));
