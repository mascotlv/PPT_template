import { createHash } from 'node:crypto';
import type { ShopService } from '../modules/shop.service';
import { decrypt } from '../security';

export class ChatTranslation {
    private pending = new Map<string, Promise<any>>();
    constructor(private shop: ShopService) {}
    async configured() {
        const config = await this.configuration();
        return !!(config.CHAT_TRANSLATION_URL || config.GOOGLE_TRANSLATION_KEY);
    }
    async translate(content: string, target: string) {
        const config = await this.configuration();
        if (!config.CHAT_TRANSLATION_URL && !config.GOOGLE_TRANSLATION_KEY)
            return { status: 'unconfigured', text: '', target };
        const key = 'chat-translation:' + createHash('sha256').update(content + '\0' + target).digest('hex');
        const cached = (await this.shop.db.setting.findUnique({ where: { key } }))?.value as any;
        if (cached) return { status: 'ready', ...cached };
        if (this.pending.has(key)) return this.pending.get(key);
        const request = this.request(content, target).then(async value => {
            if (value.status === 'ready') {
                const stored = { text: value.text, target };
                await this.shop.db.setting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } });
            }
            return value;
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, request);
        return request;
    }
    private async configuration() {
        const config = this.shop.config;
        const value = (await this.shop.db.setting.findUnique({ where: { key: 'chat-translation-config' } }))?.value as any;
        if (!value) return config;
        const key = value.encryptedKey ? decrypt(value.encryptedKey, config.ADMIN_ENCRYPTION_KEY) : undefined;
        return { ...config, CHAT_TRANSLATION_URL: value.provider === 'libretranslate' ? value.url : undefined, CHAT_TRANSLATION_KEY: value.provider === 'libretranslate' ? key : undefined, GOOGLE_TRANSLATION_KEY: value.provider === 'google' ? key : undefined };
    }
    private async request(content: string, target: string) {
        try {
            const config = await this.configuration(), google = !config.CHAT_TRANSLATION_URL;
            const url = google ? 'https://translation.googleapis.com/language/translate/v2' : config.CHAT_TRANSLATION_URL!;
            const code = target === 'zh' ? (google ? 'zh-CN' : 'zh') : target;
            const body = google ? { q: content, target: code, format: 'text', key: config.GOOGLE_TRANSLATION_KEY } : { q: content, source: 'auto', target: code, format: 'text', ...(config.CHAT_TRANSLATION_KEY ? { api_key: config.CHAT_TRANSLATION_KEY } : {}) };
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('Translation unavailable');
            const result = await response.json() as any;
            let text = google ? result.data?.translations?.[0]?.translatedText : result.translatedText;
            if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid translation');
            if (google) text = text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity: string, code: string) => {
                const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
                if (!code.startsWith('#')) return names[code.toLowerCase()] || entity;
                const point = code.toLowerCase().startsWith('#x') ? parseInt(code.slice(2), 16) : Number(code.slice(1));
                return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
            });
            return { status: 'ready', text, target };
        } catch { return { status: 'unavailable', text: '', target }; }
    }
}
