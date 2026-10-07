import EmbeddedPostgres from 'embedded-postgres';
import { root } from './common.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
export async function startPostgres(name,port,password){if(!/^[a-z0-9_-]+$/.test(name))throw new Error('Invalid project database directory');const directory=path.join(root,'.runtime',name);await fs.mkdir(directory,{recursive:true});let startupLog='';const pg=new EmbeddedPostgres({databaseDir:directory,user:'workshop',password,port,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=SQL_ASCII','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:message=>{startupLog=(startupLog+message).slice(-8000);},onError:()=>{}});
  if(process.platform==='win32'){
    const require=createRequire(import.meta.url),nativeRequire=createRequire(require.resolve('embedded-postgres'));
    const native=await import(pathToFileURL(nativeRequire.resolve('@embedded-postgres/windows-x64')).href);
    // The package uses forceful taskkill on Windows. pg_ctl closes our cluster
    // cleanly and avoids its unbounded wait when taskkill is unavailable.
    pg.stop=async()=>{const child=pg.process;if(!child)return;if(child.exitCode!==null||child.signalCode!==null){pg.process=undefined;return;}const exited=new Promise(resolve=>child.once('exit',resolve));
      await new Promise((resolve,reject)=>{const control=spawn(native.pg_ctl,['-D','.','-m','fast','-w','-t','30','stop'],{cwd:directory,windowsHide:true,stdio:'ignore'});control.once('error',reject);control.once('exit',code=>code===0?resolve():reject(new Error('Project PostgreSQL graceful shutdown failed')));});
      let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Project PostgreSQL exit timed out')),35000);})]);}finally{clearTimeout(timer);}pg.process=undefined;
    };
  }
  if(!await fs.stat(path.join(directory,'PG_VERSION')).catch(()=>null))await pg.initialise();
  let timer;try{await Promise.race([pg.start(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('数据库启动超过 60 秒。')),60000);})]);}
  catch(error){await pg.stop();throw new Error((error?.message||'数据库启动失败。')+(startupLog?'\n'+startupLog:''));}finally{clearTimeout(timer);}
  return pg;
}
export async function createUtf8Database(pg,name){if(!/^[a-z_\d]+$/.test(name))throw new Error('Invalid database name');const client=pg.getPgClient();await client.connect();try{await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);}finally{await client.end();}}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){const local=JSON.parse(await fs.readFile(path.join(root,'.runtime/local.json'),'utf8'));const pg=await startPostgres('postgres-local',55432,local.databasePassword);console.log('Project PostgreSQL listening only on 127.0.0.1:55432');process.on('SIGINT',()=>pg.stop().finally(()=>process.exit()));process.on('SIGTERM',()=>pg.stop().finally(()=>process.exit()));setInterval(()=>{},60000);}
