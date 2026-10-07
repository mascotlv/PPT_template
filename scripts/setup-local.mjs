import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import { createRequire } from 'node:module';
import { root,pnpm } from './common.mjs';
import { startPostgres,createUtf8Database } from './postgres.mjs';
if(await fs.stat(path.join(root,'backend/.env')).catch(()=>null)){console.log('已有本地配置，保持账号、密钥和数据不变。请运行 node scripts/local-start.mjs 启动。');process.exit(0);}
const require=createRequire(import.meta.url);const rand=()=>randomBytes(32).toString('hex');
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});await fs.mkdir(path.join(root,'.cache/tmp'),{recursive:true});
let local;try{local=JSON.parse(await fs.readFile(path.join(root,'.runtime/local.json'),'utf8'));}catch{local={databasePassword:rand(),accessPassword:rand(),sessionSecret:rand(),mockKey:rand(),encryptionKey:rand()};await fs.writeFile(path.join(root,'.runtime/local.json'),JSON.stringify(local,null,2),{mode:0o600,flag:'wx'});}
const config={APP_ENV:'local',PAYMENT_MODE:'mock',STORE_ACCESS_MODE:'account',DEV_AUTH_BYPASS:'false',ACCOUNT_REQUIRE_SMTP:'false',PORT:'4100',PUBLIC_ORIGIN:'http://localhost:3000',DATABASE_URL:`postgresql://workshop:${local.databasePassword}@127.0.0.1:55432/workshop`,SESSION_SECRET:local.sessionSecret,MOCK_SIGNING_KEY:local.mockKey,ADMIN_ENCRYPTION_KEY:local.encryptionKey,TEST_ACCESS_PASSWORD:local.accessPassword,STORAGE_ROOT:path.join(root,'.runtime/storage').replaceAll('\\','/'),PURCHASE_ROOT:path.join(root,'购买文件').replaceAll('\\','/'),MAIL_TRANSPORT:'outbox',MAIL_FROM:'workshop@example.test'};
try{await fs.writeFile(path.join(root,'backend/.env'),Object.entries(config).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;throw new Error('backend/.env already exists; use db:migrate and seed, do not overwrite configuration');}
const pg=await startPostgres('postgres-local',55432,local.databasePassword);
try{await createUtf8Database(pg,'workshop');await pnpm(['--filter','backend','migrate']);const {database}=require('../backend/dist/db.js');const {parseConfig}=require('../backend/dist/config.js');const {seed}=require('../backend/dist/seed.js');const {initializeAdmin}=require('../backend/dist/admin-init.js');const c=parseConfig(config);const db=database(c.DATABASE_URL);try{await seed(db,c);if(!await db.admin.count()){const password=rand();const info=await initializeAdmin(db,c,{email:'owner@example.test',password,role:'ADMIN'});await fs.writeFile(path.join(root,'.runtime/admin-local.json'),JSON.stringify({...info,password},null,2),{flag:'wx',mode:0o600});}}finally{await db.$disconnect();}}finally{await pg.stop();}
console.log('Local environment initialized. Credentials are in project .runtime (not printed). Start pnpm db:local, then pnpm start.');
