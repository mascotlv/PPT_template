import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException } from '@nestjs/common';
import { DB } from '../db';
import { Config } from '../config';
import { LocalStorage } from './local';
import { hash } from '../security';
// The visible file is replaceable; paid orders continue to reference immutable private originals.
export async function syncCurrent(tx: any, storage: LocalStorage, product: any, latest: any) {
    if (!latest)
        return;
    const key = storage.currentKey(product.category.nameZh, product.titleZh), settingKey = 'purchaseFile:' + product.id;
    await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${'catalog:' + key.toLowerCase()}))`;
    const settings = await tx.setting.findMany({ where: { key: { startsWith: 'purchaseFile:' } } });
    if (settings.some((s: any) => s.key !== settingKey && s.value?.key?.toLowerCase() === key.toLowerCase()))
        throw new ConflictException({ code: 'FILE_NAME_CONFLICT', message: 'Another product uses this category and file title' });
    const old = settings.find((s: any) => s.key === settingKey)?.value;
    const bytes = await fs.readFile(storage.resolve(latest.key));
    if (hash(bytes) !== latest.sha256)
        throw new Error('Original integrity check failed');
    // Do not replace an unknown user file that was not created by this store.
    try {
        const existing = await fs.readFile(storage.resolve(key));
        if (old?.key !== key && hash(existing) !== latest.sha256)
            throw new ConflictException({ code: 'FILE_NAME_CONFLICT', message: 'An unmanaged file already exists at this title' });
    }
    catch (e: any) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    await storage.replace(key, bytes);
    await tx.setting.upsert({ where: { key: settingKey }, create: { key: settingKey, value: { key, fileVersionId: latest.id, sha256: latest.sha256 } }, update: { value: { key, fileVersionId: latest.id, sha256: latest.sha256 } } });
    if (old?.key && old.key !== key) {
        const prior = storage.resolve(old.key);
        try {
            if (hash(await fs.readFile(prior)) === old.sha256) {
                await fs.unlink(prior);
                await fs.rmdir(path.dirname(prior)).catch(() => { });
            }
        }
        catch (e: any) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    return key;
}
export async function normalizePurchaseFiles(db: DB, config: Config) {
    const storage = new LocalStorage(config.STORAGE_ROOT, config.PURCHASE_ROOT);
    let moved = 0, current = 0;
    const obsolete: string[] = [];
    for (const product of await db.product.findMany({ include: { category: true, versions: { orderBy: { createdAt: 'desc' } } } })) {
        for (const file of product.versions) {
            if (file.key.startsWith('history/'))
                continue;
            const bytes = await fs.readFile(storage.resolve(file.key));
            if (hash(bytes) !== file.sha256)
                throw new Error('Original integrity check failed');
            const key = `history/${file.id}/${file.filename}`;
            let stored;
            try {
                stored = await storage.putHistory(bytes, file.id, file.filename.replace(/\.pptx$/i, ''));
            }
            catch (e: any) {
                if (e.code !== 'EEXIST')
                    throw e;
                if (hash(await fs.readFile(storage.resolve(key))) !== file.sha256)
                    throw new Error('History collision');
                stored = { key };
            }
            const old = file.key;
            await db.fileVersion.update({ where: { id: file.id }, data: { key: stored.key } });
            file.key = stored.key;
            obsolete.push(old);
            moved++;
        }
        if (product.versions[0]) {
            await db.$transaction(async (tx) => { await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${'product:' + product.id}))`; await syncCurrent(tx, storage, product, product.versions[0]); });
            current++;
        }
    }
    for (const key of obsolete) {
        if (await db.fileVersion.count({ where: { key } }))
            continue;
        const target = storage.resolve(key);
        await fs.unlink(target).catch((e: any) => { if (e.code !== 'ENOENT')
            throw e; });
        if (key.startsWith('purchased/')) {
            await fs.rmdir(path.dirname(target)).catch(() => { });
            await fs.rmdir(path.dirname(path.dirname(target))).catch(() => { });
        }
    }
    return { moved, current };
}
