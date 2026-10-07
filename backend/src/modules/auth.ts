import { customerProfile, sellerProfile } from '../commerce/chat-profile';
import { BadRequestException, ForbiddenException, UnauthorizedException, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as argon2 from 'argon2';
import { DB } from '../db';
import { Config } from '../config';
import { token, hash, mac, same, decrypt, encrypt, otp } from '../security';
export type Context = Request & {
    guest: any;
    admin: any;
    testAccess: any;
    requestId: string;
    rawBody?: Buffer;
};
export class Auth {
    private developmentAdmin?: Promise<any>;
    private fallbackPassword?: Promise<string>;
    constructor(readonly db: DB, readonly config: Config) { }
    // Unknown accounts still perform Argon2 work to reduce timing-based enumeration.
    async validPassword(account: any, password: string) { this.fallbackPassword ??= argon2.hash(token(), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }); const digest = account?.passwordHash || await this.fallbackPassword; const valid = await argon2.verify(digest, password); return !!account && !account.disabled && !account.email.endsWith('@development.example.test') && valid; }
    cookie(res: Response, name: string, value: string, maxAge: number) { res.cookie(name, value, { httpOnly: true, secure: this.config.APP_ENV !== 'local', sameSite: 'strict', path: '/api', maxAge }); }
    async create(res: Response, kind: string, name: string, extra: any = {}, issueCookie = true) { const raw = token(); const csrf = mac(this.config.SESSION_SECRET, raw); const s = await this.db.session.create({ data: { tokenHash: hash(raw), csrfHash: hash(csrf), kind, expiresAt: new Date(Date.now() + (kind === 'ADMIN' ? 8 : 24) * 3600000), ...extra } }); if (issueCookie)
        this.cookie(res, name, raw, (kind === 'ADMIN' ? 8 : 24) * 3600000); return { session: s, csrf, raw }; }
    async load(req: Context) { for (const [cookie, key, kind] of [['guest', 'guest', 'GUEST'], ['admin', 'admin', 'ADMIN'], ['access', 'testAccess', 'ACCESS']]) {
        const raw = req.cookies?.[cookie];
        const s = raw ? await this.db.session.findUnique({ where: { tokenHash: hash(raw) }, include: { admin: true, customer: true } }) : null;
        const validKind = s && (s.kind === kind || (this.config.DEV_AUTH_BYPASS && s.kind === 'DEV_' + kind));
        (req as any)[key] = validKind && s.expiresAt > new Date() && !s.revokedAt && !s.admin?.disabled && !s.customer?.disabled ? s : null;
    } }
    async development(req: Context, res: Response) {
        if (!this.config.DEV_AUTH_BYPASS)
            return;
        req.cookies ??= {};
        if (req.guest?.kind === 'DEV_GUEST' && req.guest.customer?.email !== req.guest.customer?.email.toLowerCase())
            req.guest.customer = await this.db.customer.update({ where: { id: req.guest.customerId }, data: { email: req.guest.customer.email.toLowerCase() } });
        if (!req.guest?.customer?.emailVerifiedAt) {
            const customer = await this.db.customer.create({ data: { email: `buyer-${token().toLowerCase()}@development.example.test`, name: '开发测试用户', country: 'CN', language: 'zh', currency: 'CNY', passwordHash: await argon2.hash(token()), emailVerifiedAt: new Date() } });
            const old = req.guest;
            const fresh = await this.create(res, 'DEV_GUEST', 'guest', { customerId: customer.id });
            if (old)
                await this.db.session.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
            req.guest = { ...fresh.session, customer };
            req.cookies.guest = fresh.raw;
        }
        if (req.admin?.kind !== 'DEV_ADMIN') {
            this.developmentAdmin ??= (async () => this.db.admin.upsert({ where: { email: 'admin@development.example.test' }, create: { email: 'admin@development.example.test', role: 'ADMIN', passwordHash: await argon2.hash(token()), totpEncrypted: encrypt('JBSWY3DPEHPK3PXP', this.config.ADMIN_ENCRYPTION_KEY), recoveryHashes: [] }, update: {} }))();
            const admin = await this.developmentAdmin;
            const fresh = await this.create(res, 'DEV_ADMIN', 'admin', { adminId: admin.id });
            req.admin = { ...fresh.session, admin };
            req.cookies.admin = fresh.raw;
        }
    }
    async bootstrap(req: Context, res: Response) {
        await this.load(req);
        await this.development(req, res);
        let csrf: string;
        if (!req.guest) {
            const created = await this.create(res, 'GUEST', 'guest');
            req.guest = created.session;
            csrf = created.csrf;
        }
        else
            csrf = mac(this.config.SESSION_SECRET, req.cookies.guest);
        const storeMode = (await this.db.setting.findUnique({ where: { key: 'storeMode' } }))?.value as any;
        const checkoutEnabled = this.config.PAYMENT_MODE === 'mock' && this.config.APP_ENV !== 'production' && storeMode?.mode !== 'normal';
        const customer = req.guest?.customer;
        const buyerProfile = customer ? await customerProfile(this.db, customer) : {};
        const merchant = await sellerProfile(this.db);
        const storefrontText = (await this.db.setting.findUnique({ where: { key: 'storefront-text' } }))?.value || {};
        return { storefrontText, csrf, developmentAuth: this.config.DEV_AUTH_BYPASS, customer: customer ? { id: customer.id, email: customer.email, name: customer.name, ...buyerProfile, country: customer.country, language: customer.language, currency: customer.currency, verified: !!customer.emailVerifiedAt } : null, adminCsrf: req.admin ? mac(this.config.SESSION_SECRET, req.cookies.admin) : null, access: this.config.DEV_AUTH_BYPASS || this.config.STORE_ACCESS_MODE === 'account' || this.config.APP_ENV === 'production' || !!req.testAccess, seller: merchant, admin: req.admin ? { ...merchant, email: req.admin.admin.email, role: req.admin.admin.role } : null, environment: this.config.APP_ENV, paymentMode: this.config.PAYMENT_MODE, checkoutEnabled, channels: Object.entries({ mock: this.config.PAYMENT_MODE === 'mock', alipay: false, wechat: false, paypal: false }).map(([provider, enabled]) => ({ provider, enabled })), brand: (await this.db.setting.findUnique({ where: { key: 'brand' } }))?.value || { nameZh: '模板工坊', nameEn: 'Template Workshop', contact: '' } };
    }
    requireAccess(req: Context) { if (!this.config.DEV_AUTH_BYPASS && this.config.STORE_ACCESS_MODE === 'password' && this.config.APP_ENV !== 'production' && !req.testAccess)
        throw new ForbiddenException({ code: 'TEST_ACCESS_REQUIRED', message: 'Enter the test store access password' }); }
    requireGuest(req: Context) { if (!req.guest)
        throw new UnauthorizedException('Purchase session required'); return req.guest; }
    requireCustomer(req: Context, verified = true) { const customer = req.guest?.customer; if (!customer || customer.disabled)
        throw new UnauthorizedException({ code: 'REGISTRATION_REQUIRED', message: 'Register or sign in before purchasing' }); if (verified && !customer.emailVerifiedAt)
        throw new ForbiddenException({ code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Verify your email before purchasing' }); return customer; }
    requireAdmin(req: Context, role?: string) { if (!req.admin)
        throw new UnauthorizedException('Admin login required'); if (role && req.admin.admin.role !== role)
        throw new ForbiddenException('Insufficient role'); return req.admin; }
    csrf(req: Context, admin = false) { const s = admin ? req.admin : req.guest; const origin = req.headers.origin; const value = String(req.headers['x-csrf-token'] || ''); if (!s || origin !== this.config.PUBLIC_ORIGIN || !same(s.csrfHash, hash(value)))
        throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'Request verification failed; refresh page' }); }
    reauth(req: Context) { const a = this.requireAdmin(req, 'ADMIN'); if (a.kind === 'DEV_ADMIN' || !a.reauthAt || Date.now() - a.reauthAt.getTime() > 5 * 60000)
        throw new ForbiddenException({ code: 'REAUTH_REQUIRED', message: 'Verify password and second factor again' }); }
    async rate(req: Context, bucket: string, limit: number, windowMs = 60000, key = '') {
        const now = new Date();
        const rateKey = hash(`${bucket}:${req.ip}:${key}`);
        const result = await this.db.$queryRaw<any[]> `INSERT INTO "RateLimit" ("key","count","resetAt") VALUES (${rateKey},1,${new Date(Date.now() + windowMs)}) ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "RateLimit"."resetAt" < ${now} THEN 1 ELSE "RateLimit"."count"+1 END, "resetAt" = CASE WHEN "RateLimit"."resetAt" < ${now} THEN ${new Date(Date.now() + windowMs)} ELSE "RateLimit"."resetAt" END RETURNING "count"`;
        if (result[0].count > limit)
            throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many attempts; try again later' }, 429);
    }
    async testLogin(req: Context, res: Response, password: string) { await this.rate(req, 'test-access', 8, 15 * 60000); if (!same(hash(password), hash(this.config.TEST_ACCESS_PASSWORD || token())))
        throw new UnauthorizedException('Incorrect access password'); await this.create(res, 'ACCESS', 'access'); return { access: true }; }
    async verifyAdmin(admin: any, password: string, code: string) {
        if (!await this.validPassword(admin, password))
            throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid sign-in details' });
        const secret = decrypt(admin.totpEncrypted, this.config.ADMIN_ENCRYPTION_KEY);
        if (!otp(secret, code)) {
            const codes = admin.recoveryHashes as string[];
            const codeHash = hash(code);
            if (!codes.includes(codeHash))
                throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid sign-in details' });
            const current = await this.db.admin.findUniqueOrThrow({ where: { id: admin.id } });
            const list = current.recoveryHashes as string[];
            const updated = await this.db.admin.updateMany({ where: { id: admin.id, recoveryHashes: { equals: list } }, data: { recoveryHashes: list.filter(v => v !== codeHash) } });
            if (!updated.count || !list.includes(codeHash))
                throw new UnauthorizedException('Recovery code used');
        }
    }
    async login(req: Context, res: Response, email: string, password: string, code: string) { await this.rate(req, 'admin-login-ip', 40, 15 * 60000); await this.rate(req, 'admin-login', 8, 15 * 60000, email.toLowerCase()); const admin = await this.db.admin.findUnique({ where: { email: email.toLowerCase() } }); await this.verifyAdmin(admin, password, code); if (req.admin)
        await this.db.session.update({ where: { id: req.admin.id }, data: { revokedAt: new Date() } }); const created = await this.create(res, 'ADMIN', 'admin', { adminId: admin!.id }); return { csrf: created.csrf, role: admin!.role }; }
    async verifyDestructive(req: Context, email: string, password: string, code: string) {
        this.requireAdmin(req, 'ADMIN');
        await this.rate(req, 'admin-destructive', 8, 15 * 60000, req.admin.adminId);
        const account = await this.db.admin.findUnique({ where: { email: email.toLowerCase() } });
        await this.verifyAdmin(account, password, code);
        if (account!.id !== req.admin.adminId) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Use the currently signed-in administrator account' });
    }
    async reverify(req: Context, password: string, code: string) { await this.rate(req, 'admin-reauth', 8, 15 * 60000, req.admin.id); await this.verifyAdmin(req.admin.admin, password, code); const now = new Date(); await this.db.session.update({ where: { id: req.admin.id }, data: { reauthAt: now } }); return { verified: true, expiresAt: new Date(now.getTime() + 5 * 60000).toISOString() }; }
    validateEmail(value: string) { if (value.length > 254)
        throw new BadRequestException('Email too long'); }
}
