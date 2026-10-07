export const LANGUAGES = ['zh', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'ar', 'hi', 'it'] as const;
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW', 'GBP', 'CAD', 'AUD', 'CHF', 'HKD', 'SGD', 'NZD', 'TWD', 'BRL', 'MXN', 'INR', 'AED', 'SAR', 'RUB', 'SEK', 'NOK', 'DKK', 'PLN', 'THB', 'IDR', 'MYR', 'PHP', 'ZAR', 'TRY'] as const;
export const COUNTRIES = ['CN', 'TW', 'HK', 'US', 'GB', 'AU', 'CA', 'NZ', 'SG', 'JP', 'KR', 'FR', 'DE', 'ES', 'PT', 'BR', 'IT', 'RU', 'AE', 'SA', 'IN', 'CH', 'AT', 'BE', 'NL', 'IE', 'FI', 'SE', 'NO', 'DK', 'PL', 'MX', 'TH', 'ID', 'MY', 'PH', 'ZA', 'TR'] as const;
export const DIGITS: Record<string, number> = Object.fromEntries(CURRENCIES.map(code => [code, ['JPY', 'KRW'].includes(code) ? 0 : 2]));
export const DEFAULT_CURRENCY: Record<string, string> = { 'zh': 'CNY', 'zh-TW': 'TWD', en: 'USD', ja: 'JPY', ko: 'KRW', fr: 'EUR', de: 'EUR', es: 'EUR', pt: 'BRL', ru: 'RUB', ar: 'AED', hi: 'INR', it: 'EUR' };
export type Language = typeof LANGUAGES[number];
