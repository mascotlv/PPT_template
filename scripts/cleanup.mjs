import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { fileURLToPath } from 'node:url';
import { root } from './common.mjs';

const patches = new Set('account-hardening add-smtp-test backup-before-upgrade canonical-content enhance-flows extend-final-tests extend-order-e2e finish-commerce finish-controls finish-operation-tools fix-accessibility fix-action-progress fix-admin-race fix-admin-render fix-buyer-null fix-quote-types fix-reconciliation fix-recovery fix-test fix-test2 fix-tests last-checks patch-commerce-core refine-and-tests refine-initialization test-extra update-commerce-docs update-contract upgrade-local verify-v1-backup'.split(' ').map(name => `.runtime/${name}.mjs`));
const runtimePattern = /^\.runtime\/(?:postgres-)?workshop_test_(?:browser|integration)_[a-f0-9]{8}$/;
const auxiliaryPattern = /^\.runtime\/(?:workshop_restore_(?:v1_)?[a-f0-9]{8}|backup-test-[a-f0-9-]{36}|auto-run|codex-test\d*|final-run\d*|run-(?:dry|send)\d*|verify\d+)$/;
const caches = ['.cache/npm', '.cache/pnpm-cache', '.cache/pnpm-state', '.cache/pnpm-store', '.cache/tmp', 'frontend/.next/cache', 'frontend/tsconfig.tsbuildinfo', 'test-results', 'playwright-report'];
const extras = ['.runtime/e2e.json', '.runtime/browser-downloads', '.runtime/probe-ascii', '.runtime/pw-test.txt'];
const transientPattern = /^(?:_[^/]+\.(?:png|css|cjs)|\.runtime\/(?:[^/]+\.log|_[^/]+\.json|(?!admin|backup|local|file-layout-backup)[^/]+\.(?:png|webp|svg|py|cjs|mjs))|docs\/evidence\/(?!verification\.json$)[^/]+\.(?:json|png|tap))$/;
const obsoleteFiles = ['backend/_browser-test.cjs', 'frontend/test.config.json'];
const normalized = target => path.relative(root, path.resolve(target)).split(path.sep).join('/');
const exists = target => fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function inspectTree(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing linked cleanup path: ${normalized(target)}`);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  let bytes = 0, files = 0;
  for (const entry of await fs.readdir(target)) {
    const size = await inspectTree(path.join(target, entry)); bytes += size.bytes; files += size.files;
  }
  return { bytes, files };
}

export async function removeGenerated(target, fixtureOnly = false) {
  const absolute = path.resolve(target), relative = normalized(absolute);
  const allowed = runtimePattern.test(relative) || auxiliaryPattern.test(relative)
    || (!fixtureOnly && (caches.includes(relative) || extras.includes(relative) || patches.has(relative) || transientPattern.test(relative) || obsoleteFiles.includes(relative)));
  if (!allowed || !absolute.startsWith(root + path.sep)) throw new Error('Cleanup target is outside the generated artifact allowlist');
  const stat = await exists(absolute);
  if (!stat) return { path: relative, status: 'ABSENT', bytes: 0, files: 0 };
  if (/^\.runtime\/(?:auto-run|codex-test\d*|final-run\d*|run-(?:dry|send)\d*|verify\d+)$/.test(relative)) {
    if (!stat.isDirectory() || (await fs.readdir(absolute, { withFileTypes: true })).some(entry => !entry.isFile() || entry.isSymbolicLink() || !/\.png$/i.test(entry.name))) throw new Error('Snapshot directory contains unfamiliar files; preserved');
  }
  const canonicalRoot = await fs.realpath(root), canonical = await fs.realpath(absolute);
  if (!canonical.startsWith(canonicalRoot + path.sep)) throw new Error('Cleanup target resolves outside the project');
  if (stat.isDirectory() && await exists(path.join(absolute, 'postmaster.pid'))) {
    const content = await fs.readFile(path.join(absolute, 'postmaster.pid'));
    let marker = content.toString('utf8').split(/\r?\n/);
    if (process.platform === 'win32' && path.resolve(marker[1] || '') !== absolute) {
      // Older Windows SQL_ASCII clusters write paths using the local GBK code page.
      marker = new TextDecoder('gb18030', {fatal:true}).decode(content).split(/\r?\n/);
    }
    const pid = Number(marker[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || path.resolve(marker[1] || '') !== absolute) throw new Error(`Invalid database process marker: ${relative}`);
    let running = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else if (process.platform !== 'win32') throw error; }
    if (running && process.platform === 'win32') {
      // A stale marker can refer to a recycled Windows PID. Inspect its name
      // without stopping or modifying that process; ambiguous results refuse cleanup.
      const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).ProcessName } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'ABSENT' } else { exit 2 } }`;
      const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true,timeout:10000});
      const name = stdout.trim();
      if (!name) throw new Error(`Cannot determine database process state: ${relative}`);
      running = name.toLowerCase() === 'postgres';
    }
    // Windows embedded PostgreSQL can retain its marker after stopping.
    if (running) throw new Error(`Database process still exists; cleanup refused: ${relative}`);
  }
  // Inspect every child before recursive removal; never follow a linked directory.
  const size = await inspectTree(absolute);
  await fs.rm(absolute, { recursive: stat.isDirectory(), force: true, maxRetries: 3, retryDelay: 100 });
  return { path: relative, status: 'DELETED', ...size };
}

