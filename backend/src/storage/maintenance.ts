import { BadRequestException } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShopService } from '../modules/shop.service';
import { cleanRuntimeFixtures, isRuntimeFixture } from './runtime-fixtures';
import { LocalStorage } from './local';
const projectRoot = path.resolve(__dirname, '../../..');
const inside = (root: string, target: string) => target.startsWith(path.resolve(root) + path.sep);
const fileIdentity = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
async function referencedFiles(shop: ShopService, db: any = shop.db, catalogOnly = false) {
    const storage = new LocalStorage(shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT);
    const [versions, settings, attachments] = await Promise.all([
        db.fileVersion.findMany({ select: { key: true, previews: true } }),
        db.setting.findMany({ where: { key: { startsWith: 'purchaseFile:' } } }),
        catalogOnly ? [] : db.chatAttachment.findMany({ select: { key: true } })
    ]);
    const keys = [...versions.flatMap((v: any) => [v.key, ...(v.previews as string[])]), ...settings.map((s: any) => s.value?.key).filter(Boolean), ...attachments.map((a: any) => a.key)];
    return new Set<string>(keys.map(key => fileIdentity(storage.resolve(key))));
}
async function storageFiles(roots: string[]) {
    const files: { path: string; bytes: number; modified: number }[] = [];
    async function visit(folder: string) {
        const stat = await fs.lstat(folder).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat || stat.isSymbolicLink()) return;
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
            const target = path.resolve(folder, entry.name);
            if (!roots.some(root => inside(root, target)) || entry.isSymbolicLink() || entry.name.startsWith('.purge-')) continue;
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) { const stat = await fs.lstat(target); files.push({ path: target, bytes: stat.size, modified: stat.mtimeMs }); }
        }
    }
    for (const root of roots) await visit(root);
    return files;
}
export async function runtimeFiles(shop: ShopService, runtimeRoot = path.join(projectRoot, '.runtime')) {
    const root = runtimeRoot; // Optional root is used by isolated filesystem tests.
    const files: { path: string; bytes: number }[] = [];
    async function visit(folder: string) {
        for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; })) {
            const target = path.resolve(folder, entry.name);
            if (!target.startsWith(root + path.sep) || entry.isSymbolicLink()) continue;
            if (entry.isDirectory() && isRuntimeFixture(entry.name)) continue;
            // Databases and uploaded files are excluded even when configured inside .runtime.
            if ([shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT].some(r => target === r || target.startsWith(r + path.sep))) continue;
            if (entry.isDirectory() && !/postgres|database|backup/i.test(entry.name)) await visit(target);
            else if (entry.isFile() && /\.(log|tmp)$/i.test(entry.name)) files.push({ path: target, bytes: (await fs.lstat(target)).size });
        }
    }
    const stat = await fs.lstat(root).catch(() => null);
    if (stat && !stat.isSymbolicLink()) await visit(root);
    return files;
}
export async function cleanRuntimeFiles(shop: ShopService, runtimeRoot?: string) {
    let removedFiles = 0, freedBytes = 0, failedFiles = 0;
    for (const file of await runtimeFiles(shop, runtimeRoot)) {
        try {
            try { await fs.unlink(file.path); } catch (e: any) {
                // Windows can hold active log files open. Clear their contents without interrupting services.
                if (/\.log$/i.test(file.path) && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) await fs.truncate(file.path, 0);
                else throw e;
            }
            removedFiles++; freedBytes += file.bytes;
        } catch { failedFiles++; }
    }
    const actions = await cleanRuntimeFixtures([shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT], runtimeRoot);
    const removed = actions.filter(action => action.status === 'DELETED');
    removedFiles += removed.reduce((sum, action) => sum + (action.files || 0), 0);
    freedBytes += removed.reduce((sum, action) => sum + (action.bytes || 0), 0);
    failedFiles += actions.filter(action => action.status === 'FAILED').length;
    // Retain every referenced original, historical version, catalog copy, preview and chat attachment.
    // Newly written files may belong to an upload not committed yet; leave them for at least a day.
    {
        const roots = [...new Set([shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT])].map(r => path.resolve(r)).filter((r, _, all) => !all.some(other => other !== r && inside(other, r)));
        for (const root of roots) {
            const protectedPaths = [projectRoot, ...['backend', 'frontend', 'scripts', 'node_modules', 'docs', 'infra', '.runtime'].map(name => path.join(projectRoot, name))];
            if (root === path.parse(root).root || protectedPaths.some(p => p === root || inside(root, p)) || ['backend', 'frontend', 'scripts', 'node_modules', 'docs', 'infra'].some(name => inside(path.join(projectRoot, name), root))) throw new BadRequestException('Storage configuration overlaps protected project files');
            await fs.mkdir(root, { recursive: true });
            if (await fs.realpath(root) !== root) throw new BadRequestException('Linked storage roots cannot be cleaned');
        }
        const candidates = (await storageFiles(roots)).filter(f => f.modified < Date.now() - 86400000);
        const referenced = await referencedFiles(shop);
        for (const file of candidates) {
            if (referenced.has(fileIdentity(file.path))) continue;
            try { await fs.unlink(file.path); removedFiles++; freedBytes += file.bytes; } catch { failedFiles++; }
        }
        // Only generated reports and disposable build caches; source, credentials, backups and running builds remain.
        for (const relative of runtimeRoot ? [] : ['test-results', 'playwright-report', 'frontend/.next/cache', 'frontend/.next/dev/cache', '.cache/tmp']) {
            const root = path.resolve(projectRoot, relative);
            for (const file of await storageFiles([root])) {
                if (file.modified >= Date.now() - 86400000) continue;
                try { await fs.unlink(file.path); removedFiles++; freedBytes += file.bytes; } catch { failedFiles++; }
            }
        }
        if (!runtimeRoot) {
            // Generated investigation scripts/screenshots are disposable; account files and backups are retained.
            for (const folder of [projectRoot, path.join(projectRoot, '.runtime')]) {
                for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
                    if (!entry.isFile() || entry.isSymbolicLink()) continue;
                    const temporary = folder === projectRoot ? /^_[^/]+\.(png|css|cjs)$/.test(entry.name)
                        : !/^(admin|backup|local|file-layout-backup)/i.test(entry.name) && /\.(png|webp|svg|py|cjs|mjs)$/.test(entry.name);
                    if (!temporary) continue;
                    const file = path.resolve(folder, entry.name), stat = await fs.lstat(file);
                    if (stat.mtimeMs >= Date.now() - 86400000) continue;
                    try { await fs.unlink(file); removedFiles++; freedBytes += stat.size; } catch { failedFiles++; }
                }
            }
        }
    }
    return { removedFiles, freedBytes, failedFiles, removedDirectories: removed.length, skippedDirectories: actions.filter(action => action.status === 'SKIPPED').length, actions };
}
export async function storageOverview(shop: ShopService) {
    const roots = [...new Set([shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT])].filter((r, _, all) => !all.some(other => other !== r && r.startsWith(other + path.sep)));
    const categories: Record<string, number> = { originals: 0, previews: 0, attachments: 0, other: 0, logs: 0, database: 0 };
    async function visit(folder: string) {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const target = path.join(folder, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) {
                const key = /[\\/]chat[\\/]/.test(target) ? 'attachments' : /\.pptx$/i.test(entry.name) ? 'originals' : /\.(webp|png|jpe?g)$/i.test(entry.name) ? 'previews' : 'other';
                categories[key] += (await fs.stat(target)).size;
            }
        }
    }
    for (const root of roots) { await fs.mkdir(root, { recursive: true }); await visit(root); }
    categories.logs = (await runtimeFiles(shop)).reduce((n, file) => n + file.bytes, 0);
    const tables = await shop.db.$queryRaw<{ name: string; bytes: bigint }[]>`SELECT relname AS name, pg_total_relation_size(relid) AS bytes FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC`;
    const database = await shop.db.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`;
    categories.database = Number(database[0].bytes);
    const disks = await Promise.all(roots.map(r => fs.statfs(r)));
    return { usedBytes: Object.values(categories).reduce((a, b) => a + b, 0), freeBytes: Math.min(...disks.map(d => Number(d.bavail) * Number(d.bsize))), maxBytes: shop.config.STORAGE_MAX_BYTES, categories, tables: tables.map(t => ({ name: t.name, bytes: Number(t.bytes) })) };
}

export async function assertStorageCapacity(shop: ShopService, additionalBytes: number) {
    const usage = await storageOverview(shop);
    if (usage.usedBytes + additionalBytes > usage.maxBytes || usage.freeBytes < additionalBytes + 64 * 1024 * 1024)
        throw new BadRequestException({ code: 'STORAGE_QUOTA_REACHED', message: 'Total storage quota or available disk space exceeded' });
}

export async function clearBusinessData(shop: ShopService, actorId: string, requestId: string) {
    const roots = [...new Set([shop.config.STORAGE_ROOT, shop.config.PURCHASE_ROOT])].filter((r, _, all) => !all.some(other => other !== r && r.startsWith(other + path.sep)));
    const staged: { root: string; folder: string; names: string[] }[] = [];
    async function inspect(target: string): Promise<void> {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new BadRequestException('Linked storage paths cannot be cleared');
        if (stat.isDirectory()) for (const name of await fs.readdir(target)) await inspect(path.join(target, name));
    }
    for (const root of roots) {
        const resolved = path.resolve(root);
        const protectedPaths = [projectRoot, ...['backend', 'frontend', 'scripts', 'node_modules', 'docs', 'infra', '.runtime'].map(name => path.join(projectRoot, name))];
        if (resolved === path.parse(resolved).root || protectedPaths.some(p => p === resolved || p.startsWith(resolved + path.sep)) || ['backend', 'frontend', 'scripts', 'node_modules', 'docs', 'infra'].some(name => resolved.startsWith(path.join(projectRoot, name) + path.sep)))
            throw new BadRequestException('Storage configuration overlaps protected project files');
        await fs.mkdir(root, { recursive: true });
        if (await fs.realpath(root) !== resolved) throw new BadRequestException('Storage path must not contain links');
        await inspect(root);
    }
    let records = 0;
    try {
        await shop.db.$transaction(async tx => {
            await shop.lock(tx, 'storage-capacity');
            // Lock the business tables before changing files so concurrent requests cannot create dangling records.
            await tx.$executeRawUnsafe('LOCK TABLE "DownloadLog", "DownloadToken", "Entitlement", "Refund", "MockPayment", "PaymentEvent", "Payment", "OrderItem", "SupportTicket", "Order", "ChatAttachment", "ChatMessage", "ChatConversation", "CustomerToken", "RecoveryToken", "Customer", "FileVersion", "Price", "Product", "Category", "MailMessage", "Job", "AnalyticsEvent", "FxSnapshot" IN ACCESS EXCLUSIVE MODE');
            const retained = await referencedFiles(shop, tx, true);
            for (const root of roots) {
                const files = await storageFiles([root]), folder = path.join(root, '.purge-' + randomUUID());
                await fs.mkdir(folder); const item = { root, folder, names: [] as string[] }; staged.push(item);
                for (const file of files) {
                    if (retained.has(fileIdentity(file.path))) continue;
                    const name = path.relative(root, file.path);
                    await fs.mkdir(path.dirname(path.join(folder, name)), { recursive: true });
                    await fs.rename(file.path, path.join(folder, name)); item.names.push(name);
                }
            }
            for (const model of [tx.downloadLog, tx.downloadToken, tx.entitlement, tx.refund, tx.mockPayment, tx.paymentEvent, tx.orderItem, tx.payment, tx.supportTicket, tx.order, tx.chatAttachment, tx.chatMessage, tx.chatConversation, tx.customerToken, tx.recoveryToken, tx.analyticsEvent]) {
                records += (await (model.deleteMany as any)({})).count;
            }
            records += (await tx.session.deleteMany({ where: { adminId: null } })).count;
            records += (await tx.customer.deleteMany()).count;
            for (const model of [tx.mailMessage, tx.job, tx.fxSnapshot, tx.audit]) records += (await (model.deleteMany as any)({})).count;
            await tx.setting.deleteMany({ where: { key: { startsWith: 'chat-customer-profile:' } } });
            await shop.audit(tx, actorId, 'BUSINESS_DATA_CLEAR', 'business', { records }, requestId);
        }, { timeout: 120000 });
    } catch (error) {
        // Restore staged files when the database transaction rolls back.
        for (const item of staged.reverse()) {
            for (const name of item.names) await fs.rename(path.join(item.folder, name), path.join(item.root, name));
            await fs.rm(item.folder, { recursive: true });
        }
        throw error;
    }
    let failedFiles = 0;
    for (const item of staged) {
        try { await inspect(item.folder); await fs.rm(item.folder, { recursive: true }); }
        catch { failedFiles++; }
    }
    await fs.mkdir(shop.config.STORAGE_ROOT, { recursive: true });
    await fs.mkdir(shop.config.PURCHASE_ROOT, { recursive: true });
    return { cleared: true, records, removedFiles: staged.reduce((sum, item) => sum + item.names.length, 0), failedFiles };
}
