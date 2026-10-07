import { randomBytes, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { DIGITS } from './commerce/constants';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: any): string { return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((out: any, key) => { out[key] = v[key]; return out; }, {}) : v); }
export function same(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
export const mac = (key: string, body: string) => createHmac('sha256', key).update(body).digest('hex');
export function encrypt(value: string, key: string) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); const body = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64'); }
export function decrypt(value: string, key: string) { const b = Buffer.from(value, 'base64'); const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
export function otp(secret: string, code: string) { return new OTPAuth.TOTP({ issuer: 'Template Workshop', secret: OTPAuth.Secret.fromBase32(secret) }).validate({ token: code, window: 1 }) !== null; }
export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const csvCell = (v: unknown) => '"' + String(v ?? '').replace(/^[\s]*[=+@-]/, "'$&").replace(/"/g, '""') + '"';
export function money(amount: number, currency: string) { if (!(currency in DIGITS) || !Number.isSafeInteger(amount) || amount < 0)
    throw new Error('Invalid money'); return (amount / 10 ** DIGITS[currency]).toFixed(DIGITS[currency]); }
