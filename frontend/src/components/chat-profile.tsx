'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore, ErrorBox } from './store';

function defaultAvatar(seed: string) {
    let hash = 0; for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    const hue = hash % 360, ears = hash % 2 ? '<path d="M22 34 L18 12 L40 28 M58 28 L78 12 L76 36" fill="#fff"/>' : '<circle cx="27" cy="28" r="13" fill="#fff"/><circle cx="69" cy="28" r="13" fill="#fff"/>';
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="hsl(${hue} 55% 78%)"/>${ears}<ellipse cx="48" cy="52" rx="31" ry="29" fill="#fff"/><circle cx="37" cy="47" r="4" fill="#24334d"/><circle cx="59" cy="47" r="4" fill="#24334d"/><ellipse cx="48" cy="59" rx="5" ry="4" fill="#cc7a87"/><path d="M40 65 Q48 73 56 65" fill="none" stroke="#24334d" stroke-width="3" stroke-linecap="round"/></svg>`);
}
export function ChatAvatar({ profile }: { profile: any }) {
    return <span className="chat-avatar" aria-label={profile?.nickname}><img src={profile?.avatar || defaultAvatar(profile?.id || profile?.nickname || 'guest')} alt=""/></span>;
}
export function AvatarPicker({ nickname, avatar, onChange }: { nickname: string; avatar: string; onChange: (value: string) => void }) {
    const { t } = useStore();
    const [error, setError] = useState(false);
    return <div className="avatar-picker"><ChatAvatar profile={{ nickname, avatar }}/><label>{t.avatar}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        if (file.size > 20 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError(true); return; }
        const url = URL.createObjectURL(file);
        try {
            const image = new Image(); image.src = url; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
            const size = Math.min(image.width, image.height);
            canvas.getContext('2d')!.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 128, 128);
            onChange(canvas.toDataURL('image/webp', .85)); setError(false);
        } catch { setError(true); } finally { URL.revokeObjectURL(url); }
    }}/></label>{avatar && <button type="button" onClick={() => onChange('')}>{t.removeAttachment}</button>}{error && <p className="error" role="alert">{t.invalidInput}</p>}</div>;
}
export function MerchantAccount({ verified, onCredentialsChange }: { verified: boolean; onCredentialsChange: () => void }) {
    const { session, t, reload } = useStore();
    const [nickname, setNickname] = useState(session.admin.nickname), [avatar, setAvatar] = useState(session.admin.avatar || ''), [email, setEmail] = useState(session.admin.email), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<unknown>();
    return <><form className="merchant-account account-settings" onSubmit={async e => {
        e.preventDefault(); if (!verified) return; setBusy(true); setSaved(false); setError(undefined);
        try { const result = await api('/admin/account', 'PATCH', { nickname, avatar, email, ...(password ? { password } : {}) }); setPassword(''); if (result.credentialsChanged) onCredentialsChange(); await reload(); setSaved(true); }
        catch (e) { setError(e); } finally { setBusy(false); }
    }}><div className="account-settings-grid"><section className="account-setting-card"><h2>{t.avatar}</h2><AvatarPicker nickname={nickname} avatar={avatar} onChange={setAvatar}/></section><section className="account-setting-card"><h2>{t.nickname}</h2><label>{t.nickname}<input aria-label={t.nickname} required maxLength={80} value={nickname} onChange={e => setNickname(e.target.value)}/></label></section><section className="account-setting-card"><h2>{t.email}</h2><label>{t.email}<input aria-label={t.email} type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></label></section><section className="account-setting-card"><h2>{t.credentialNewPassword}</h2><label>{t.credentialNewPassword}<input aria-label={t.credentialNewPassword} type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)}/><small>{t.passwordKeepHelp}</small></label></section></div>{!!error && <ErrorBox error={error}/>}<p role="status">{saved ? t.saved : ''}</p><div className="centered-save"><button className="primary" disabled={busy || !verified || !nickname.trim()} title={!verified ? t.reauth : undefined}>{busy ? t.loading : t.save}</button></div></form><details className="translation-settings-details"><summary>{t.chatTranslationService}</summary><TranslationSettings/></details></>;
}
function TranslationSettings() {
    const { t } = useStore();
    const [settings, setSettings] = useState<any>(null), [apiKey, setApiKey] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<unknown>();
    useEffect(() => { api('/admin/chat/translation-settings').then(setSettings).catch(setError); }, []);
    return <section className="merchant-account"><h2>{t.chatTranslationService}</h2>{!!error && <ErrorBox error={error}/>} {settings && <form className="form-panel" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setSaved(false); setError(undefined);
        try { await api('/admin/chat/translation-settings', 'PATCH', { provider: settings.provider, url: settings.url, apiKey }); setApiKey(''); setSettings(await api('/admin/chat/translation-settings')); setSaved(true); window.dispatchEvent(new Event('chat-translation-settings')); }
        catch (e) { setError(e); } finally { setBusy(false); }
    }}><label>{t.chatTranslationService}<span className="required-mark" aria-hidden="true"> *</span><select required aria-label={t.chatTranslationService} value={settings.provider} onChange={e => setSettings({ ...settings, provider: e.target.value })}><option value="disabled">{t.chatTranslationOff}</option><option value="google">Google Cloud Translation</option><option value="libretranslate">LibreTranslate</option></select></label>{settings.provider === 'libretranslate' && <label>LibreTranslate URL<span className="required-mark" aria-hidden="true"> *</span><input aria-label="LibreTranslate URL" type="url" required value={settings.url} placeholder="https://translate.example.com/translate" onChange={e => setSettings({ ...settings, url: e.target.value })}/></label>}{settings.provider !== 'disabled' && <label>API Key{(settings.provider === 'google' && !settings.hasKey) && <span className="required-mark" aria-hidden="true"> *</span>}<input aria-label="API Key" type="password" autoComplete="new-password" maxLength={1000} required={settings.provider === 'google' && !settings.hasKey} value={apiKey} onChange={e => setApiKey(e.target.value)}/><small>{t.chatTranslationKeyHelp}</small></label>}<p role="status">{saved ? t.saved : ''}</p><button className="primary" disabled={busy}>{t.save}</button></form>}</section>;
}
