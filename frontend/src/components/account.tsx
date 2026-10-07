'use client';
import { AvatarPicker, ChatAvatar } from './chat-profile';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, setTokens } from '@/lib/api';
import { useStore, ErrorBox, CountryOptions, title, price } from './store';
import { AuthScene } from './auth-scene';
export function Account() {
    const { lang, t, currency, session, reload } = useStore(), router = useRouter(), pathname = usePathname();
    const [nickname, setNickname] = useState(''), [avatar, setAvatar] = useState('');
    const [mode, setMode] = useState('login'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [country, setCountry] = useState('CN'), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [message, setMessage] = useState(''), [token, setToken] = useState(''), [orders, setOrders] = useState<any[]>([]), [historyPage, setHistoryPage] = useState(1), [totalOrders, setTotalOrders] = useState(0), [returnTo, setReturnTo] = useState('/'), [signedIn, setSignedIn] = useState(false);
    useEffect(() => {
        const readToken = () => { const fragment = new URLSearchParams(location.hash.slice(1)), raw = fragment.get('token'); if (raw) {
            setToken(raw);
            setMode(fragment.get('kind') === 'RESET' ? 'reset' : 'verify');
            setError(undefined);
            setMessage('');
            history.replaceState(null, '', '/account');
        } };
        readToken();
        window.addEventListener('hashchange', readToken);
        const next = new URLSearchParams(location.search).get('next') || sessionStorage.getItem('workshop-checkout-next');
        if (next && /^\/(checkout|products|orders|contact)(\/|$)/.test(next) && !next.includes('//')) {
            setReturnTo(next);
            sessionStorage.setItem('workshop-checkout-next', next);
        }
        else if (pathname !== '/' && pathname !== '/account' && !pathname.startsWith('/admin'))
            setReturnTo(pathname);
        return () => window.removeEventListener('hashchange', readToken);
    }, [pathname]);
    useEffect(() => { let cancelled = false; if (session.customer) {
        setName(session.customer.name);
        setNickname(session.customer.nickname || session.customer.name);
        setAvatar(session.customer.avatar || '');
        setCountry(session.customer.country);
        setEmail(session.customer.email);
        if (session.customer.verified)
            api('/account/orders?page=' + historyPage).then(result => { if (!cancelled) {
                setOrders(result.rows);
                setTotalOrders(result.total);
            } }).catch(e => { if (!cancelled)
                setError(e); });
    }
    else {
        setOrders([]);
        setTotalOrders(0);
    } return () => { cancelled = true; }; }, [session.customer, historyPage]);
    useEffect(() => { if (signedIn && session.customer?.verified) {
        sessionStorage.removeItem('workshop-checkout-next');
        router.replace(returnTo);
    } }, [signedIn, session.customer, router, returnTo]);
    async function submit(e?: React.FormEvent) {
        e?.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
            let result;
            if (mode === 'verify')
                result = await api('/account/verify', 'POST', { token });
            else if (mode === 'reset')
                result = await api('/account/password/reset', 'POST', { token, password });
            else if (mode === 'request')
                result = await api('/account/password/request', 'POST', { email });
            else if (mode === 'register')
                result = await api('/account/register', 'POST', { name, email, password, country, language: lang, currency });
            else
                result = await api('/account/login', 'POST', { email, password });
            if (result.csrf)
                setTokens(result);
            setPassword('');
            setToken('');
            setMessage(mode === 'request' || mode === 'register' ? 'queued' : 'saved');
            if (mode === 'reset' || mode === 'verify')
                setMode('login');
            if (mode === 'login')
                setSignedIn(true);
            await reload();
        }
        catch (e) {
            setError(e);
            await reload();
        }
        finally {
            setBusy(false);
        }
    }
    async function action(path: string, body: any = {}) { setBusy(true); setError(undefined); try {
        const result = await api(path, 'POST', body);
        if (result.csrf)
            setTokens(result);
        if (path.endsWith('/logout')) {
            setSignedIn(false);
            setMode('login');
            setReturnTo('/');
            setMessage('');
            setOrders([]);
            setHistoryPage(1);
            setTotalOrders(0);
            sessionStorage.removeItem('workshop-checkout-next');
            router.replace('/account');
        }
        else
            setMessage('queued');
        await reload();
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    const tokenMode = !!token, heading = tokenMode ? (mode === 'reset' ? t.reset : t.verify) : session.customer ? t.account : mode === 'register' ? t.register : mode === 'request' ? t.reset : t.login;
    const content = <><p className="eyebrow">{session.customer?.verified ? t.accountHistory : t.loginFirst}</p><h1>{heading}</h1>{!!error && <ErrorBox error={error}/>}<p role="status">{message ? (t as any)[message] : ''}</p>
    {tokenMode ? <form onSubmit={submit}>{mode === 'reset' && <label>{t.password}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.password} type="password" minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required/><small>{t.passwordRule}</small></label>}<button className="primary" disabled={busy}>{t.confirm}</button></form> : session.customer ? <>
      <div className="account-identity"><ChatAvatar profile={session.customer}/><div><strong>{session.customer.nickname || session.customer.name}</strong><p>{session.customer.email}</p></div></div><p>{session.customer.verified ? t.verified : t.verificationRequired}</p>{!session.customer.verified && <button disabled={busy} onClick={() => action('/account/verify/resend')}>{t.send}</button>}
      <form onSubmit={async (e) => { e.preventDefault(); try {
            await api('/account/profile', 'PATCH', { name, nickname, avatar, country, language: lang, currency });
            await reload();
            setMessage('saved');
        }
        catch (e) {
            setError(e);
        } }}><AvatarPicker nickname={nickname} avatar={avatar} onChange={setAvatar}/><label>{t.nickname}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.nickname} required maxLength={80} value={nickname} onChange={e => setNickname(e.target.value)}/></label><label>{t.name}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.name} required minLength={2} maxLength={80} value={name} onChange={e => setName(e.target.value)}/></label><label>{t.country}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.country} value={country} onChange={e => setCountry(e.target.value)}><CountryOptions /></select></label><button>{t.save}</button></form>
      <div className="button-row">{session.customer.verified && <Link className="primary" href={returnTo}>{returnTo.startsWith('/checkout/') ? t.buy : t.navShop} ↗</Link>}{!session.developmentAuth && <button onClick={() => action('/account/logout')}>{t.logout}</button>}</div>{session.customer.verified && <section className="account-orders"><h2>{t.orders}</h2><p>{t.accountHistory}</p>{orders.length ? orders.map(o => <Link className="recovered-order" key={o.id} href={`/orders/${o.id}`}><strong>{title(o.item.snapshot, lang)}</strong><small>{o.number}</small><span>{price(o.amount, o.currency, lang)}</span></Link>) : <p>{t.empty}</p>}<div className="button-row"><button disabled={historyPage === 1} onClick={() => setHistoryPage(historyPage - 1)}>{t.previous}</button><span>{t.page} {historyPage} / {t.total} {totalOrders}</span><button disabled={historyPage * 25 >= totalOrders} onClick={() => setHistoryPage(historyPage + 1)}>{t.next}</button></div></section>}
    </> : <><div className="auth-tabs" role="group" aria-label={t.account}>{(['login', 'register', 'request'] as const).map(value => <button className={mode === value ? 'active' : ''} key={value} onClick={() => { setMode(value); setError(undefined); setMessage(''); }}>{value === 'request' ? t.reset : t[value]}</button>)}</div><form onSubmit={submit}>
      {mode === 'register' && <><label>{t.name}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.name} required minLength={2} maxLength={80} autoComplete="name" value={name} onChange={e => setName(e.target.value)}/></label><label>{t.country}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.country} value={country} onChange={e => setCountry(e.target.value)}><CountryOptions /></select></label></>}
      <label>{t.email}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.email} type="email" required maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}/></label>{mode !== 'request' && <label>{t.password}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.password} type="password" required minLength={mode === 'register' ? 12 : 1} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)}/>{mode === 'register' && <small>{t.passwordRule}</small>}</label>}
      
      <button className="primary" disabled={busy}>{busy ? t.loading : mode === 'register' ? t.register : mode === 'request' ? t.send : t.login} <span aria-hidden="true">↗</span></button></form><p className="auth-note">{t.loginFirst}</p></>}
    </>;
    return session.customer?.verified && !tokenMode ? <main className="narrow account-page">{content}</main> : <AuthScene heading={t.hero} description={t.intro} features={[t.editable, t.accountHistory, t.autoPrices]}>{content}</AuthScene>;
}
