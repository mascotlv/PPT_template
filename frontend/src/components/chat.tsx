'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, uploadAttachment, downloadFile } from '@/lib/api';
import { useStore, ErrorBox, languageNames } from './store';
import { ChatAvatar } from './chat-profile';
import { CustomerSummary, enrichCustomers } from './customer-summary';
import type { Language } from '@/locales/constants';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const liveChannels = new Map<boolean, { events: EventSource; connected: boolean; listeners: Set<{ refresh: () => void; status: (value: boolean) => void }> }>();
function useLive(admin: boolean, refresh: () => void, enabled = true) {
    const [connected, setConnected] = useState(false), callback = useRef(refresh);
    useEffect(() => { callback.current = refresh; }, [refresh]);
    useEffect(() => {
        if (!enabled) return;
        let channel = liveChannels.get(admin);
        if (!channel) {
            const events = new EventSource('/api/v1' + (admin ? '/admin/chat/stream' : '/chat/stream'));
            channel = { events, connected: false, listeners: new Set() }; liveChannels.set(admin, channel);
            const current = channel;
            events.onopen = () => { current.connected = true; current.listeners.forEach(v => v.status(true)); };
            events.onmessage = () => current.listeners.forEach(v => v.refresh());
            events.onerror = () => { current.connected = false; current.listeners.forEach(v => v.status(false)); };
        }
        const listener = { refresh: () => callback.current(), status: setConnected };
        channel.listeners.add(listener); setConnected(channel.connected);
        return () => { channel.listeners.delete(listener); if (!channel.listeners.size) { channel.events.close(); liveChannels.delete(admin); } };
    }, [admin, enabled]);
    return connected;
}
export function useMerchantUnread(enabled: boolean) {
    const [count, setCount] = useState(0);
    const refresh = useCallback(async () => {
        if (!enabled) return;
        try { const rows = await api('/admin/chat'); setCount(rows.reduce((sum: number, row: any) => sum + row.unreadCount, 0)); } catch { /* Next live update retries. */ }
    }, [enabled]);
    useLive(true, () => void refresh(), enabled);
    useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
    return enabled ? count : 0;
}
export function useMerchantAttention(enabled: boolean) {
    const [counts, setCounts] = useState({ refunds: 0, feedback: 0 });
    const refresh = useCallback(async () => {
        if (!enabled) return;
        try { setCounts(await api('/admin/attention')); } catch { /* Next poll retries. */ }
    }, [enabled]);
    useLive(true, () => void refresh(), enabled);
    useEffect(() => {
        if (!enabled) return;
        void refresh();
        const timer = setInterval(() => void refresh(), 3000);
        window.addEventListener('admin-attention-refresh', refresh);
        return () => { clearInterval(timer); window.removeEventListener('admin-attention-refresh', refresh); };
    }, [enabled, refresh]);
    return enabled ? counts : { refunds: 0, feedback: 0 };
}
export function useCustomerUnread(customerId?: string) {
    const [count, setCount] = useState(0), sequence = useRef(0);
    const refresh = useCallback(async () => {
        if (!customerId) return;
        const version = ++sequence.current;
        try {
            const data = await api('/chat/unread');
            if (version === sequence.current) setCount(data.unreadCount);
        } catch { /* Retry on the next live update or polling interval. */ }
    }, [customerId]);
    useLive(false, () => void refresh(), !!customerId);
    useEffect(() => {
        setCount(0);
        if (!customerId) return;
        void refresh();
        const timer = setInterval(() => void refresh(), 15000);
        const update = () => void refresh();
        window.addEventListener('chat-customer-read', update);
        window.addEventListener('focus', update);
        return () => {
            sequence.current++;
            clearInterval(timer);
            window.removeEventListener('chat-customer-read', update);
            window.removeEventListener('focus', update);
        };
    }, [customerId, refresh]);
    return customerId ? count : 0;
}
function MessageBubble({ message, admin, participants, translationRevision }: { message: any; admin: boolean; participants: any; translationRevision: string }) {
    const { t, lang } = useStore(), mine = message.sender === (admin ? 'SELLER' : 'BUYER');
    const rawProfile = participants[message.sender];
    const profile = rawProfile?.isDefaultNickname ? { ...rawProfile, nickname: t.sellerRole } : rawProfile || { nickname: message.sender === 'SELLER' ? t.sellerRole : t.buyerRole };
    const target = (mine ? participants[admin ? 'BUYER' : 'SELLER']?.language || 'zh' : lang) as Language;
    const [translation, setTranslation] = useState<any>(null), [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!message.content) return;
        let active = true; setTranslation(null);
        api((admin ? '/admin/chat' : '/chat') + '/messages/' + message.id + '/translation', 'POST', { target })
            .then(result => { if (active) setTranslation(result); }).catch(() => { if (active) setTranslation({ status: 'unavailable' }); });
        return () => { active = false; };
    }, [message.id, message.content, target, admin, attempt, translationRevision]);
    useEffect(() => { const retry = () => setAttempt(v => v + 1); window.addEventListener('chat-translation-settings', retry); return () => window.removeEventListener('chat-translation-settings', retry); }, []);
    const translatedText = translation?.text || '';
    return <article className={'chat-message ' + (mine ? 'mine' : 'theirs')}><ChatAvatar profile={profile}/><div className="chat-message-body"><small className="chat-nickname">{profile.nickname}</small><div className={'chat-bubble ' + (mine ? 'mine' : 'theirs') + (message.attachment ? ' has-attachment' : '')}>{message.attachment && <Attachment message={message} admin={admin}/>} {message.content && <p dir="auto">{message.content}</p>}</div>{message.content && <div className="chat-translation" aria-live="polite"><small>{t.chatTranslation} · {languageNames[target]}</small><p dir="auto">{!translation ? t.loading : translation.status === 'unconfigured' ? t.chatTranslationSetup : translation.status === 'ready' ? translatedText : t.chatTranslationFailed}</p>{translation?.status === 'unavailable' && <button type="button" onClick={() => setAttempt(v => v + 1)}>{t.retry}</button>}</div>}<time>{new Date(message.createdAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}</time></div></article>;
}
function fileSize(bytes: number) { if (bytes < 1024)
    return bytes + ' B'; if (bytes < 1024 * 1024)
    return (bytes / 1024).toFixed(1) + ' KB'; if (bytes < 1024 * 1024 * 1024)
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'; return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'; }
// Attachment bubble: images render inline, everything else becomes a download card.
function Attachment({ message, admin }: {
    message: any;
    admin: boolean;
}) {
    const { t } = useStore();
    const [error, setError] = useState<unknown>();
    const [downloading, setDownloading] = useState(false);
    const a = message.attachment;
    if (!a)
        return null;
    const base = '/api/v1' + (admin ? '/admin/chat' : '/chat') + '/attachments/' + message.id;
    if (a.kind === 'IMAGE')
        return <a className="chat-attachment-image" href={base + '?inline=1'} target="_blank" rel="noreferrer"><img src={base + '?inline=1'} alt={a.filename} loading="lazy"/></a>;
    return <><a className="chat-attachment-file" href={base} download={a.filename} aria-disabled={downloading} onClick={async e => { e.preventDefault(); if (downloading) return; setDownloading(true); setError(undefined); try { await downloadFile(base, a.filename); } catch (error) { setError(error); } finally { setDownloading(false); } }}><span className="chat-attachment-glyph" aria-hidden="true">▤</span><span className="chat-attachment-meta"><strong>{a.filename}</strong><small>{fileSize(a.size)} · {downloading ? t.loading : t.downloadFile}</small></span></a>{!!error && <ErrorBox error={error}/>}</>;
}
function Conversation({ admin = false, id = '', revision = 0 }: {
    admin?: boolean;
    id?: string;
    revision?: number;
}) {
    const { t } = useStore();
    const [participants, setParticipants] = useState<any>({}), [translationRevision, setTranslationRevision] = useState('');
    const [messages, setMessages] = useState<any[]>([]), [hasMore, setHasMore] = useState(false), [before, setBefore] = useState(''), [content, setContent] = useState(''), [attachment, setAttachment] = useState<any>(null), [uploading, setUploading] = useState(false), [progress, setProgress] = useState(0), [picking, setPicking] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
    const anchor = useRef<HTMLDivElement>(null), picker = useRef<HTMLInputElement>(null), pending = useRef<{
        content: string;
        clientId: string;
    } | null>(null), sequence = useRef(0);
    const endpoint = admin ? '/admin/chat/' + id + '/messages' : '/chat';
    const uploadPath = admin ? '/admin/chat/attachments' : '/chat/attachments';
    const refresh = useCallback(async () => { if (!admin && document.visibilityState === 'hidden') return; const version = ++sequence.current; try {
        const data = await api(endpoint);
        if (version === sequence.current) {
            setMessages(data.messages);
            setParticipants(data.participants || {});
            setTranslationRevision(data.translationRevision || '');
            setHasMore(data.hasMore);
            setBefore(data.before || '');
            setError(undefined);
            if (!admin) window.dispatchEvent(new Event('chat-customer-read'));
        }
    }
    catch (e) {
        if (version === sequence.current)
            setError(e);
    } }, [endpoint, admin]);
    const connected = useLive(admin, () => void refresh());
    useEffect(() => {
        const update = () => { if (document.visibilityState === 'visible') void refresh(); };
        document.addEventListener('visibilitychange', update);
        const timer = setInterval(() => { if (!connected) update(); }, 15000);
        return () => { document.removeEventListener('visibilitychange', update); clearInterval(timer); };
    }, [refresh, connected]);
    useEffect(() => { setMessages([]); pending.current = null; setContent(''); setAttachment(null); setProgress(0); setPicking(''); void refresh(); return () => { sequence.current++; }; }, [refresh]);
    useEffect(() => { if (revision)
        void refresh(); }, [revision, refresh]);
    useEffect(() => { anchor.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length]);
    async function pick(e: React.ChangeEvent<HTMLInputElement>) { const file = e.target.files?.[0]; e.target.value = ''; if (!file)
        return; if (file.size > MAX_UPLOAD_BYTES) {
        setError({ code: 'FILE_TOO_LARGE', message: t.attachTooLarge });
        return;
    } setUploading(true); setProgress(0); setPicking(file.name); setError(undefined); try {
        setAttachment(await uploadAttachment(uploadPath, file, setProgress));
    }
    catch (err) {
        setError(err);
    }
    finally {
        setUploading(false);
        setProgress(0);
        setPicking('');
    } }
    async function send(e: React.FormEvent) { e.preventDefault(); if ((!content.trim() && !attachment) || uploading)
        return; setBusy(true); setError(undefined); const signature = content.trim(); const payload = pending.current?.content === signature ? pending.current : { content: signature, clientId: crypto.randomUUID() }; pending.current = payload; try {
        await api(admin ? endpoint : '/chat/messages', 'POST', { ...payload, ...(attachment ? { attachment } : {}) });
        pending.current = null;
        setContent('');
        setAttachment(null);
        await refresh();
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    return <section className="chat-thread"><div className="chat-connection"><span className={connected ? 'connection-dot online' : 'connection-dot'}/>{connected ? t.chatConnected : t.chatConnecting}</div><div className="chat-history" aria-label={t.chat}>{hasMore && <button className="earlier-messages" disabled={busy} onClick={async () => { setBusy(true); try {
        const data = await api(endpoint + '?before=' + before);
        setMessages(previous => [...data.messages, ...previous.filter(v => !data.messages.some((m: any) => m.id === v.id))]);
        setHasMore(data.hasMore);
        setBefore(data.before || '');
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }}>{t.previous}</button>}{messages.length ? messages.map(message => <MessageBubble key={message.id} message={message} admin={admin} participants={participants} translationRevision={translationRevision}/>) : <p className="chat-empty">{t.noMessages}</p>}<div ref={anchor}/></div>{!!error && <ErrorBox error={error} retry={() => void refresh()}/>}<form className="chat-composer" onSubmit={send}>{uploading && <div className="chat-uploading" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span className="chat-uploading-name">{picking}</span><div className="chat-progress"><i style={{ width: progress + '%' }}/></div><small>{progress}%</small></div>}{attachment && <div className="chat-pending"><span className="chat-attachment-glyph" aria-hidden="true">▤</span><span className="chat-pending-name">{attachment.filename}</span><small>{fileSize(attachment.size)}</small><button type="button" onClick={() => setAttachment(null)} aria-label={t.removeAttachment}>×</button></div>}<div className="chat-input-row"><input ref={picker} className="sr-only" type="file" onChange={pick} aria-label={t.attachFile}/><button type="button" className="chat-attach-button" disabled={busy || uploading} onClick={() => picker.current?.click()} aria-label={t.attachFile} title={t.attachFile}>{uploading ? '…' : '＋'}</button><label className="sr-only" htmlFor={'chat-content-' + id}>{t.chatPlaceholder}</label><textarea id={'chat-content-' + id} maxLength={2000} aria-label={t.chatPlaceholder} placeholder={t.chatPlaceholder} value={content} onChange={e => setContent(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (!busy && (content.trim() || attachment))
            void send(e as any);
    } }}/><button className="primary" disabled={busy || uploading || (!content.trim() && !attachment)}>{t.sendMessage} ↗</button></div></form></section>;
}
export function ContactPage() { const { t } = useStore(); return <main className="contact-page"><p className="eyebrow">{t.contact}</p><h1>{t.contactSeller}</h1><Conversation /></main>; }
// A null position leaves the original CSS placement untouched until the user drags.
const LAUNCHER_POSITION = 'workshop-chat-position-v1';
type LauncherPosition = {
    left: number;
    top: number;
};
export function ChatLauncher({ unreadCount = 0 }: { unreadCount?: number }) {
    const { t } = useStore();
    const [open, setOpen] = useState(false), [position, setPosition] = useState<LauncherPosition | null>(null), [dragging, setDragging] = useState(false);
    const launcher = useRef<HTMLButtonElement>(null), drawer = useRef<HTMLElement>(null);
    const gesture = useRef<{
        id: number;
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
    } | null>(null), suppressClick = useRef(false);
    const constrain = useCallback((point: LauncherPosition) => {
        const rect = launcher.current?.getBoundingClientRect();
        return { left: Math.max(8, Math.min(point.left, window.innerWidth - (rect?.width || 180) - 8)), top: Math.max(8, Math.min(point.top, window.innerHeight - (rect?.height || 52) - 8)) };
    }, []);
    const remember = useCallback((point: LauncherPosition | null) => {
        setPosition(point);
        try {
            if (point)
                localStorage.setItem(LAUNCHER_POSITION, JSON.stringify(point));
            else
                localStorage.removeItem(LAUNCHER_POSITION);
        }
        catch { /* Storage may be disabled; dragging still works. */ }
    }, []);
    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(LAUNCHER_POSITION) || 'null');
            if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top))
                setPosition(constrain(saved));
        }
        catch { /* Ignore malformed browser storage. */ }
        const resize = () => setPosition(previous => previous ? constrain(previous) : null);
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, [constrain]);
    useEffect(() => {
        if (!open)
            return;
        drawer.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') {
            setOpen(false);
            requestAnimationFrame(() => launcher.current?.focus());
        } };
        window.addEventListener('keydown', escape);
        return () => window.removeEventListener('keydown', escape);
    }, [open]);
    function start(e: React.PointerEvent<HTMLButtonElement>) {
        if (!e.isPrimary || e.button !== 0)
            return;
        const rect = e.currentTarget.getBoundingClientRect();
        suppressClick.current = false;
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
    }
    function move(e: React.PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (!current || current.id !== e.pointerId)
            return;
        const dx = e.clientX - current.x, dy = e.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 6)
            return;
        current.moved = true;
        suppressClick.current = true;
        setDragging(true);
        setPosition(constrain({ left: current.left + dx, top: current.top + dy }));
    }
    function finish(e: React.PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (!current || current.id !== e.pointerId)
            return;
        if (current.moved) {
            const rect = e.currentTarget.getBoundingClientRect();
            remember(constrain({ left: rect.left, top: rect.top }));
        }
        gesture.current = null;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
    }
    return <><p id="chat-drag-help" className="sr-only">{t.chatDragHelp}</p><button ref={launcher} hidden={open} className={'chat-launcher' + (dragging ? ' is-dragging' : '')} style={position ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto', insetInlineEnd: 'auto' } : undefined} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { gesture.current = null; setDragging(false); }} onClick={e => { if (suppressClick.current && e.detail !== 0) {
        suppressClick.current = false;
        return;
    } setOpen(true); }} onKeyDown={e => { if (e.key === 'Home') {
        e.preventDefault();
        remember(null);
        return;
    } const offsets: Record<string, [
        number,
        number
    ]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }; const offset = offsets[e.key]; if (offset) {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        remember(constrain({ left: rect.left + offset[0], top: rect.top + offset[1] }));
    } }} aria-label={t.contactSeller + (unreadCount > 0 ? ' ? ' + unreadCount + ' ' + t.unreadMessages : '')} aria-describedby="chat-drag-help" aria-expanded={open} aria-controls="customer-chat-drawer">✧ <span>{t.contactSeller}</span>{unreadCount > 0 && <span className="unread-badge" role="status" aria-label={unreadCount + ' ' + t.unreadMessages}>{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>
    {open && <aside ref={drawer} id="customer-chat-drawer" className="chat-drawer" role="dialog" aria-label={t.chat}><div className="section-title"><Link href="/contact">{t.contactSeller} ↗</Link><button onClick={() => { setOpen(false); requestAnimationFrame(() => launcher.current?.focus()); }} aria-label={t.close}>×</button></div><Conversation /></aside>}</>;
}
export function AdminChat() {
    const { t } = useStore();
    const [rows, setRows] = useState<any[]>([]), [selected, setSelected] = useState(''), [revision, setRevision] = useState(0), [error, setError] = useState<unknown>();
    const load = useCallback(async () => { try {
        setRows(await enrichCustomers(await api('/admin/chat')));
        setError(undefined);
    }
    catch (e) {
        setError(e);
    } }, []);
    useEffect(() => { void load(); }, [load]);
    useLive(true, () => { void load(); setRevision(v => v + 1); });
    return <>{!!error && <ErrorBox error={error} retry={() => void load()}/>}<div className="admin-chat"><aside className="conversation-list">{rows.length ? rows.map(row => <button className={row.id === selected ? 'active' : ''} key={row.id} onClick={() => { setSelected(row.id); setRows(previous => previous.map(v => v.id === row.id ? { ...v, unread: false, unreadCount: 0 } : v)); }}><ChatAvatar profile={row.customer}/><strong>{row.customer.nickname || row.customer.name}{row.unreadCount > 0 && <span className="unread-badge" aria-label={row.unreadCount + ' ' + t.unreadMessages}>{row.unreadCount}</span>}</strong><CustomerSummary record={row.customer}/><p>{row.messages[0]?.content || (row.messages[0]?.attachment ? '▤ ' + row.messages[0].attachment.filename : t.noMessages)}</p></button>) : <p>{t.empty}</p>}</aside>{selected ? <Conversation key={selected} admin id={selected} revision={revision}/> : <div className="conversation-placeholder">✧<p>{t.selectConversation}</p></div>}</div></>;
}
