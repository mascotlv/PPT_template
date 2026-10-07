'use client';
import { useState } from 'react';
import { dictionaries } from '@/locales/dictionaries';
import type { Language } from '@/locales/constants';
import { useStore, LanguageOptions } from './store';

export function FrontendTextSettings({ data, verified, save }: { data: any; verified: boolean; save: (body: any) => Promise<boolean> }) {
    const { t } = useStore();
    const [language, setLanguage] = useState<Language>('zh'), [search, setSearch] = useState(''), [drafts, setDrafts] = useState<Record<string, Record<string, any>>>({}), [busy, setBusy] = useState(false);
    const defaults = dictionaries[language], values = drafts[language] || data.translations?.[language] || {};
    const keys = Object.keys(defaults).filter(key => [key, (dictionaries.zh as any)[key], (defaults as any)[key], values[key]].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    function change(key: string, value: any) { setDrafts(previous => ({ ...previous, [language]: { ...values, [key]: value } })); }
    return <form className="frontend-text-settings" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await save({ language, values }); } finally { setBusy(false); } }}>
        <p>{t.frontendTextHelp}</p><div className="frontend-text-toolbar"><label>{t.language}<select aria-label={t.language} value={language} onChange={e => setLanguage(e.target.value as Language)}><LanguageOptions/></select></label><label>{t.search}<input type="search" aria-label={t.search} value={search} onChange={e => setSearch(e.target.value)}/></label></div>
        <div className="frontend-text-fields">{keys.map(key => <section className="frontend-text-field" key={key}><label><span>{(dictionaries.zh as any)[key] instanceof Array ? key : (dictionaries.zh as any)[key]}</span><small>{key}</small>{Array.isArray((defaults as any)[key]) ? (defaults as any)[key].map((_: string, index: number) => <textarea key={index} aria-label={key + ' ' + (index + 1)} rows={2} maxLength={2000} value={(values[key] || (defaults as any)[key])[index]} onChange={e => { const next = [...(values[key] || (defaults as any)[key])]; next[index] = e.target.value; change(key, next); }}/>) : <textarea aria-label={key} rows={String(values[key] ?? (defaults as any)[key]).length > 150 ? 4 : 2} maxLength={20000} value={values[key] ?? (defaults as any)[key]} onChange={e => change(key, e.target.value)}/>}</label><button type="button" onClick={() => { const next = { ...values }; delete next[key]; setDrafts(previous => ({ ...previous, [language]: next })); }}>{t.restoreDefault}</button></section>)}</div>
        <div className="centered-save"><button className="primary" disabled={busy || !verified} title={!verified ? t.reauth : undefined}>{busy ? t.loading : t.save}</button></div>
    </form>;
}
