import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import {fileURLToPath} from 'node:url';
import { root,command,taskEnv } from './common.mjs';
import {startAutomaticCleanup} from './cleanup.mjs';
export function launch(mode,config){
  const env={...taskEnv,...config};
  const children=[command(process.execPath,[path.join(root,'backend/dist/main.js')],{cwd:path.join(root,'backend'),env,stdio:['ignore','inherit','inherit']}),command(process.execPath,[path.join(root,'backend/dist/worker.js')],{cwd:path.join(root,'backend'),env,stdio:['ignore','inherit','inherit']}),command(process.execPath,[path.join(root,'frontend/node_modules/next/dist/bin/next'),mode==='dev'?'dev':'start','--hostname','127.0.0.1','--port','3000'],{cwd:path.join(root,'frontend'),env,stdio:['ignore','inherit','inherit']})];
  const stopCleanup=config.APP_ENV==='local'?startAutomaticCleanup():()=>{};
  const stop=()=>{stopCleanup();for(const child of children)if(child.exitCode===null)child.kill();};
  const done=Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('error',error=>{stop();reject(error);});child.once('exit',code=>{stop();resolve(code);});}))).then(codes=>codes.some(code=>code)?1:0);
  return {stop,done};
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
  const config=parse(await fs.readFile(path.join(root,'backend/.env'))),service=launch(process.argv[2]||'dev',config);
  process.on('SIGINT',service.stop);process.on('SIGTERM',service.stop);process.exitCode=await service.done;
}
