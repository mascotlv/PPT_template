'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { usePathname } from 'next/navigation';
import { Account } from './account';
import { ChatLauncher, useCustomerUnread } from './chat';
import { OperationFeedback } from './operation-feedback';
import { dictionaries } from '@/locales/dictionaries';
import { LANGUAGES, CURRENCIES, COUNTRIES, DEFAULT_CURRENCY, DIGITS, Language } from '@/locales/constants';
export { LANGUAGES, CURRENCIES, COUNTRIES };
export const languageNames: Record<Language, string> = { 'zh': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी', it: 'Italiano' };
export type Dictionary = {
    [K in keyof typeof dictionaries.en]: K extends 'steps' | 'stepsDesc' ? readonly string[] : string;
};
const Context = createContext<{
    lang: Language;
    t: Dictionary;
    setLang: (v: Language) => void;
    currency: string;
    setCurrency: (v: string) => void;
    session: any;
    reload: () => Promise<void>;
}>({ lang: 'zh', t: dictionaries.zh, setLang: () => { }, currency: 'CNY', setCurrency: () => { }, session: null, reload: async () => { } });
export const useStore = () => useContext(Context);
export const title = (p: any, lang: Language) => p.translations?.[lang]?.title || (lang === 'zh' ? p.titleZh : lang === 'en' ? p.titleEn : undefined) || dictionaries[lang].translationMissing;
export const description = (p: any, lang: Language) => p.translations?.[lang]?.description || (lang === 'zh' ? p.descriptionZh : lang === 'en' ? p.descriptionEn : undefined) || dictionaries[lang].translationMissing;
export const categoryName = (p: any, lang: Language) => p.translations?.[lang] || (lang === 'zh' ? p.nameZh : lang === 'en' ? p.nameEn : undefined) || dictionaries[lang].translationMissing;
export const countryName = (code: string, lang: Language) => code === 'UNKNOWN' ? dictionaries[lang].unknownCountry : new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code;
export const price = (amount: number, currency: string, lang: Language = 'zh') => new Intl.NumberFormat(lang, { style: 'currency', currency }).format(amount / 10 ** DIGITS[currency]);
export function stateLabel(value: string, t: Dictionary) { const map: Record<string, keyof Dictionary> = { DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived', AWAITING_PAYMENT: 'awaiting', PAID: 'success', CLOSED: 'closed', CREATED: 'pending', PENDING: 'pending', QUEUED: 'pending', REQUESTED: 'requested', APPROVED: 'approved', REJECTED: 'rejected', FAILED: 'failure', SUCCEEDED: 'success', CANCELLED: 'cancel', PROCESSING: 'processingState', RUNNING: 'processingState', READY: 'ready', DONE: 'completed', COMPLETED: 'completed', ACTIVE: 'active', SUSPENDED: 'suspended', REVOKED: 'revoked', OPEN: 'unresolved', RESOLVED: 'resolved', IGNORED: 'ignored', CAPTURED: 'mailCaptured', SENT: 'mailSent', AUTHORIZED: 'approved', STARTED: 'processingState', INTERRUPTED: 'failure', RECEIVED: 'pending', PROCESSED: 'completed', ADMIN: 'administrator', SUPPORT: 'supportRole', MAIL: 'mailRecords', OWNER_MAIL: 'ownerNotifications', FX_REFRESH: 'rateSource', RECOVERY: 'recover', ACCOUNT: 'account', REFUND: 'refunds', UNKNOWN: 'pending' }; return map[value] ? String(t[map[value]]) : t.requestError; }
export function ErrorBox({ error, retry }: {
    error: unknown;
    retry?: () => void;
}) { const { t, lang } = useStore(); const code = error instanceof ApiError ? error.code : (error && typeof error === 'object' && 'code' in error ? String(error.code) : String(error)); const map: Record<string, keyof Dictionary> = { FILE_TOO_LARGE: 'fileTooLarge', MAIL_NOT_CONFIGURED: 'mailNotConfigured', NETWORK_ERROR: 'networkError', REGISTRATION_REQUIRED: 'loginRequired', EMAIL_VERIFICATION_REQUIRED: 'verificationRequired', TOKEN_EXPIRED: 'tokenExpired', FX_UNAVAILABLE: 'rateUnavailable', TRANSLATIONS_REQUIRED: 'translationMissing', TRANSLATION_NOT_CONFIGURED: 'translationNotConfigured', TRANSLATION_UNAVAILABLE: 'translationUnavailable', ACCOUNT_EXISTS: 'accountExistsNotice', ACCOUNT_NOT_FOUND: 'accountNotFound', INVALID_PASSWORD: 'wrongPassword', INVALID_SECOND_FACTOR: 'invalidCode', ACCOUNT_DISABLED: 'accountDisabled', RATE_LIMITED: 'rateLimited', INVALID_INPUT: 'invalidInput', INVALID_PRICE_RANGE: 'invalidPriceRange', PURCHASE_DISABLED: 'noLive', MOCK_MODE_FORBIDDEN: 'modeForbidden', INVALID_CREDENTIALS: 'invalidLogin', QUOTE_STALE: 'refresh', REAUTH_REQUIRED: 'reauth', CSRF_REJECTED: 'csrfError', TEST_ACCESS_REQUIRED: 'loginRequired', INTERNAL_ERROR: 'genericError', CONFLICT: 'genericError', REQUEST_REJECTED: 'genericError', UPLOAD_ABORTED: 'genericError' }; return <div className="error" role="alert"><p>{code === 'PRODUCT_HAS_ORDERS' ? (lang.startsWith('zh') ? '该商品已有订单，需保留购买记录及下载文件，无法彻底删除。' : 'This product has orders. Its purchase records and downloads must be retained.') : code === 'STORAGE_QUOTA_REACHED' ? (lang.startsWith('zh') ? '总存储配额或磁盘可用空间不足，请先清理文件。' : 'Storage quota or available disk space exceeded. Please free space first.') : String(t[map[code] || 'requestError'])}</p>{retry && <button onClick={retry}>{t.retry}</button>}</div>; }
export function CurrencyOptions() { return <>{CURRENCIES.map(code => <option value={code} key={code}>{code}</option>)}</>; }
export function LanguageOptions() { return <>{LANGUAGES.map(code => <option value={code} key={code}>{languageNames[code]}</option>)}</>; }
export function CountryOptions() { const { lang } = useStore(); return <>{[...COUNTRIES].sort((a, b) => countryName(a, lang).localeCompare(countryName(b, lang), lang)).map(code => <option value={code} key={code}>{countryName(code, lang)}</option>)}</>; }
export function track(kind: string, productId?: string) { void api('/analytics/events', 'POST', { kind, ...(productId ? { productId } : {}), ...(kind === 'PRODUCT_CLICK' ? { eventId: crypto.randomUUID() } : {}) }).catch(() => { }); }
export function Store({ children }: {
    children: ReactNode;
}) {
    const [lang, updateLang] = useState<Language>('zh'), [currency, updateCurrency] = useState('CNY'), [session, setSession] = useState<any>(null), [error, setError] = useState<unknown>();
    const pathname = usePathname(), adminPage = pathname.startsWith('/admin');
    const customText = !adminPage ? session?.storefrontText?.[lang] || {} : {};
    const t: Dictionary = { ...dictionaries[lang], ...customText };
    const setLang = (value: Language) => { updateLang(value); updateCurrency(DEFAULT_CURRENCY[value]); localStorage.setItem(pathname.startsWith('/admin') ? 'workshop-admin-language' : 'workshop-language', value); localStorage.setItem('workshop-currency', DEFAULT_CURRENCY[value]); };
    const setCurrency = (value: string) => { if (CURRENCIES.includes(value as any)) {
        updateCurrency(value);
        localStorage.setItem('workshop-currency', value);
    } };
    async function reload() { try {
        setSession(await api('/session'));
        setError(undefined);
    }
    catch (e) {
        setError(e);
    } }
    useEffect(() => { const source = new URLSearchParams(location.search).get('utm_source'); if (source)
        sessionStorage.setItem('workshop-source', source.replace(/[^\w .-]/g, '').slice(0, 80)); const saved = localStorage.getItem(location.pathname.startsWith('/admin') ? 'workshop-admin-language' : 'workshop-language') as Language; if (LANGUAGES.includes(saved)) {
        updateLang(saved);
        updateCurrency(DEFAULT_CURRENCY[saved]);
    } const money = localStorage.getItem('workshop-currency'); if (money && CURRENCIES.includes(money as any))
        updateCurrency(money); void reload(); }, []);
    
    const customerUnreadCount = useCustomerUnread(!adminPage && session?.customer?.verified ? session.customer.id : undefined);
    useEffect(() => { const saved = localStorage.getItem(adminPage ? 'workshop-admin-language' : 'workshop-language') as Language; updateLang(LANGUAGES.includes(saved) ? saved : 'zh'); }, [adminPage]);
    useEffect(() => { if (session?.customer?.verified && !pathname.startsWith('/admin')) void api('/chat/preferences', 'PATCH', { language: lang }).catch(() => {}); }, [lang, session?.customer?.id, session?.customer?.verified, pathname]);
    useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.title = t.brand; }, [lang, t.brand]);
    const defaultBrand = session?.brand?.translations?.[lang]?.name || ((lang === 'zh' || lang === 'en') ? session?.brand?.[lang === 'zh' ? 'nameZh' : 'nameEn'] : undefined) || t.brand;
    const brand = customText.brand ?? defaultBrand;
    return <Context.Provider value={{ lang, t, setLang, currency, setCurrency, session, reload }}><OperationFeedback />
    <header className="header"><Link href="/" className="brand"><span className="brand-mark">T<span>·</span></span><span>{brand}<small>{t.footer}</small></span></Link>{pathname.startsWith('/admin') ? <nav aria-label={t.admin}><Link href="/" className="nav-account admin-store-button">{t.storeEntry} ↗</Link></nav> : <nav aria-label={t.navShop} className="nav-shop"><Link href="/products">{t.navShop}</Link><Link href="/recover">{t.navRecover}</Link><Link href="/#how">{t.how}</Link>{session?.customer?.verified || session?.admin ? <Link href="/contact"><span className="nav-contact-icon" aria-hidden="true">✧</span> {t.contactSeller}{customerUnreadCount > 0 && <span className="unread-badge" role="status" aria-label={customerUnreadCount + ' ' + t.unreadMessages}>{customerUnreadCount > 99 ? '99+' : customerUnreadCount}</span>}</Link> : <Link href="/account?next=/contact"><span className="nav-contact-icon" aria-hidden="true">✧</span> {t.contactSeller}</Link>}<Link href="/account" className="nav-account">{session?.customer || session?.admin ? t.account : t.login}</Link></nav>}<div className="preferences"><select aria-label={t.language} value={lang} onChange={e => setLang(e.target.value as Language)}><LanguageOptions /></select><select aria-label={t.currency} value={adminPage ? 'CNY' : currency} disabled={adminPage} onChange={e => setCurrency(e.target.value)}>{adminPage ? <option value="CNY">CNY</option> : <CurrencyOptions />}</select></div></header>
    {!session ? <main className="narrow status-panel">{error ? <ErrorBox error={error} retry={reload}/> : <p role="status">{t.loading}</p>}</main> : pathname.startsWith('/admin') || pathname === '/account' ? children : !session.customer?.verified && !session.admin ? <Account /> : children}
    <footer className="footer"><div><strong>{brand}</strong><p>{customText.footer ?? session?.brand?.translations?.[lang]?.footer ?? t.footer}</p><small>{session?.brand?.contact && !session.brand.contact.includes('待完善') ? session.brand.contact : t.operatorPending}</small></div><div className="footer-links"><Link href="/policies/license">{t.license}</Link><Link href="/policies/refund">{t.refund}</Link><Link href="/policies/privacy">{t.privacy}</Link><Link href="/policies/contact">{t.contact}</Link></div><small>© 2026 {brand}</small></footer>{!pathname.startsWith('/admin') && pathname !== '/contact' && session?.customer?.verified && <ChatLauncher unreadCount={customerUnreadCount} />}</Context.Provider>;
}
