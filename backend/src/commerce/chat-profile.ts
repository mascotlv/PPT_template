import { z } from 'zod';
import type { DB } from '../db';

export const avatarInput = z.string().max(200000).regex(/^$|^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
export const nicknameInput = z.string().trim().min(1).max(80);
export const sellerProfileKey = 'chat-seller-profile';
export const customerProfileKey = (id: string) => 'chat-customer-profile:' + id;
export async function sellerProfile(db: DB) {
    const value = (await db.setting.findUnique({ where: { key: sellerProfileKey } }))?.value as any;
    return { nickname: value?.nickname || '商家', isDefaultNickname: !value?.nickname, avatar: value?.avatar || '', language: 'zh' };
}
export async function customerProfile(db: DB, customer: { id: string; name: string; language: string }) {
    const value = (await db.setting.findUnique({ where: { key: customerProfileKey(customer.id) } }))?.value as any;
    return { nickname: value?.nickname || customer.name, avatar: value?.avatar || '', language: customer.language };
}

// Busboy decodes raw UTF-8 multipart filename bytes as Latin-1. Only repair a
// reversible, valid UTF-8 sequence; preserve genuine Unicode and legacy names.
export function uploadFilename(name: string) {
    if ([...name].some(c => c.codePointAt(0)! > 255)) return name;
    const bytes = Buffer.from(name, 'latin1');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return name; }
}
