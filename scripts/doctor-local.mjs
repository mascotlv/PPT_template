import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'dotenv';
import pg from 'pg';
import {root} from './common.mjs';
const checks=[];
checks.push({check:'Node.js 24',pass:process.versions.node.split('.')[0]==='24'});
for(const file of ['backend/.env','.runtime/admin-local.json','frontend/.next/BUILD_ID','backend/dist/main.js'])checks.push({check:file,pass:!!await fs.stat(path.join(root,file)).catch(()=>null)});
try{const config=parse(await fs.readFile(path.join(root,'backend/.env'))),client=new pg.Client({connectionString:config.DATABASE_URL,connectionTimeoutMillis:3000});try{await client.connect();await client.query('SELECT 1');checks.push({check:'数据库连接',pass:true});}finally{await client.end();}}catch{checks.push({check:'数据库连接',pass:false});}
for(const [name,url] of [['前端','http://localhost:3000'],['后端','http://127.0.0.1:4100/api/v1/health/ready']]){try{checks.push({check:name,pass:(await fetch(url,{signal:AbortSignal.timeout(5000)})).ok});}catch{checks.push({check:name,pass:false});}}
for(const item of checks)console.log((item.pass?'通过':'未通过')+' · '+item.check);
if(checks.some(c=>!c.pass))process.exitCode=1;
console.log('账号与密钥未输出。请在编辑器内打开项目 .runtime/admin-local.json 查看管理员资料。');
