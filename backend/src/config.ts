import { z } from 'zod';
import path from 'node:path';
const schema = z.object({
    APP_ENV: z.enum(['local', 'staging', 'production']), PAYMENT_MODE: z.enum(['mock', 'live']),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//), PUBLIC_ORIGIN: z.url(),
    SESSION_SECRET: z.string().min(32), MOCK_SIGNING_KEY: z.string().min(32).optional(),
    ADMIN_ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i), TEST_ACCESS_PASSWORD: z.string().min(16).optional(),
    STORE_ACCESS_MODE: z.enum(['account', 'password']).default('account'),
    DEV_AUTH_BYPASS: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
    STORAGE_ROOT: z.string().min(1), MAIL_TRANSPORT: z.enum(['smtp', 'outbox']),
    CHAT_TRANSLATION_URL: z.url().optional(),
    CHAT_TRANSLATION_KEY: z.string().min(1).optional(),
    GOOGLE_TRANSLATION_KEY: z.string().min(1).optional(),
    ACCOUNT_REQUIRE_SMTP: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
    PURCHASE_ROOT: z.string().min(1).optional(),
    SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().int().positive().optional(), MAIL_FROM: z.email(),
    SMTP_USER: z.string().min(1).optional(), SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_SECURE: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
    SMTP_REQUIRE_TLS: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
    OWNER_REFUND_EMAIL: z.email().default('2797687455@qq.com'),
    OWNER_PURCHASE_EMAIL: z.email().default('Gowdybunde@gmail.com'),
    FX_AUTOMATIC_REFRESH: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100), LIVE_PROVIDERS: z.string().default(''),
    STORAGE_MAX_BYTES: z.coerce.number().int().min(20 * 1024 * 1024).max(400 * 1024 * 1024 * 1024).default(400 * 1024 * 1024 * 1024)
});
export function parseConfig(env: NodeJS.ProcessEnv) {
    const parsed = schema.safeParse(env);
    if (!parsed.success)
        throw new Error(`Configuration invalid: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
    const c = parsed.data;
    if (c.DEV_AUTH_BYPASS && (c.APP_ENV !== 'local' || c.PAYMENT_MODE !== 'mock' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.PUBLIC_ORIGIN).hostname)))
        throw new Error('Development login bypass requires local mock mode and a loopback origin');
    if (c.APP_ENV === 'production' && c.PAYMENT_MODE === 'mock')
        throw new Error('Production forbids simulated payments');
    if (c.LIVE_PROVIDERS.trim())
        throw new Error('Real payment adapters are not implemented; cannot enable');
    if (c.PAYMENT_MODE === 'mock' && !c.MOCK_SIGNING_KEY)
        throw new Error('MOCK_SIGNING_KEY required');
    if (c.APP_ENV !== 'production' && c.STORE_ACCESS_MODE === 'password' && !c.TEST_ACCESS_PASSWORD)
        throw new Error('Test access password required');
    if (c.MAIL_TRANSPORT === 'smtp' && (!c.SMTP_HOST || !c.SMTP_PORT))
        throw new Error('SMTP configuration required');
    if (!!c.SMTP_USER !== !!c.SMTP_PASSWORD)
        throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
    if (c.SMTP_USER && !c.SMTP_SECURE && !c.SMTP_REQUIRE_TLS)
        throw new Error('Authenticated SMTP requires TLS');
    if (c.APP_ENV !== 'local' && (new URL(c.PUBLIC_ORIGIN).protocol !== 'https:' || c.MAIL_TRANSPORT === 'outbox'))
        throw new Error('Deployed environments require HTTPS and isolated SMTP');
    return { ...c, STORAGE_ROOT: path.resolve(c.STORAGE_ROOT), PURCHASE_ROOT: path.resolve(c.PURCHASE_ROOT || path.join(c.STORAGE_ROOT, '购买文件')) };
}
export type Config = ReturnType<typeof parseConfig>;
