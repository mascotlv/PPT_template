import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {parse} from 'dotenv';
import {root} from './common.mjs';
import path from 'node:path';
const require=createRequire(import.meta.url),nodemailer=require('../backend/node_modules/nodemailer');
const {parseConfig}=require('../backend/dist/config');
try{
  const c=parseConfig(parse(await fs.readFile(path.join(root,'backend/.env'),'utf8')));
  if(c.MAIL_TRANSPORT!=='smtp'||!c.SMTP_USER||!c.SMTP_PASSWORD||c.MAIL_FROM.endsWith('.test'))throw new Error('MAIL_NOT_CONFIGURED');
  const transport=nodemailer.createTransport({host:c.SMTP_HOST,port:c.SMTP_PORT,secure:c.SMTP_SECURE,requireTLS:c.SMTP_REQUIRE_TLS,auth:{user:c.SMTP_USER,pass:c.SMTP_PASSWORD},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000});
  try{await transport.verify();console.log('SMTP 连接及账号认证成功。请重启网站后注册，用真实收件箱验证邮件链接。');}finally{transport.close();}
}catch(e){console.error('邮件检查失败：'+(e.code||(e.message==='MAIL_NOT_CONFIGURED'?'MAIL_NOT_CONFIGURED':'INVALID_CONFIGURATION'))+'. 请检查 backend/.env 的 MAIL_TRANSPORT、MAIL_FROM 和 SMTP 配置。');process.exitCode=1;}
