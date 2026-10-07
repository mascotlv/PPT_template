import fs from 'node:fs/promises';
import path from 'node:path';
export async function storageHealth(root: string) { let usedBytes = 0; async function visit(folder: string) { for (const name of await fs.readdir(folder)) {
    const target = path.join(folder, name), stat = await fs.lstat(target);
    if (stat.isSymbolicLink())
        throw new Error('Linked storage paths are not allowed');
    if (stat.isDirectory())
        await visit(target);
    else if (stat.isFile())
        usedBytes += stat.size;
} } await fs.mkdir(root, { recursive: true }); await visit(root); const disk = await fs.statfs(root); return { usedBytes, freeBytes: Number(disk.bavail) * Number(disk.bsize) }; }
