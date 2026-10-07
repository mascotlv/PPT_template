import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture} from './fixture.mjs';
import {restore} from './backup-lib.mjs';
import {createUtf8Database} from './postgres.mjs';
import {root,pnpm,taskEnv} from './common.mjs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{createApp}=require('../backend/dist/app'),{parseConfig}=require('../backend/dist/config'),{BrowserSession}=require('../backend/test/integration.cjs');
let f,app;const report={date:new Date().toISOString(),status:'FAIL',checks:[]};
try{
  const entries=JSON.parse(await fs.readFile(path.join(root,'.runtime/file-layout-backup-local.json'),'utf8')),entry=entries.find(v=>v.purpose==='before-feedback-chat-upgrade');
  if(!entry)throw new Error('Required encrypted pre-upgrade backup missing');
  f=await fixture('integration');const name='workshop_restore_'+randomUUID().replaceAll('-','').slice(0,8);await createUtf8Database(f.pg,name);
  const url=new URL(f.config.DATABASE_URL);url.pathname='/'+name;const storage=path.join(root,'.runtime',name,'storage');f.artifacts.push(path.dirname(storage));
  await pnpm(['--filter','backend','migrate'],{env:{...taskEnv,...f.env,DATABASE_URL:url.toString()}});
  const recovered=await restore(url.toString(),storage,entry.directory,entry.key);app=await createApp(parseConfig({...recovered.config,DATABASE_URL:url.toString(),STORAGE_ROOT:storage,PURCHASE_ROOT:recovered.config.PURCHASE_ROOT,STORE_ACCESS_MODE:'account',FX_AUTOMATIC_REFRESH:'false'}));
  const {db}=app;assert.equal(await db.product.count(),3);assert.equal(await db.order.count(),1);assert.equal(await db.admin.count(),1);assert.equal(await db.customer.count(),0);assert.equal(await db.chatMessage.count(),0);assert.equal(await db.chatConversation.count(),0);
  report.checks.push('26-table v2 backup restored to 28-table schema without dropping original records');
  const order=await db.order.findFirstOrThrow({where:{status:'PAID'},include:{item:{include:{fileVersion:true}}}});
  await app.app.listen(0,'127.0.0.1');const base=await app.app.getUrl(),buyer=await new BrowserSession(base,app.shop.config).init(false);await buyer.register(db,order.email);assert.equal((await buyer.call('/orders/'+order.id)).status,200);
  const grant=await buyer.call('/orders/'+order.id+'/download','POST',{});assert.equal(grant.status,201);const downloaded=await fetch(base+grant.data.url,{headers:{Cookie:Object.entries(buyer.jar).map(([k,v])=>`${k}=${v}`).join('; ')}});assert.equal(downloaded.status,200);assert.equal(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex'),order.item.fileVersion.sha256);
  report.checks.push('Restored legacy paid order claimed through verified email and original bytes actually downloaded');report.status='PASS';
}catch(error){report.errorType=error.name;console.error('Legacy backup validation failed; private data and keys withheld.');process.exitCode=1;}
finally{await app?.app.close();await app?.db.$disconnect();await f?.stop();await fs.writeFile(path.join(root,'docs/evidence/backup-compatibility-feedback.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exit(process.exitCode||0);}
