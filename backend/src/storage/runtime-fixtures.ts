import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const projectRoot = path.resolve(__dirname, '../../..');
const fixtureName = /^(?:postgres-)?workshop_test_(?:browser|integration)_[a-f0-9]{8}$/;
const auxiliaryName = /^(?:workshop_restore_(?:v1_)?[a-f0-9]{8}|backup-test-[a-f0-9-]{36}|browser-downloads|probe-ascii)$/;
const screenshotName = /^(?:auto-run|codex-test\d*|final-run\d*|run-(?:dry|send)\d*|verify\d+)$/;
export const isRuntimeFixture = (name: string) => fixtureName.test(name) || auxiliaryName.test(name) || screenshotName.test(name);
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const portOpen = (port: number) => new Promise<boolean>(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(true));
});
async function sizeOf(target: string): Promise<{ bytes: number; files: number }> {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error('Linked temporary paths are preserved');
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
    let bytes = 0, files = 0;
    for (const entry of await fs.readdir(target)) { const size = await sizeOf(path.join(target, entry)); bytes += size.bytes; files += size.files; }
    return { bytes, files };
}
async function databaseStopped(folder: string) {
    const content = await fs.readFile(path.join(folder, 'postmaster.pid')).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!content) return true;
    let marker = content.toString('utf8').split(/\r?\n/);
    if (process.platform === 'win32' && path.resolve(marker[1] || '') !== folder) marker = new TextDecoder('gb18030', { fatal: true }).decode(content).split(/\r?\n/);
    const pid = Number(marker[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || path.resolve(marker[1] || '') !== folder) throw new Error('Invalid database process marker; preserved');
    try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') return true; if (process.platform !== 'win32') throw error; }
    if (process.platform !== 'win32') return false;
    const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).ProcessName } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'ABSENT' } else { exit 2 } }`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
    if (!stdout.trim()) throw new Error('Cannot verify database process; preserved');
    return stdout.trim().toLowerCase() !== 'postgres';
}
export async function cleanRuntimeFixtures(protectedRoots: string[], runtimeRoot = path.join(projectRoot, '.runtime')) {
    const root = path.resolve(runtimeRoot), actions: { path: string; status: string; bytes?: number; files?: number; reason?: string }[] = [];
    if (!inside(path.join(projectRoot, '.runtime'), root)) throw new Error('Temporary cleanup root is outside .runtime');
    const rootStat = await fs.lstat(root).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!rootStat) return actions;
    if (rootStat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Linked runtime roots cannot be cleaned');
    const testsRunning = (await Promise.all([55433, 55434].map(portOpen))).some(Boolean);
    for (const name of await fs.readdir(root)) {
        if (!isRuntimeFixture(name)) continue;
        const target = path.resolve(root, name), label = path.relative(projectRoot, target).split(path.sep).join('/');
        try {
            if (!inside(root, target) || protectedRoots.some(p => inside(target, path.resolve(p)) || inside(path.resolve(p), target))) {
                actions.push({ path: label, status: 'SKIPPED', reason: 'BUSINESS_STORAGE' }); continue;
            }
            if (testsRunning) { actions.push({ path: label, status: 'SKIPPED', reason: 'TESTS_RUNNING' }); continue; }
            const stat = await fs.lstat(target);
            if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await fs.realpath(root), await fs.realpath(target))) throw new Error('Invalid temporary directory');
            if (screenshotName.test(name)) {
                const entries = await fs.readdir(target, { withFileTypes: true });
                if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !/\.png$/i.test(entry.name)) || stat.mtimeMs > Date.now() - 86400000) { actions.push({ path: label, status: 'SKIPPED', reason: 'RECENT_OR_UNKNOWN_FILES' }); continue; }
            }
            const database = fixtureName.test(name) ? path.join(root, 'postgres-' + name.replace(/^postgres-/, '')) : target;
            if (!await databaseStopped(database)) { actions.push({ path: label, status: 'SKIPPED', reason: 'DATABASE_RUNNING' }); continue; }
            const size = await sizeOf(target);
            await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            actions.push({ path: label, status: 'DELETED', ...size });
        } catch { actions.push({ path: label, status: 'FAILED', reason: 'PATH_OR_PROCESS_CHECK_FAILED' }); }
    }
    return actions;
}
