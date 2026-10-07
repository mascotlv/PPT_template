// 打印本地管理后台当前可用的 6 位验证码（TOTP），用于登录 /admin。
// 用法：pnpm admin:code   或   node scripts/admin-code.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {root} from './common.mjs';

const require=createRequire(import.meta.url);
const file=path.join(root,'.runtime/admin-local.json');

let info;
try{info=JSON.parse(await fs.readFile(file,'utf8'));}
catch{console.error(`找不到 ${file}。请先运行 pnpm setup:local 初始化本地环境。`);process.exit(1);}

const OTPAuth=require('../backend/node_modules/otpauth');
const totp=new OTPAuth.TOTP({issuer:'Template Workshop',label:info.email,secret:OTPAuth.Secret.fromBase32(info.secret)});
const period=30;
const code=totp.generate();
const remain=period-(Math.floor(Date.now()/1000)%period);

console.log('管理后台登录信息  ->  http://localhost:3000/admin');
console.log(`  邮箱    ${info.email}`);
console.log(`  密码    ${info.password}`);
console.log(`  验证码  ${code}    (${remain} 秒后失效，失效后重新运行本命令)`);
console.log('');
console.log('提示：验证码是 6 位数字，来自验证器 App；恢复码是一次性备用码，每个只能用一次。');
if(info.recoveryCodes?.length)console.log(`  未使用的恢复码：${info.recoveryCodes.join('  ')}`);
