import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {parse} from 'dotenv';
import {root} from './common.mjs';
import {backup,within} from './backup-lib.mjs';
const require=createRequire(import.meta.url),{parseConfig}=require('../backend/dist/config'),{database}=require('../backend/dist/db'),{normalizePurchaseFiles}=require('../backend/dist/storage/purchase-files'),{LocalStorage}=require('../backend/dist/storage/local');
const config=parseConfig(parse(await fs.readFile(path.join(root,'backend/.env'),'utf8')));if(config.APP_ENV!=='local')throw new Error('This maintenance command is only for the local project');
within(config.STORAGE_ROOT);within(config.PURCHASE_ROOT);
for(const port of [3000,4100]){const busy=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(500,()=>{socket.destroy();resolve(true);});});if(busy)throw new Error('Stop the local frontend/backend/worker before file maintenance');}
const db=database(config.DATABASE_URL),storage=new LocalStorage(config.STORAGE_ROOT,config.PURCHASE_ROOT),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(directory){const result=[];async function visit(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name),stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new Error('Linked paths cannot be moved');if(stat.isDirectory())await visit(file);else if(stat.isFile())result.push({file:path.relative(directory,file),size:stat.size,sha256:digest(await fs.readFile(file))});}}await visit(directory);return result.sort((a,b)=>a.file.localeCompare(b.file));}
const counts=async()=>({products:await db.product.count(),orders:await db.order.count(),customers:await db.customer.count(),admins:await db.admin.count(),files:await db.fileVersion.count()});
try{
  const before=await counts(),references=await db.fileVersion.findMany({select:{id:true,key:true,sha256:true}}),originalHashes=new Map();for(const f of references){const bytes=await fs.readFile(storage.resolve(f.key));if(digest(bytes)!==f.sha256)throw new Error('Original hash mismatch; maintenance stopped');originalHashes.set(f.id,f.sha256);}
  const uuid=/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i,legacy=(await fs.readdir(config.PURCHASE_ROOT)).filter(name=>uuid.test(name));
  let backupLocation=null;if(references.some(f=>!f.key.startsWith('history/'))||legacy.length){
    const directory=path.join(root,'.runtime','backup-before-file-layout-'+Date.now()),key=randomBytes(32).toString('hex');await backup(config,directory,key);const keyFile=path.join(root,'.runtime/file-layout-backup-local.json');let records=[];try{records=JSON.parse(await fs.readFile(keyFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}records.push({directory,key,at:new Date().toISOString()});await fs.writeFile(keyFile,JSON.stringify(records,null,2),{mode:0o600});backupLocation=path.relative(root,directory);
  }
  const normalized=await normalizePurchaseFiles(db,config),archived=[];
  for(const name of legacy){const source=within(path.join(config.PURCHASE_ROOT,name));try{await fs.access(source);}catch{continue;}
    if(await db.fileVersion.count({where:{key:{startsWith:'purchased/'+name+'/'}}}))throw new Error('Legacy folder is still referenced');
    const files=await inventory(source),destination=within(path.join(config.STORAGE_ROOT,'迁移前原文件',name));await fs.mkdir(path.dirname(destination),{recursive:true});
    const canonicalRoot=await fs.realpath(root),canonicalSource=await fs.realpath(source),canonicalParent=await fs.realpath(path.dirname(destination));if(!canonicalSource.startsWith(canonicalRoot+path.sep)||!canonicalParent.startsWith(canonicalRoot+path.sep))throw new Error('Move must stay in the project');
    try{await fs.access(destination);throw new Error('Archive already exists; no files overwritten');}catch(e){if(e.code!=='ENOENT')throw e;}
    await fs.rename(source,destination);const saved=await inventory(destination);if(JSON.stringify(saved)!==JSON.stringify(files))throw new Error('Moved file verification failed');archived.push({source:path.relative(root,source),destination:path.relative(root,destination),files:files.length,hashesVerified:true});
  }
  for(const f of await db.fileVersion.findMany()){if(digest(await fs.readFile(storage.resolve(f.key)))!==originalHashes.get(f.id))throw new Error('Original changed during normalization');}
  const after=await counts();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Business counts changed during normalization');
  const result={date:new Date().toISOString(),status:'PASS',before,after,...normalized,backupLocation,archived,referencedHashesVerified:references.length,layout:'购买文件/分类标题/商品标题.pptx'};await fs.writeFile(path.join(root,'docs/evidence/file-layout-migration.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,archivedFolders:archived.length,archived:undefined},null,2));
}catch{console.error('Local file normalization stopped; credentials and private contents withheld. Existing backups and files are retained.');process.exitCode=1;}finally{await db.$disconnect();}
