'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import type { Feedback } from '@/lib/api/feedback';
export function OperationFeedback() {
    const { t, lang } = useStore();
    const [items, setItems] = useState<Feedback[]>([]);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const chinese = lang.startsWith('zh');
    useEffect(() => {
        const activeTimers = timers.current;
        const receive = (event: Event) => {
            const item = (event as CustomEvent<Feedback>).detail;
            clearTimeout(activeTimers.get(item.id));
            setItems(previous => [...previous.filter(v => v.id !== item.id), item]);
            if (item.state !== 'pending') activeTimers.set(item.id, setTimeout(() => { setItems(previous => previous.filter(v => v.id !== item.id)); activeTimers.delete(item.id); }, ['error', 'warning'].includes(item.state) ? 20000 : 6000));
        };
        window.addEventListener('operation-feedback', receive);
        return () => { window.removeEventListener('operation-feedback', receive); activeTimers.forEach(clearTimeout); activeTimers.clear(); };
    }, []);
    const labels: Record<string, string> = { upload: t.uploadAction, download: t.download, delete: t.delete, publish: t.publish, unpublish: t.unpublish, restore: t.restore, save: t.save, login: t.login, logout: t.logout, verify: t.verifyIdentity, send: t.send, refresh: t.refresh, export: t.export };
    const errors: Record<string, string> = {
        INVALID_PDF: chinese ? '请选择有效的 PDF 文件。' : 'Choose a valid PDF file.',
        PDF_RENDER_FAILED: chinese ? 'PDF 预览生成失败，请查看商品跟踪记录；原有预览保留。' : 'PDF rendering failed. See the product trace; existing previews are retained.',
        PDF_PAGE_COUNT_MISMATCH: chinese ? 'PDF 页数与 PPTX 不一致，请按每张幻灯片一页导出 PDF。' : 'PDF pages must match PPTX slides. Export one slide per page.',
        ORIGINAL_REQUIRED: chinese ? '请先成功上传原文件，再上架；分类需可用。' : 'Upload the original successfully first and select an active category.',
        FILE_NAME_CONFLICT: chinese ? '同一分类已有同名文件，请修改商品名称。' : 'A file already uses this name in the category.',
        REAUTH_REQUIRED: t.reauth, FILE_TOO_LARGE: t.fileTooLarge, NETWORK_ERROR: t.networkError, CSRF_REJECTED: t.csrfError,
        PREVIEW_RENDER_FAILED: t.previewRenderFailed, PREVIEW_BUSY: t.previewBusy,
        DOWNLOAD_FAILED: t.downloadIncomplete, INVALID_PPTX: t.invalidPptx,
        TRANSLATION_NOT_CONFIGURED: t.translationNotConfigured, TRANSLATION_UNAVAILABLE: t.translationUnavailable,
    };
    const stages: Record<string, string> = chinese ? { receive: '文件接收 / 请求接收', validate: '文件与商品校验', render: '生成预览图', store: '保存原文件与预览', archive: '按分类归档 / 移动文件', translate: '检查自动翻译（未接入则跳过）', commit: '保存商品 / 上架状态', complete: '全部完成' } : { receive: 'Receive request / file', validate: 'Validate file and product', render: 'Generate previews', store: 'Save original and previews', archive: 'File by category / move file', translate: 'Automatic translation (skip when unavailable)', commit: 'Save product / publication status', complete: 'Complete' };
    return <div className="operation-feedback" aria-label={chinese ? '操作反馈' : 'Operation status'}>{items.map(item => {
        const label = labels[item.action] || t.save;
        const text = item.state === 'warning' ? (chinese ? '原文件已保存并归档，但预览生成失败；请在商品跟踪记录查看原因并重新生成。' : 'Original saved and filed; preview generation failed. See the product trace and regenerate previews.') : item.state === 'error' ? `${label}${chinese ? '' : ' · '}${t.operationFailed} · ${errors[item.code || ''] || t.requestError}` : item.stage ? `${label} · ${stages[item.stage] || item.stage}` : item.processing ? t.previewRendering : item.state === 'pending' ? `${label} · ${t.loading}` : `${label}${chinese ? '' : ' · '}${t.operationSuccess}${item.count ? ` · ${t.previewGenerated.replace('{count}', new Intl.NumberFormat(lang).format(item.count))}` : ''}`;
        return <div key={item.id} className={'operation-toast ' + item.state} role={item.state === 'error' ? 'alert' : 'status'}><span aria-hidden="true">{item.state === 'pending' ? '◌' : item.state === 'error' ? '!' : '✓'}</span><div><strong>{text}</strong>{item.completed?.length ? <small>{item.completed.map(stage => `✓ ${stages[stage] || stage}`).join(' · ')}</small> : null}{item.done !== undefined && <small>{item.done}/{item.total}</small>}{item.state === 'pending' && (item.stage || ['upload', 'download', 'export'].includes(item.action)) && <><progress aria-label={label} max={100} value={item.progress}/>{item.progress !== undefined && <small>{item.progress}%</small>}</>}</div>{item.state !== 'pending' && <button type="button" aria-label={t.close} onClick={() => { clearTimeout(timers.current.get(item.id)); timers.current.delete(item.id); setItems(previous => previous.filter(v => v.id !== item.id)); }}>×</button>}</div>;
    })}</div>;
}
