import { avatarInput, nicknameInput, customerProfileKey } from './chat-profile';
import { BadRequestException, ForbiddenException, UnauthorizedException, ServiceUnavailableException, Controller, Get, Post, Patch, Req, Res, Body, Query } from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import type { Response } from 'express';
import { Auth, Context } from '../modules/auth';
import { ShopService } from '../modules/shop.service';
import { hash, token, encrypt } from '../security';
import { COUNTRIES, CURRENCIES, LANGUAGES } from './constants';
const email = z.email().max(254).transform(v => v.toLowerCase());
const password = z.string().min(12).max(128);
function read<T>(schema: z.ZodType<T>, body: unknown) { const p = schema.safeParse(body); if (!p.success)
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid account details' }); return p.data; }
@Controller('account')
export class AccountController {
    constructor(readonly shop: ShopService, readonly auth: Auth) { }
    requireMail() { if (this.shop.config.ACCOUNT_REQUIRE_SMTP && (this.shop.config.MAIL_TRANSPORT !== 'smtp' || !this.shop.config.SMTP_USER || !this.shop.config.SMTP_PASSWORD || this.shop.config.MAIL_FROM.endsWith('.test')))
        throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED', message: 'Registration email delivery is not configured' }); }
    @Get('orders')
    async orders(
    @Req()
    req: Context, 
    @Query()
    query: unknown) { const customer = this.auth.requireCustomer(req), p = read(z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1) }).strict(), query), where = { OR: [{ customerId: customer.id }, { email: customer.email }] }; const [rows, total] = await Promise.all([this.shop.db.order.findMany({ where, skip: (p.page - 1) * 25, take: 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { item: { include: { fileVersion: true, entitlement: true } }, payments: true, refunds: true, tickets: true } }), this.shop.db.order.count({ where })]); return { rows: rows.map(o => this.shop.publicOrder(o)), total, page: p.page }; }
    async rotate(req: Context, res: Response, customerId: string) { const old = this.auth.requireGuest(req); const fresh = await this.auth.create(res, 'GUEST', 'guest', { customerId }); await this.shop.db.session.update({ where: { id: old.id }, data: { revokedAt: new Date() } }); return { csrf: fresh.csrf }; }
    async mail(customer: any, kind: string) { return this.shop.db.$transaction(tx => this.queueMail(tx, customer, kind)); }
    async queueMail(tx: any, customer: any, kind: string) { this.requireMail(); const raw = token(); const record = await tx.customerToken.create({ data: { customerId: customer.id, kind, tokenHash: hash(raw), expiresAt: new Date(Date.now() + (kind === 'RESET' ? 15 * 60000 : 24 * 3600000)) } }); await this.shop.job(tx, 'ACCOUNT', customer.id, `account:${record.id}`, { email: customer.email, language: customer.language, template: kind, encryptedToken: encrypt(raw, this.shop.config.ADMIN_ENCRYPTION_KEY) }); }
    @Post('register')
    async register(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response, 
    @Body()
    body: unknown) {
        this.requireMail();
        await this.auth.rate(req, 'register', 5, 15 * 60000);
        const p = read(z.object({ email, password, name: z.string().trim().min(2).max(80), country: z.enum(COUNTRIES), language: z.enum(LANGUAGES), currency: z.enum(CURRENCIES) }).strict(), body);
        if (await this.shop.db.customer.findUnique({ where: { email: p.email } }))
            throw new BadRequestException({ code: 'ACCOUNT_EXISTS', message: 'Unable to register; sign in or reset password' });
        const { password: raw, ...profile } = p;
        const passwordHash = await argon2.hash(raw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
        const customer = await this.shop.db.$transaction(async (tx) => { const created = await tx.customer.create({ data: { ...profile, passwordHash } }); await this.queueMail(tx, created, 'VERIFY'); return created; });
        return { ...await this.rotate(req, res, customer.id), verificationRequired: true };
    }
    @Post('login')
    async login(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response, 
    @Body()
    body: unknown) {
        const p = read(z.object({ email, password: z.string().min(1).max(128) }).strict(), body);
        await this.auth.rate(req, 'customer-login-ip', 40, 15 * 60000);
        await this.auth.rate(req, 'customer-login', 8, 15 * 60000, p.email);
        const customer = await this.shop.db.customer.findUnique({ where: { email: p.email } });
        if (!await this.auth.validPassword(customer, p.password))
            throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid sign-in details' });
        return this.rotate(req, res, customer!.id);
    }
    @Post('logout')
    async logout(
    @Req()
    req: Context, 
    @Res({ passthrough: true })
    res: Response) { const old = this.auth.requireGuest(req); await this.shop.db.session.update({ where: { id: old.id }, data: { revokedAt: new Date() } }); const fresh = await this.auth.create(res, 'GUEST', 'guest'); return { csrf: fresh.csrf }; }
    @Post('verify/resend')
    async resend(
    @Req()
    req: Context) { this.requireMail(); await this.auth.rate(req, 'verification-mail', 3, 3600000); const customer = this.auth.requireCustomer(req, false); if (!customer.emailVerifiedAt)
        await this.mail(customer, 'VERIFY'); return { queued: true }; }
    @Post('verify')
    async verify(
    @Req()
    req: Context, 
    @Body()
    body: unknown) {
        await this.auth.rate(req, 'account-verify', 10);
        const p = read(z.object({ token: z.string().min(32).max(100) }).strict(), body);
        await this.shop.db.$transaction(async (tx) => { const record = await tx.customerToken.findUnique({ where: { tokenHash: hash(p.token) } }); if (!record || record.kind !== 'VERIFY' || record.consumedAt || record.expiresAt <= new Date())
            throw new BadRequestException({ code: 'TOKEN_EXPIRED', message: 'Verification link expired or used' }); const consumed = await tx.customerToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() } }); if (!consumed.count)
            throw new BadRequestException('Link already used'); const customer = await tx.customer.findUniqueOrThrow({ where: { id: record.customerId } }); if (customer.disabled)
            throw new ForbiddenException('Account disabled'); await tx.customer.update({ where: { id: record.customerId }, data: { emailVerifiedAt: new Date() } }); await tx.order.updateMany({ where: { email: customer.email, customerId: null }, data: { customerId: customer.id } }); });
        return { verified: true };
    }
    @Post('password/request')
    async request(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { this.requireMail(); const p = read(z.object({ email }).strict(), body); await this.auth.rate(req, 'password-request', 3, 15 * 60000, p.email); const customer = await this.shop.db.customer.findUnique({ where: { email: p.email } }); if (customer && !customer.disabled)
        await this.mail(customer, 'RESET'); return { queued: true }; }
    @Post('password/reset')
    async reset(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { await this.auth.rate(req, 'password-reset', 8, 15 * 60000); const p = read(z.object({ token: z.string().min(32).max(100), password }).strict(), body); const passwordHash = await argon2.hash(p.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }); await this.shop.db.$transaction(async (tx) => { const record = await tx.customerToken.findUnique({ where: { tokenHash: hash(p.token) } }); if (!record || record.kind !== 'RESET' || record.consumedAt || record.expiresAt <= new Date())
        throw new BadRequestException({ code: 'TOKEN_EXPIRED', message: 'Reset link expired or used' }); await this.shop.lock(tx, 'customer:' + record.customerId); const consumed = await tx.customerToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() } }); if (!consumed.count)
        throw new BadRequestException('Link already used'); const customer = await tx.customer.findUniqueOrThrow({ where: { id: record.customerId } }); if (customer.disabled)
        throw new ForbiddenException('Account disabled'); await tx.customer.update({ where: { id: record.customerId }, data: { passwordHash } }); await tx.customerToken.updateMany({ where: { customerId: record.customerId, kind: 'RESET', consumedAt: null }, data: { consumedAt: new Date() } }); await tx.session.updateMany({ where: { customerId: record.customerId }, data: { revokedAt: new Date() } }); }); return { reset: true }; }
    @Patch('profile')
    async profile(
    @Req()
    req: Context, 
    @Body()
    body: unknown) { const customer = this.auth.requireCustomer(req, false); const p = read(z.object({ name: z.string().trim().min(2).max(80), country: z.enum(COUNTRIES), language: z.enum(LANGUAGES), currency: z.enum(CURRENCIES), nickname: nicknameInput.optional(), avatar: avatarInput.optional() }).strict(), body);
        const { nickname, avatar, ...identity } = p;
        await this.shop.db.$transaction(async tx => {
            await tx.customer.update({ where: { id: customer.id }, data: identity });
            if (nickname !== undefined || avatar !== undefined) {
                const key = customerProfileKey(customer.id), old = (await tx.setting.findUnique({ where: { key } }))?.value as any;
                const value = { nickname: nickname ?? old?.nickname ?? customer.name, avatar: avatar ?? old?.avatar ?? '' };
                await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
            }
        }); return { saved: true }; }
}
