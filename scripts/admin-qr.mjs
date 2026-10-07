// 生成管理后台 TOTP 的二维码，用验证器 App（Google Authenticator / 微软 Authenticator 等）扫码即可。
// 用法：pnpm admin:qr   或   node scripts/admin-qr.mjs
// 产物：.runtime/admin-totp-qr.png（可打印/放大扫）与 .runtime/admin-totp-qr.svg（矢量，最清晰）
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {root} from './common.mjs';

const require=createRequire(import.meta.url);
let QRCode;
try{QRCode=require('qrcode');}
catch{console.error('缺少依赖 qrcode。请先在项目根目录运行：pnpm install');process.exit(1);}

const file=path.join(root,'.runtime/admin-local.json');
let info;
try{info=JSON.parse(await fs.readFile(file,'utf8'));}
catch{console.error(`找不到 ${file}。请先运行 pnpm setup:local 初始化本地环境。`);process.exit(1);}

if(!info.secret){console.error('admin-local.json 中没有 secret，无法生成二维码。');process.exit(1);}

const uri=info.otpauth||`otpauth://totp/${encodeURIComponent('Template Workshop')}:${encodeURIComponent(info.email)}?issuer=${encodeURIComponent('Template Workshop')}&secret=${info.secret}&algorithm=SHA1&digits=6&period=30`;

const out=path.join(root,'.runtime');
const png=path.join(out,'admin-totp-qr.png');
const svg=path.join(out,'admin-totp-qr.svg');

await QRCode.toFile(png,uri,{type:'png',width:640,margin:2,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#FFFFFF'}});
await fs.writeFile(svg,await QRCode.toString(uri,{type:'svg',margin:2,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#FFFFFF'}}));

console.log('二维码已生成，用验证器 App 扫码即可：');
console.log(`  PNG  ${png}`);
console.log(`  SVG  ${svg}`);
console.log('');
console.log(`账号标识  ${info.email}`);
console.log(`issuer    Template Workshop`);
console.log('');
console.log('扫码后在 App 里会看到一个 30 秒一换的 6 位数字，那就是登录要填的「验证码」。');
console.log('若不想扫码，也可以运行 pnpm admin:code 直接在终端取当前验证码。');
