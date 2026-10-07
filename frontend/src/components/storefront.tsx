'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, setTokens, downloadFile } from '@/lib/api';
import { useStore, title, description, categoryName, price, ErrorBox, CurrencyOptions, LanguageOptions, track, CURRENCIES } from './store';
import type { Language } from '@/locales/constants';
// Catalog and product covers
export function Catalog({ home = false }: {
    home?: boolean;
}) {
    const { lang, t, currency, setCurrency } = useStore();
    const [products, setProducts] = useState<any[]>([]), [categories, setCategories] = useState<any[]>([]), [search, setSearch] = useState(''), [category, setCategory] = useState(''), [priceSort, setPriceSort] = useState('default'), [minPrice, setMinPrice] = useState(''), [maxPrice, setMaxPrice] = useState(''), [range, setRange] = useState({ min: '', max: '' }), [ready, setReady] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<unknown>();
    useEffect(() => { const q = new URLSearchParams(location.search); setSearch(q.get('search') || ''); setCategory(q.get('category') || ''); const sort = q.get('priceSort'); if (sort && ['default', 'asc', 'desc'].includes(sort))
        setPriceSort(sort); setMinPrice(q.get('minPrice') || ''); setMaxPrice(q.get('maxPrice') || ''); setRange({ min: q.get('minPrice') || '', max: q.get('maxPrice') || '' }); const money = q.get('currency'); if (money && CURRENCIES.includes(money as any))
        setCurrency(money); setReady(true); api('/categories').then(setCategories).catch(setError); track(home ? 'HOME_VIEW' : 'CATALOG_VIEW'); }, [home]);
    useEffect(() => { if (!ready)
        return; let active = true; const q = new URLSearchParams({ currency }); if (search)
        q.set('search', search); if (category)
        q.set('category', category); if (priceSort !== 'default')
        q.set('priceSort', priceSort); if (range.min)
        q.set('minPrice', range.min); if (range.max)
        q.set('maxPrice', range.max); if (!home)
        history.replaceState(null, '', `/products?${q}`); const timeout = setTimeout(() => { setLoading(true); api(`/products?${q}`).then(data => { if (active) {
        setProducts(data);
        setError(undefined);
    } }).catch(e => { if (active)
        setError(e); }).finally(() => { if (active)
        setLoading(false); }); }, 150); return () => { active = false; clearTimeout(timeout); }; }, [search, category, home, currency, priceSort, range, ready]);
    function apply(e: React.FormEvent) { e.preventDefault(); if ((minPrice && (!/^\d+(\.\d{1,2})?$/.test(minPrice) || Number(minPrice) < 0)) || (maxPrice && (!/^\d+(\.\d{1,2})?$/.test(maxPrice) || Number(maxPrice) < 0)) || (minPrice && maxPrice && Number(minPrice) > Number(maxPrice))) {
        setError(new ApiError('INVALID_PRICE_RANGE', 'Invalid price range'));
        return;
    } setError(undefined); setRange({ min: minPrice, max: maxPrice }); }
    function reset() { setMinPrice(''); setMaxPrice(''); setRange({ min: '', max: '' }); setPriceSort('default'); setError(undefined); }
    return <>{home && <section className="hero"><div><p className="eyebrow">{t.navShop} / 01</p><h1>{t.hero.split('\n').map((line, i) => <span key={i}>{line}<br /></span>)}</h1><p className="hero-copy">{t.intro}</p><div className="hero-actions"><Link className="primary" href="/products">{t.explore} ↗</Link></div><div className="hero-note"><span>01—03</span> {t.editable} <b>16:9</b></div></div><div className="hero-art" aria-label={t.preview}><div className="art-caption">{t.collection}</div>{products.slice(0, 3).map((p, i) => <Link href={`/products/${p.slug}`} onClick={() => track('PRODUCT_CLICK', p.id)} className={`hero-sheet sheet-${i}`} key={p.id}><Cover p={p}/></Link>)}<span className="art-star">✳</span><span className="art-label">{t.footer}</span></div></section>}
 <section className="collection" id="collection"><div className="section-title"><h2>{t.collection}</h2><p className="collection-sub">{t.collectionSub}</p></div><div className="catalog-controls"><div className="tabs"><button className={!category ? 'active' : ''} onClick={() => setCategory('')}>{t.all}</button>{categories.map(c => <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => setCategory(c.id)}>{categoryName(c, lang)}</button>)}</div><label className="search"><span>⌕</span><input aria-label={t.search} placeholder={t.search} value={search} onChange={e => setSearch(e.target.value)}/></label></div>
 <form className="price-filters" onSubmit={apply}><label>{t.sort}<select aria-label={t.sort} value={priceSort} onChange={e => setPriceSort(e.target.value)}><option value="default">{t.defaultSort}</option><option value="asc">{t.priceAsc}</option><option value="desc">{t.priceDesc}</option></select></label><label>{t.minPrice} · {currency}<input aria-label={t.minPrice} inputMode="decimal" value={minPrice} onChange={e => setMinPrice(e.target.value)}/></label><label>{t.maxPrice} · {currency}<input aria-label={t.maxPrice} inputMode="decimal" value={maxPrice} onChange={e => setMaxPrice(e.target.value)}/></label><button className="primary">{t.applyFilters}</button><button type="button" onClick={reset}>{t.resetFilters}</button></form>
 {error ? <ErrorBox error={error} retry={reset}/> : loading ? <p role="status">{t.loading}</p> : products.length ? <div className="product-grid">{products.map((p, i) => { const cost = p.prices.find((v: any) => v.currency === currency && v.active); return <Link href={`/products/${p.slug}`} onClick={() => track('PRODUCT_CLICK', p.id)} className="product-card" key={p.id}><div className="cover-wrap"><Cover p={p}/><span className="cover-arrow">↗</span></div><div className="product-meta"><span>{String(i + 1).padStart(2, '0')} / {categoryName(p.category, lang)}</span><span>{p.metadata.slides} {t.pages} · {t.editable}</span></div><div className="product-title"><h3>{title(p, lang)}</h3><strong>{cost ? price(cost.amount, currency, lang) : t.noLive}</strong></div><p>PPTX / {p.metadata.ratio} / PowerPoint + WPS</p></Link>; })}</div> : <p>{t.empty}</p>}</section>
 {home && <section className="how" id="how"><h2>{t.how}</h2><div className="steps">{t.steps.map((step, i) => <div key={step}><span>0{i + 1}</span><h3>{step}</h3><p>{t.stepsDesc[i]}</p></div>)}</div></section>}</>;
}
export function Cover({ p, index = 0 }: {
    p: any;
    index?: number;
}) { const { lang } = useStore(); const keys = p.versions?.[0]?.previews || []; return keys[index] ? <img src={`/api/v1/previews/${keys[index]}`} alt={`${title(p, lang)} — ${index + 1}`} loading="lazy"/> : <div className="cover-placeholder">{title(p, lang)}</div>; }
// Product details, checkout, orders and recovery
export function ProductDetail({ slug }: {
    slug: string;
}) { const { lang, t, currency, session } = useStore(); const [p, setP] = useState<any>(), [error, setError] = useState<unknown>(); useEffect(() => { api(`/products/${slug}`).then(v => { setP(v); track('PRODUCT_VIEW', v.id); }).catch(setError); }, [slug]); if (error)
    return <main className="narrow"><ErrorBox error={error}/></main>; if (!p)
    return <main className="narrow">{t.loading}</main>; const meta = p.metadata, translated = p.translations?.[lang]?.metadata || {}, amount = p.prices.find((v: any) => v.currency === currency)?.amount; return <main className="detail"><div className="detail-heading"><p className="eyebrow">{categoryName(p.category, lang)}</p><h1>{title(p, lang)}</h1></div><div className="detail-layout"><div className="previews"><Cover p={p}/><h2>{t.preview}</h2><div className="preview-grid">{p.versions[0]?.previews.slice(1).map((_: any, i: number) => <Cover key={i} p={p} index={i + 1}/>)}</div></div><aside className="buy-panel"><p>{description(p, lang)}</p><div className="price-line">{amount ? price(amount, currency, lang) : t.noLive}<small>{meta.slides} {t.pages} / {meta.ratio}</small></div>{session.checkoutEnabled ? <Link className="primary" href={`/checkout/${slug}`}>{t.buy} ↗</Link> : <p>{t.noLive}</p>}<h2>{t.spec}</h2><dl>{[[t.file, p.downloadNames?.[lang]], [t.type, 'PPTX'], [t.software, meta.software], [t.editable, translated.editable || t.translationMissing], [t.fonts, translated.fonts || t.translationMissing], [t.images, translated.images || t.translationMissing], [t.license, translated.license || t.translationMissing]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><div className="inline-links"><Link href="/policies/license">{t.license}</Link><Link href="/policies/refund">{t.refund}</Link></div></aside></div></main>; }
export function Checkout({ slug }: {
    slug: string;
}) {
    const { lang, t, currency, setCurrency, setLang, session } = useStore();
    const router = useRouter();
    const [p, setP] = useState<any>(), [quote, setQuote] = useState<any>(), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
    useEffect(() => { api(`/products/${slug}`).then(setP).catch(setError); }, [slug]);
    useEffect(() => { let cancelled = false; setQuote(undefined); if (p)
        api(`/quotes/${p.id}?currency=${currency}`).then(v => { if (!cancelled) {
            setQuote(v);
            setError(undefined);
        } }).catch(e => { if (!cancelled)
            setError(e); }); return () => { cancelled = true; }; }, [p, currency]);
    async function submit(e: React.FormEvent) { e.preventDefault(); if (!quote || !session.customer?.verified)
        return; setBusy(true); setError(undefined); try {
        const source = new URLSearchParams(location.search).get('utm_source') || sessionStorage.getItem('workshop-source');
        const cleanSource = source?.replace(/[^\w .-]/g, '').slice(0, 80);
        const key = sessionStorage.getItem(`order-key:${p.id}:${currency}:${session.customer.id}`) || crypto.randomUUID();
        sessionStorage.setItem(`order-key:${p.id}:${currency}:${session.customer.id}`, key);
        const o = await api('/orders', 'POST', { productId: p.id, currency, email: session.customer.email, language: lang, termsVersion: quote.termsVersion, quoteToken: quote.quoteToken, idempotencyKey: key, ...(cleanSource ? { source: cleanSource } : {}) });
        router.push(`/orders/${o.id}`);
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    if (!session.customer?.verified)
        return <main className="narrow"><h1>{t.checkout}</h1><p>{session.customer ? t.verificationRequired : t.loginRequired}</p><Link className="primary" href={`/account?next=${encodeURIComponent('/checkout/' + slug)}`}>{session.customer ? t.verify : t.register} / {t.login}</Link></main>;
    return <main className="checkout"><h1>{t.checkout}</h1><div className="checkout-layout"><form className="form-panel" onSubmit={submit}><label>{t.email}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.email} type="email" autoComplete="email" required readOnly value={session.customer.email}/></label><div className="form-row"><label>{t.language}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.language} value={lang} onChange={e => setLang(e.target.value as Language)}><LanguageOptions /></select></label><label>{t.currency}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.currency} value={currency} onChange={e => setCurrency(e.target.value)}><CurrencyOptions /></select></label></div><label>{t.payment}<select disabled><option>{t.payment}</option></select></label><label className="checkbox"><span className="required-mark" aria-hidden="true"> *</span><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)}/><span>{t.consent} · <Link href="/policies/license">{t.license}</Link> / <Link href="/policies/refund">{t.refund}</Link></span></label>{!!error && <ErrorBox error={error}/>}<button className="primary" disabled={busy || !quote || !session.checkoutEnabled}>{busy ? t.loading : session.checkoutEnabled ? t.place : t.noLive}</button></form><aside className="order-summary"><h2>{t.summary}</h2>{p && <><Cover p={p}/><h3>{title(p, lang)}</h3><p>{p.metadata.slides} {t.pages} · PPTX · {p.downloadNames?.[lang]}</p><strong>{quote ? price(quote.amount, quote.currency, lang) : t.loading}</strong>{quote?.pricing?.asOf && <p>{t.rateSource}: {quote.pricing.source}<br />{t.rateAsOf}: {quote.pricing.asOf}<br />{t.basePrice}: {price(quote.pricing.baseAmount, 'CNY', lang)}</p>}</>}</aside></div></main>;
}
export function OrderPage({ id }: {
    id: string;
}) {
    const { lang, t, session } = useStore();
    const [o, setO] = useState<any>(), [error, setError] = useState<unknown>(), [message, setMessage] = useState(false), [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
    async function refresh() { try {
        setO(await api(`/orders/${id}`));
        setError(undefined);
    }
    catch (e) {
        setError(e);
    } }
    useEffect(() => { void refresh(); let count = 0; const timer = setInterval(() => { if (++count > 20) {
        clearInterval(timer);
        return;
    } void refresh(); }, 3000); return () => clearInterval(timer); }, [id]);
    async function action(path: string, body: any = {}, download = false) { setBusy(true); setMessage(false); try {
        const result = await api(path, 'POST', body);
        if (download)
            await downloadFile(result.url);
        else
            setMessage(true);
        await refresh();
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    if (!o)
        return <main className="narrow">{error ? <ErrorBox error={error} retry={refresh}/> : t.loading}</main>;
    const r = o.refunds.find((v: any) => v.status === 'SUCCEEDED'), processing = o.refunds.some((v: any) => ['APPROVED', 'PROCESSING'].includes(v.status)), requested = o.refunds.some((v: any) => v.status === 'REQUESTED'), payment = o.payments.at(-1);
    const label = r && o.entitlement === 'REVOKED' ? t.refunded : processing ? t.refundProcessing : requested ? t.refundRequested : o.entitlement === 'ACTIVE' ? t.ready : o.status === 'CLOSED' ? t.closed : payment?.status === 'FAILED' ? t.failed : payment?.status === 'PENDING' ? t.processing : t.awaiting;
    return <main className="order-page"><p className="eyebrow">{o.number}</p><h1>{label}</h1><div className="order-data"><h2>{title(o.item.snapshot, lang)}</h2><p>{o.email}</p><p>{t.filenameLanguage}</p><p>{price(o.amount, o.currency, lang)} · {o.item.filename} · {new Date(o.createdAt).toLocaleString(lang)}</p><small>{o.number}</small></div>{!!error && <ErrorBox error={error}/>}<p role="status">{message ? t.queued : ''}</p><div className="button-row">{o.entitlement === 'ACTIVE' && <button className="primary" disabled={busy} onClick={() => action(`/orders/${id}/download`, {}, true)}>{t.download} ↓</button>}<button disabled={busy} onClick={refresh}>{t.refresh}</button>{o.status === 'PAID' && <button disabled={busy} onClick={() => action(`/orders/${id}/resend`)}>{t.resend}</button>}<button disabled={busy} onClick={() => action(`/orders/${id}/query-payment`)}>{t.query}</button></div>
    {o.status === 'AWAITING_PAYMENT' && session.checkoutEnabled && <section className="payment-panel"><button className="primary" disabled={busy} onClick={() => action(`/orders/${id}/pay`)}>{t.payNow}</button></section>}
    {o.status === 'PAID' && <section className="support-panel"><h2>{t.support}</h2><label>{t.reason}<span className="required-mark" aria-hidden="true"> *</span><textarea aria-label={t.reason} required value={reason} onChange={e => setReason(e.target.value)} minLength={5} maxLength={2000}/></label><div className="button-row"><button disabled={busy || reason.trim().length < 5} onClick={() => action(`/orders/${id}/support`, { content: reason })}>{t.submitSupport}</button><button disabled={busy || reason.trim().length < 5 || !!o.refunds.length} onClick={() => action(`/orders/${id}/refunds`, { reason })}>{t.requestRefund}</button></div>{o.tickets.map((ticket: any) => <p key={ticket.id}>{ticket.content} {ticket.reply && `→ ${ticket.reply}`}</p>)}</section>}</main>;
}
export function Recovery() {
    const { lang, t, reload } = useStore();
    const [email, setEmail] = useState(''), [token, setToken] = useState(''), [message, setMessage] = useState(false), [error, setError] = useState<unknown>(), [orders, setOrders] = useState<any[]>([]), [busy, setBusy] = useState(false);
    useEffect(() => { const value = new URLSearchParams(location.hash.slice(1)).get('token'); if (value) {
        setToken(value);
        history.replaceState(null, '', '/recover');
    } api('/orders').then(setOrders).catch(setError); }, []);
    async function send(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        await api('/recover/request', 'POST', { email });
        setMessage(true);
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    async function redeem() { setBusy(true); try {
        const result = await api('/recover/redeem', 'POST', { token });
        setTokens({ csrf: result.csrf });
        setToken('');
        setOrders(await api('/orders'));
        await reload();
        setError(undefined);
        setMessage(true);
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    return <main className="narrow recovery"><h1>{t.recover}</h1><p>{t.recoverInfo}</p>{token ? <button className="primary" disabled={busy} onClick={redeem}>{t.confirm}</button> : <form onSubmit={send}><label>{t.email}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.email} type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></label><button className="primary" disabled={busy}>{busy ? t.loading : t.send}</button></form>}{!!error && <ErrorBox error={error}/>}<p role="status">{message ? t.queued : ''}</p>{orders.length > 0 && <section><h2>{t.myOrders}</h2>{orders.map(o => <Link href={`/orders/${o.id}`} className="recovered-order" key={o.id}><strong>{title(o.item.snapshot, lang)}</strong><small>{o.number}</small><span>{price(o.amount, o.currency, lang)} ↗</span></Link>)}</section>}</main>;
}
// Store policies
export function Policy({ type }: {
    type: string;
}) { const { t, session } = useStore(); const key = type === 'license' ? 'licensePolicy' : type === 'refund' ? 'refundPolicy' : type === 'privacy' ? 'privacyPolicy' : 'contactPolicy'; return <main className="narrow policy"><h1>{type === 'license' ? t.license : type === 'refund' ? t.refund : type === 'privacy' ? t.privacy : t.contact}</h1><p>{t[key]}</p>{type === 'contact' && session.brand.contact && !session.brand.contact.includes('待完善') && <p>{session.brand.contact}</p>}<small>{t.operatorPending}</small></main>; }
