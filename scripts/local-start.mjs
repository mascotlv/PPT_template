import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {parse} from 'dotenv';
import pg from 'pg';
import {root,pnpm,run,until} from './common.mjs';
import {startPostgres} from './postgres.mjs';
import {launch} from './run.mjs';

const lockFile=path.join(root,'.runtime/local-start.lock.json'),id=randomUUID();
let ownedDatabase,app,locked=false,stopping=false;
// Windows console hosts may deliver Ctrl+C as input rather than SIGINT.
// Handle both and restore the console mode before returning to PowerShell.
const input=process.stdin;
function enableInput(){if(input.isTTY)input.setRawMode(true);input.on('data',bytes=>{if(bytes.includes(3))void stop().finally(()=>process.exit());});input.resume();input.unref?.();}
const exists=async file=>!!await fs.stat(path.join(root,file)).catch(()=>null);
const listening=port=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(true);});});
async function stop(){if(stopping)return;stopping=true;if(input.isTTY)input.setRawMode(false);input.pause();app?.stop();if(app)await app.done;await ownedDatabase?.stop();if(locked){const lock=JSON.parse(await fs.readFile(lockFile,'utf8').catch(()=>'{}'));if(lock.id===id)await fs.unlink(lockFile);} }
process.on('SIGINT',()=>void stop().finally(()=>process.exit()));process.on('SIGTERM',()=>void stop().finally(()=>process.exit()));
try{
  if(Number(process.versions.node.split('.')[0])!==24)throw new Error('请使用 Node.js 24。');
  await fs.mkdir(path.join(root,'.cache/tmp'),{recursive:true});await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
  if(process.argv.includes('--rebuild')){
    if(process.platform!=='win32')throw new Error('自动停止项目进程目前仅支持 Windows。');
    console.log('正在停止本项目相关进程，然后重新构建并启动…');
    await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/stop-local.ps1'),'-ProjectRoot',root,'-KeepProcessId',String(process.pid)]);
    for(const file of [lockFile,path.join(root,'.runtime/frontend-build.lock.json')])await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  for(let attempt=0;attempt<2;attempt++){
    try{await fs.writeFile(lockFile,JSON.stringify({pid:process.pid,id,startedAt:new Date().toISOString()}),{flag:'wx'});locked=true;break;}
    catch(error){if(error.code!=='EEXIST')throw error;const lock=JSON.parse(await fs.readFile(lockFile,'utf8'));let alive=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive){console.log('本项目已经启动或正在启动。购买入口：http://localhost:3000；管理入口：http://localhost:3000/admin');process.exit(0);}await fs.unlink(lockFile);}
  }
  if(!locked)throw new Error('启动锁尚未释放，请稍后重试。');
  for(const port of [3000,4100])if(await listening(port))throw new Error('端口 '+port+' 已被使用。请先关闭之前的本项目启动窗口，再运行本命令；不会自动关闭其他程序。');
  if(!await exists('node_modules/.modules.yaml'))await pnpm(['install','--frozen-lockfile']);
  const rebuild=process.argv.includes('--rebuild')||!await exists('frontend/.next/BUILD_ID')||!await exists('backend/dist/main.js');
  if(rebuild)await pnpm(['build']);
  if(!await exists('backend/.env'))await run(process.execPath,[path.join(root,'scripts/setup-local.mjs')]);
  const config=parse(await fs.readFile(path.join(root,'backend/.env'))),url=new URL(config.DATABASE_URL);
  if(config.APP_ENV!=='local'||!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='55432'||url.pathname!=='/workshop'||config.PUBLIC_ORIGIN!=='http://localhost:3000'||config.PORT!=='4100')throw new Error('一键启动仅用于本项目的本地配置；其他环境请遵循 README.md 部署章节。');
  console.log('正在检查本地数据库…');
  if(!await listening(55432))ownedDatabase=await startPostgres('postgres-local',55432,decodeURIComponent(url.password));
  const client=new pg.Client({connectionString:config.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:10000});try{await client.connect();await client.query('SELECT 1');}finally{await client.end();}
  await pnpm(['--filter','backend','migrate']);
  enableInput();app=launch('start',config);
  const exit=app.done;
  await Promise.race([until('http://127.0.0.1:4100/api/v1/health/ready'),exit.then(()=>{throw new Error('后端提前退出，请查看上方启动日志。');})]);
  await until('http://localhost:3000');
  console.log('\n已启动：购买入口 http://localhost:3000；管理入口 http://localhost:3000/admin');
  console.log('无需输入额外访问口令。账号资料保存在 .runtime/admin-local.json。保持此窗口打开；Ctrl+C 停止本次启动的服务。');
  const code=await exit;if(code)process.exitCode=1;
}catch(error){console.error('本地启动失败：'+String(error.message).replace(/postgresql:\/\/\S+/g,'[数据库连接已隐藏]'));process.exitCode=1;}
finally{await stop();}