export async function cleanupFixture(name, artifacts = []) {
  if (!/^workshop_test_(browser|integration)_[a-f0-9]{8}$/.test(name)) throw new Error('Invalid isolated fixture name');
  const targets = [path.join(root, '.runtime', 'postgres-' + name), path.join(root, '.runtime', name), ...artifacts];
  for (const target of targets) await removeGenerated(target, true);
}

const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(true); });
});

async function inventory() {
  const directories = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (['.git', '.agents', '.codex', '.aws'].includes(entry.name)) continue;
    // pnpm links point to project packages; logical size does not count links twice.
    const count = async target => {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) return { bytes: 0, files: 0 };
      if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
      let bytes = 0, files = 0;
      for (const child of await fs.readdir(target)) { const size = await count(path.join(target, child)); bytes += size.bytes; files += size.files; }
      return { bytes, files };
    };
    directories.push({ path: entry.name, ...await count(path.join(root, entry.name)) });
  }
  return { bytes: directories.reduce((sum, d) => sum + d.bytes, 0), files: directories.reduce((sum, d) => sum + d.files, 0), directories: directories.sort((a, b) => b.bytes - a.bytes) };
}

// The running shop only removes old, isolated test artifacts. Build/package
// caches and temporary work can be in use, so they remain manual-only targets.
export async function cleanupOldFixtures(now = Date.now()) {
  if ((await Promise.all([55433, 55434].map(portOpen))).some(Boolean)) return [];
  const actions = [];
  const runtime = path.join(root, '.runtime');
  for (const name of await fs.readdir(runtime).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    const relative = `.runtime/${name}`;
    if (!runtimePattern.test(relative) && !auxiliaryPattern.test(relative)) continue;
    const target = path.join(runtime, name), stat = await exists(target);
    if (!stat || now - stat.mtimeMs < 7 * 24 * 60 * 60 * 1000) continue;
    try { actions.push(await removeGenerated(target, true)); }
    catch (error) { actions.push({ path: relative, status: 'SKIPPED', reason: error.message }); }
  }
  return actions;
}

export function startAutomaticCleanup() {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const actions = await cleanupOldFixtures();
      if (actions.length) {
        console.log(`[cleanup] Removed ${actions.filter(a => a.status === 'DELETED').length} old test artifacts.`);
      }
    } catch (error) { console.error('[cleanup]', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 24 * 60 * 60 * 1000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const testsRunning = (await Promise.all([55433, 55434].map(portOpen))).some(Boolean);
  if (apply && (await Promise.all([3000, 4100].map(portOpen))).some(Boolean)) {
    // Keep caches and builds used by a live shop; isolated stopped fixtures
    // still use the same process and path checks as offline cleanup.
    for (const cache of [...caches]) if (!['test-results', 'playwright-report'].includes(cache)) caches.splice(caches.indexOf(cache), 1);
  }
  const before = await inventory();
  const targets = testsRunning ? [...patches] : [...caches, ...extras, ...patches];
  if (!testsRunning) {
    targets.push(...obsoleteFiles);
    for (const directory of [root, path.join(root, '.runtime'), path.join(root, 'docs/evidence')]) {
      for (const entry of await fs.readdir(directory, {withFileTypes:true}).catch(error => {if(error.code==='ENOENT')return [];throw error;})) {
        const relative = normalized(path.join(directory, entry.name));
        if (entry.isFile() && transientPattern.test(relative)) targets.push(relative);
      }
    }
  }
  for (const name of await fs.readdir(path.join(root, '.runtime'))) {
    const relative = `.runtime/${name}`;
    if (testsRunning) {
      if (!runtimePattern.test(relative)) continue;
      const fixture = name.replace(/^postgres-/, '');
      const marker = await fs.readFile(path.join(root, '.runtime', 'postgres-' + fixture, 'postmaster.pid'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (marker) {
        const pid = Number(marker.split(/\r?\n/)[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); continue; }
        catch (error) { if (error.code !== 'ESRCH') continue; }
      }
    }
    if (runtimePattern.test(relative) || auxiliaryPattern.test(relative)) targets.push(relative);
  }
  const actions = [];
  for (const relative of new Set(targets)) {
    const target = path.join(root, relative);
    if (!await exists(target)) continue;
    try {
      if (apply) actions.push(await removeGenerated(target));
      else actions.push({ path: relative, status: 'CANDIDATE', ...await inspectTree(target) });
    } catch (error) { actions.push({ path: relative, status: 'SKIPPED', reason: error.message }); }
  }
  if (apply) await fs.mkdir(path.join(root, '.cache/tmp'), { recursive: true });
  const after = apply ? await inventory() : before;
  const report = { date: new Date().toISOString(), applied: apply, measurement: 'Sum of file lengths, excluding symbolic links; hardlinks may share disk blocks. This is logical directory size, not measured free disk space.', before, after, deletedLogicalBytes: actions.reduce((sum, a) => sum + (a.status === 'DELETED' ? a.bytes : 0), 0), actions, preserved: ['source and lockfile', 'node_modules runtime dependencies', '.cache/corepack package manager', 'frontend/.next running build', 'backend/dist running build', '.runtime/postgres-local', '.runtime/storage', '.runtime/local.json', '.runtime/admin-local.json', '.runtime/backup-before-*', '.runtime/file-layout-backup-local.json', '购买文件', 'docs/evidence/verification.json'] };
  console.log(JSON.stringify({ applied: apply, before: before.bytes, after: after.bytes, candidates: actions.filter(a => a.status === 'CANDIDATE').reduce((sum, a) => sum + a.bytes, 0), deletedLogicalBytes: report.deletedLogicalBytes, skipped: actions.filter(a => a.status === 'SKIPPED') }, null, 2));
}
