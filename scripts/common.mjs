import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const taskEnv={...process.env,COREPACK_HOME:path.join(root,'.cache/corepack'),TEMP:path.join(root,'.cache/tmp'),TMP:path.join(root,'.cache/tmp'),NEXT_TELEMETRY_DISABLED:'1',npm_config_cache:path.join(root,'.cache/npm')};
process.env.TEMP=taskEnv.TEMP;process.env.TMP=taskEnv.TMP;
export function command(command,args,options={}){const child=spawn(command,args,{cwd:root,env:taskEnv,stdio:'inherit',windowsHide:true,...options});return child;}
export function run(commandName,args,options={}){return new Promise((resolve,reject)=>{const child=command(commandName,args,options);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${commandName} exited ${code}`)));});}
export const pnpm=(args,options={})=>run(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/corepack/dist/pnpm.js'),...args],options);
export async function until(url,timeout=60000){const start=Date.now();while(Date.now()-start<timeout){try{if((await fetch(url,{signal:AbortSignal.timeout(Math.min(5000,Math.max(1,timeout-(Date.now()-start))))})).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error(`Readiness timeout: ${url}`);}
