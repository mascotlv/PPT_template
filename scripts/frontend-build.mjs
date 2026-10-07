import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {root,run} from './common.mjs';
const file=path.join(root,'.runtime/frontend-build.lock.json'),id=randomUUID();
const frontend=path.join(root,'frontend'),output=path.join(frontend,'.next'),previous=path.join(frontend,'.next-before-build-'+id);
const listening=()=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:3000});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(true);});});
async function removeGenerated(target){const base=await fs.realpath(frontend),resolved=await fs.realpath(target);if(path.dirname(resolved)!==base||!/^\.next(?:-before-build-[a-f0-9-]+)?$/.test(path.basename(resolved))||(await fs.lstat(target)).isSymbolicLink())throw new Error('构建目录路径检查失败，保留原文件。');await fs.rm(target,{recursive:true,force:true});}
await fs.mkdir(path.dirname(file),{recursive:true});
let acquired=false,saved=false;
try{
  for(let attempt=0;attempt<2;attempt++){
    try{await fs.writeFile(file,JSON.stringify({pid:process.pid,id,startedAt:new Date().toISOString()}),{flag:'wx'});acquired=true;break;}
    catch(error){if(error.code!=='EEXIST')throw error;const lock=JSON.parse(await fs.readFile(file,'utf8'));let alive=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw new Error('前端正在构建，请等待该构建完成，不要同时启动第二次构建。');await fs.unlink(file);}
  }
  if(!acquired)throw new Error('无法获取前端构建锁，请稍后重试。');
  if(await listening())throw new Error('3000端口仍在运行。请先停止商城启动窗口，再构建；已保留当前前端文件。');
  const current=await fs.lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(current){if(current.isSymbolicLink()||!current.isDirectory())throw new Error('前端构建目录异常，保留原文件。');await fs.rename(output,previous);saved=true;}
  try{await run(process.execPath,[path.join(root,'frontend/node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:frontend});await fs.access(path.join(output,'BUILD_ID'));}
  catch(error){if(saved){if(await fs.lstat(output).catch(()=>null))await removeGenerated(output);await fs.rename(previous,output);saved=false;console.error('构建未完成，已恢复构建前的前端目录。');}throw error;}
  if(saved){await removeGenerated(previous);saved=false;}
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(acquired){const lock=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'{}'));if(lock.id===id)await fs.unlink(file);}}
