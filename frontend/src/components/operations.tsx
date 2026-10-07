'use client';
import { useAdminMoney } from './admin-money';
import { CustomerSummary } from './customer-summary';
import { useEffect, useState } from 'react';
import { useStore, stateLabel, title, ErrorBox } from './store';
export function Dashboard({ data, open }: {
    data: any;
    open: (tab: string) => void;
}) {
    const { t, lang } = useStore();
    const { format: adminPrice, total } = useAdminMoney();
    const overview = { ...data.summary, totalRevenue: 0 };
    const shortcuts: Record<string, string> = { totalRevenue: 'analytics', publishedProducts: 'products', draftProducts: 'products', totalCustomers: 'customers', ordersCount: 'orders', todayOrders: 'orders', monthOrders: 'orders', pendingRefunds: 'refunds', openTickets: 'support', unreadConversations: 'chat', activeEntitlements: 'orders', paymentCompletion: 'orders' };
    return <div className="dashboard-overview"><p className="overview-intro">{t.overviewSummary}</p><div className="dashboard-cards summary-cards">{Object.entries(overview).map(([key, value]: any) => <button className="summary-card" key={key} onClick={() => shortcuts[key] && open(shortcuts[key])}><small>{(t as any)[key]}</small><strong>{key === 'totalRevenue' ? total(data.orders) : new Intl.NumberFormat(lang).format(value)}{key === 'paymentCompletion' ? '%' : ''}</strong></button>)}</div>
    <div className="overview-columns"><section className="overview-panel"><h2>{t.weekActivity}</h2><div className="activity-chart">{data.activity.map((day: any) => <div key={day.day}><span>{day.orders}</span><meter aria-label={day.day} min={0} max={Math.max(1, ...data.activity.map((v: any) => v.orders))} value={day.orders}/><small>{new Intl.DateTimeFormat(lang, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(new Date(day.day + 'T00:00:00Z'))}</small></div>)}</div></section><section className="overview-panel"><h2>{t.gross}</h2><p className="money-summary"><span>CNY</span><strong>{total(data.orders)}</strong></p><h3>{t.refundAmount}</h3><p className="money-summary"><span>CNY</span><strong>{total(data.refunds)}</strong></p><p>{t.adminMoneyNote}</p></section></div>
    <section className="overview-panel"><div className="section-title"><h2>{t.recentOrders}</h2><button onClick={() => open('orders')}>{t.details} ↗</button></div>{data.recentOrders.length ? <div className="recent-orders">{data.recentOrders.map((order: any) => <article key={order.id}><CustomerSummary record={order}/><div><strong>{title(order.item?.snapshot || {}, lang)}</strong><small>{order.number}</small></div><span>{stateLabel(order.status, t)}</span><strong>{adminPrice(order.amount, order.currency, lang)}</strong></article>)}</div> : <p>{t.empty}</p>}</section>
    <section className="overview-panel operational-health"><span>{t.worker}: <strong>{data.workerActive ? t.active : t.inactive}</strong></span><span>{t.jobs}: <strong>{data.failedJobs}</strong></span><span>{t.disk}: {(data.storage.usedBytes / 1048576).toFixed(1)} MB / {(data.storage.freeBytes / 1073741824).toFixed(1)} GB</span><div className="storage-breakdown"><h3>{lang.startsWith('zh') ? '总存储占用 / 配额' : 'Total storage / quota'}: {(data.storage.usedBytes / 1073741824).toFixed(2)} / {(data.storage.maxBytes / 1073741824).toFixed(0)} GB</h3><p>{lang.startsWith('zh') ? '包含原文件和历史副本、预览图、聊天附件、数据库及日志。可用磁盘空间不是配额。' : 'Includes originals, history, previews, attachments, database and logs. Free disk space is separate from quota.'}</p><table><tbody>{Object.entries(data.storage.categories || {}).map(([key, bytes]: any) => <tr key={key}><td>{lang.startsWith('zh') ? ({originals: '商品原文件及历史副本', previews: '预览图片', attachments: '聊天附件', other: '其他上传文件', logs: '日志及临时文件', database: '数据库（含索引）'} as any)[key] : key}</td><td>{(bytes / 1048576).toFixed(2)} MB</td></tr>)}</tbody></table><details><summary>{t.databaseUsage}</summary><table><tbody>{(data.storage.tables || []).map((row: any) => <tr key={row.name}><td>{databaseLabel(row.name, t)}</td><td>{(row.bytes / 1048576).toFixed(2)} MB</td></tr>)}</tbody></table></details></div>{data.alerts.map((alert: string) => <p className="error" key={alert}>{alert === 'TASKS_FAILED' ? t.jobs : t.disk} · {t.requestError}</p>)}</section>
  </div>;
}
export function FeedbackManager({ data, act }: {
    data: any[];
    act: (path: string, method?: string, body?: any) => Promise<any>;
    reload: () => Promise<void>;
}) {
    const { t, session, lang } = useStore();
    const [filter, setFilter] = useState('OPEN'), [search, setSearch] = useState(''), [selectedId, setSelectedId] = useState(''), [memoOpen, setMemoOpen] = useState(false), [memoTitle, setMemoTitle] = useState(''), [content, setContent] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
    const filtered = data.filter(ticket => (filter === 'ALL' || ticket.status === filter) && [ticket.title, ticket.content, ticket.order?.number].some(value => String(value || '').toLocaleLowerCase(lang).includes(search.trim().toLocaleLowerCase(lang))));
    const selected = filtered.find(ticket => ticket.id === selectedId) || filtered[0];
    async function create(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(undefined); try {
        const result = await act('/support', 'POST', { title: memoTitle, content });
        if (result) {
            setSelectedId(result.id);
            setMemoOpen(false);
            setMemoTitle('');
            setContent('');
            setFilter('OPEN');
            setSearch('');
        }
    }
    catch (e) {
        setError(e);
    }
    finally {
        setBusy(false);
    } }
    return <div className="feedback-workbench feedback-redesigned">
    <div className="feedback-status" role="group" aria-label={t.status}>{['OPEN', 'RESOLVED', 'IGNORED', 'ALL'].map(value => <button key={value} data-status={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setMemoOpen(false); }}><span className="feedback-stat-label"><i />{value === 'ALL' ? t.all : stateLabel(value, t)}</span><strong>{new Intl.NumberFormat(lang).format(data.filter(ticket => value === 'ALL' || ticket.status === value).length)}</strong></button>)}</div>
    <div className="feedback-toolbar"><label className="feedback-search"><span>{t.search}</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t.support + ' / ' + t.memoTitle}/></label>{session.admin?.role === 'ADMIN' && <button className="primary" aria-expanded={memoOpen} onClick={() => setMemoOpen(!memoOpen)}><span aria-hidden="true">＋</span> {t.newMemo}</button>}</div>
    <div className="feedback-layout"><section className="feedback-inbox" aria-label={t.support}><div className="feedback-inbox-heading"><h2>{t.support}</h2><span>{filtered.length}</span></div><div className="feedback-ticket-list">{filtered.map(ticket => <div className="feedback-ticket-row" key={ticket.id}><button key={ticket.id} className={'feedback-ticket' + (!memoOpen && selected?.id === ticket.id ? ' active' : '')} aria-pressed={!memoOpen && selected?.id === ticket.id} onClick={() => { setSelectedId(ticket.id); setMemoOpen(false); }}><div className="feedback-ticket-top"><strong>{ticket.title || ticket.order?.number || t.support}</strong><span className="feedback-dot" data-status={ticket.status} aria-label={stateLabel(ticket.status, t)}/></div><p>{ticket.content}</p><small><span>{ticket.source === 'MEMO' ? t.memo : t.buyerRole}</span><time dateTime={ticket.createdAt}>{new Date(ticket.createdAt).toLocaleDateString(lang, { month: 'short', day: 'numeric' })}</time></small></button>{ticket.status === 'OPEN' && <button className="feedback-solve" aria-label={t.resolve + ' · ' + (ticket.title || ticket.order?.number || t.support)} disabled={busy} onClick={async () => { setBusy(true); try { await act('/support/' + ticket.id, 'PATCH', { status: 'RESOLVED' }); } finally { setBusy(false); } }}>{t.resolve}</button>}</div>)}</div>{!filtered.length && <div className="feedback-empty">{t.empty}</div>}</section>
      <section className="feedback-detail record-list" aria-label={t.details}>{memoOpen ? <form className="memo-editor" onSubmit={create}><header className="feedback-detail-heading"><div><small>{t.memo}</small><h2>{t.newMemo}</h2></div><button type="button" onClick={() => setMemoOpen(false)}>{t.cancel}</button></header><label>{t.memoTitle}<span className="required-mark" aria-hidden="true"> *</span><input aria-label={t.memoTitle} required maxLength={120} value={memoTitle} onChange={e => setMemoTitle(e.target.value)}/></label><label>{t.problemDescription}<span className="required-mark" aria-hidden="true"> *</span><textarea aria-label={t.problemDescription} required rows={6} maxLength={2000} value={content} onChange={e => setContent(e.target.value)}/></label>{!!error && <ErrorBox error={error}/>}<footer className="feedback-editor-footer"><span>{stateLabel('OPEN', t)}</span><button className="primary" disabled={busy}>{busy ? t.loading : t.save}</button></footer></form> : selected ? <FeedbackItem key={selected.id} ticket={selected} save={async (body) => !!await act('/support/' + selected.id, 'PATCH', body)}/> : <div className="feedback-empty feedback-empty-detail"><span aria-hidden="true">◇</span><h2>{t.support}</h2><p>{t.empty}</p></div>}</section>
    </div>
  </div>;
}
function FeedbackItem({ ticket, save }: {
    ticket: any;
    save: (body: any) => Promise<boolean>;
}) {
    const { t, lang } = useStore();
    const [status, setStatus] = useState(ticket.status), [reply, setReply] = useState(ticket.reply || ''), [busy, setBusy] = useState(false), [editTitle, setEditTitle] = useState(ticket.title || ''), [editContent, setEditContent] = useState(ticket.content);
    useEffect(() => { setEditTitle(ticket.title || ''); setEditContent(ticket.content); setStatus(ticket.status); setReply(ticket.reply || ''); }, [ticket]);
    async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        await save({ status, reply, title: editTitle, content: editContent });
    }
    finally {
        setBusy(false);
    } }
    if (ticket.source === 'MEMO') return <article className="feedback-item memo-detail"><form onSubmit={submit}><header className="feedback-detail-heading"><div><small>{t.memo}</small><h2>{t.edit}</h2></div><span className="status-badge" data-status={ticket.status}>{stateLabel(ticket.status, t)}</span></header><label>{t.memoTitle}<input aria-label={t.memoTitle} required maxLength={120} value={editTitle} onChange={e => setEditTitle(e.target.value)}/></label><label>{t.problemDescription}<textarea aria-label={t.problemDescription} required maxLength={2000} rows={6} value={editContent} onChange={e => setEditContent(e.target.value)}/></label><footer className="feedback-editor-footer"><label>{t.status}<select aria-label={t.status} value={status} onChange={e => setStatus(e.target.value)}>{['OPEN', 'RESOLVED', 'IGNORED'].map(value => <option key={value} value={value}>{stateLabel(value, t)}</option>)}</select></label><button className="primary" disabled={busy}>{busy ? t.loading : t.save}</button></footer></form></article>;
    return <article className="feedback-item"><header className="feedback-detail-heading"><div><small>{ticket.source === 'MEMO' ? t.memo : t.buyerRole}{ticket.order?.number ? ' · ' + ticket.order.number : ''}</small><h2>{ticket.title || ticket.order?.number || t.support}</h2></div><span className="status-badge" data-status={ticket.status}>{stateLabel(ticket.status, t)}</span></header><CustomerSummary record={ticket}/><time className="feedback-created" dateTime={ticket.createdAt}>{new Date(ticket.createdAt).toLocaleString(lang)}</time><div className="feedback-original"><small>{ticket.source === 'MEMO' ? t.memo : t.support}</small><p className="message-content">{ticket.content}</p></div><form onSubmit={submit}><details className="feedback-edit-original" open={ticket.source === 'MEMO'}><summary>{t.edit} · {ticket.source === 'MEMO' ? t.memo : t.support}</summary><label>{ticket.source === 'MEMO' ? t.memoTitle : t.title}<input maxLength={120} value={editTitle} onChange={e => setEditTitle(e.target.value)}/></label><label>{ticket.source === 'MEMO' ? t.description : t.support}<textarea required maxLength={2000} rows={5} value={editContent} onChange={e => setEditContent(e.target.value)}/></label></details><label>{ticket.source === 'MEMO' ? t.memo : t.reply}<textarea aria-label={ticket.source === 'MEMO' ? t.memo : t.reply} rows={5} maxLength={2000} value={reply} onChange={e => setReply(e.target.value)}/></label><footer className="feedback-editor-footer"><label>{t.status}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.status} value={status} onChange={e => setStatus(e.target.value)}>{['OPEN', 'RESOLVED', 'IGNORED'].map(value => <option key={value} value={value}>{stateLabel(value, t)}</option>)}</select></label><button className="primary" disabled={busy}>{busy ? t.loading : ticket.source === 'CUSTOMER' ? (lang.startsWith('zh') ? '保存并发送回复' : 'Save and send reply') : t.save}</button></footer></form></article>;
}

function databaseLabel(name: string, t: any) {
    const keys: Record<string, string[]> = {
        Category: ['categories'], Product: ['products'], Price: ['products', 'amount'], FileVersion: ['file', 'version'],
        Session: ['account', 'login'], Order: ['orders'], OrderItem: ['orders', 'products'], Payment: ['paymentAttempts'], MockPayment: ['modeTest', 'payment'], PaymentEvent: ['events'],
        Entitlement: ['activeEntitlements'], DownloadToken: ['download', 'code'], DownloadLog: ['downloadHistory'], RecoveryToken: ['recover', 'code'], Refund: ['refunds'],
        Admin: ['admin'], SupportTicket: ['support'], Audit: ['audit'], Job: ['jobs'], MailMessage: ['mailRecords'], Setting: ['settings'], RateLimit: ['rateLimited'],
        Customer: ['customers'], ChatConversation: ['chat'], ChatMessage: ['chat', 'reply'], ChatAttachment: ['chat', 'file'], CustomerToken: ['customers', 'code'], FxSnapshot: ['rateSource'], AnalyticsEvent: ['analytics']
    };
    return (keys[name] || ['databaseUsage']).map(key => t[key]).join(' · ');
}
