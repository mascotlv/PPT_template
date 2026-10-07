import * as argon2 from 'argon2';
import * as OTPAuth from 'otpauth';
import fs from 'node:fs/promises';
import path from 'node:path';
import { database, DB } from './db';
import { Config, parseConfig } from './config';
import { encrypt, hash, token } from './security';
export async function initializeAdmin(db: DB, c: Config, input: {
    email: string;
    password: string;
    role: 'ADMIN' | 'SUPPORT';
    secret?: string;
}) {
    if (input.password.length < 16 || !/^\S+@\S+\.\S+$/.test(input.email))
        throw new Error('Valid email and password of at least 16 characters required');
    if (await db.admin.findUnique({ where: { email: input.email.toLowerCase() } }))
        throw new Error('Administrator already exists; password will not be overwritten');
    const secret = input.secret || new OTPAuth.Secret({ size: 20 }).base32;
    const recoveryCodes = Array.from({ length: 8 }, () => token().slice(0, 20));
    const admin = await db.admin.create({ data: { email: input.email.toLowerCase(), role: input.role, passwordHash: await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }), totpEncrypted: encrypt(secret, c.ADMIN_ENCRYPTION_KEY), recoveryHashes: recoveryCodes.map(hash) } });
    await db.audit.create({ data: { actorId: 'controlled-initialization', action: 'ADMIN_CREATE', objectId: admin.id, summary: { role: input.role }, requestId: token() } });
    return { email: input.email, secret, recoveryCodes, otpauth: new OTPAuth.TOTP({ issuer: 'Template Workshop', label: input.email, secret: OTPAuth.Secret.fromBase32(secret) }).toString() };
}
if (require.main === module) {
    const c = parseConfig(process.env);
    const db = database(c.DATABASE_URL);
    (async () => {
        // Use a protected stdin JSON document; no password in command arguments or logs.
        let input = '';
        for await (const chunk of process.stdin)
            input += chunk;
        const parsed = JSON.parse(input);
        const info = await initializeAdmin(db, c, { ...parsed, role: parsed.role || 'ADMIN' });
        const root = path.basename(path.dirname(__dirname)) === 'backend' ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..');
        const output = path.resolve(root, '.runtime', 'admin-setup.json');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, JSON.stringify(info, null, 2), { mode: 0o600, flag: 'wx' });
        console.log('Admin initialized. Second factor and recovery codes saved in project .runtime/admin-setup.json; protect and remove after enrollment.');
    })().catch(() => { console.error('Administrator initialization failed (credentials withheld)'); process.exitCode = 1; }).finally(() => db.$disconnect());
}
