import { feedback, operation, watchOperation } from './feedback';
let csrf = '', adminCsrf = '';
let sessionRequest: Promise<any> | undefined;
const loginForms = new Set(['/account/login', '/account/register', '/admin/login']);
export class ApiError extends Error {
    constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); }
}
export function setTokens(data: {
    csrf?: string;
    adminCsrf?: string | null;
}) { if (data.csrf)
    csrf = data.csrf; if (data.adminCsrf !== undefined)
    adminCsrf = data.adminCsrf || ''; }
async function request<T = any>(path: string, method: string, body: unknown, recover: boolean, operationId?: string): Promise<T> {
    const mutation = method !== 'GET';
    const isAdmin = path.startsWith('/admin/') && path !== '/admin/login';
    const headers: Record<string, string> = {};
    if (operationId) headers['X-Operation-Id'] = operationId;
    if (mutation)
        headers['X-CSRF-Token'] = isAdmin ? adminCsrf : csrf;
    if (body && !(body instanceof FormData))
        headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(mutation && (/^\/admin\/(products|categories)(\/|$)/.test(path) || path === '/admin/maintenance/cleanup') ? 360000 : 15000) });
    }
    catch {
        throw new ApiError('NETWORK_ERROR', '网络不可用或请求超时 / Network unavailable or request timed out');
    }
    if (!response.ok) {
        const e = await response.json().catch(() => ({ message: 'Request failed' }));
        // CSRF rejection happens before the login handler. Recover once if another tab
        // changed the cookie after our preflight; never retry a transaction or upload.
        if (recover && method === 'POST' && loginForms.has(path) && response.status === 403 && e.code === 'CSRF_REJECTED') {
            await api('/session');
            return request<T>(path, method, body, false, operationId);
        }
        throw new ApiError(e.code || 'ERROR', Array.isArray(e.message) ? e.message.join(', ') : e.message || 'Request failed', e.requestId);
    }
    const value = await response.json();
    if (path === '/session')
        setTokens(value);
    return value;
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown, feedbackAction?: string): Promise<T> {
    if (path === '/session' && method === 'GET') {
        if (!sessionRequest)
            sessionRequest = request(path, method, undefined, false).finally(() => { sessionRequest = undefined; });
        return sessionRequest;
    }
    // Refresh only when submitting an authentication form: no background timers,
    // no form reset, and concurrent session reads share one request.
    if (method === 'POST' && loginForms.has(path))
        await api('/session');
    const action = feedbackAction || operation(path, method, body), id = crypto.randomUUID();
    if (action) feedback({ id, action, state: 'pending' });
    const stop = action && path.startsWith('/admin/') ? watchOperation(id, action) : () => {};
    try {
        const result = await request<T>(path, method, body, true, id);
        stop();
        if (action) feedback({ id, action, state: 'success' });
        return result;
    } catch (error) {
        stop();
        if (action) feedback({ id, action, state: 'error', code: error instanceof ApiError ? error.code : undefined });
        throw error;
    }
}
export async function downloadFile(path: string, filename?: string, method = 'GET', action = 'download') {
    const id = crypto.randomUUID();
    feedback({ id, action, state: 'pending', progress: 0 });
    try {
        const response = await fetch(path, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'X-CSRF-Token': adminCsrf } : {} });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new ApiError(error.code || 'DOWNLOAD_FAILED', error.message || 'Download failed'); }
        const total = Number(response.headers.get('Content-Length')) || 0;
        const chunks: BlobPart[] = []; let loaded = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new ApiError('DOWNLOAD_FAILED', 'Empty download response');
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value.slice().buffer); loaded += value.byteLength;
            feedback({ id, action, state: 'pending', progress: total ? Math.min(99, Math.round(loaded / total * 100)) : undefined });
        }
        if (total && loaded !== total) throw new ApiError('DOWNLOAD_FAILED', 'Incomplete download');
        const disposition = response.headers.get('Content-Disposition') || '';
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        if (!filename) { try { filename = encoded ? decodeURIComponent(encoded) : disposition.match(/filename="([^"]+)"/i)?.[1]; } catch { /* use fallback */ } }
        const url = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = filename || 'download'; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        feedback({ id, action, state: 'success', progress: 100 });
    } catch (error) {
        feedback({ id, action, state: 'error', code: error instanceof ApiError ? error.code : 'NETWORK_ERROR' });
        throw error;
    }
}
export async function exportOrders() { await downloadFile('/api/v1/admin/orders/export', 'orders.csv', 'POST', 'export'); }
// Uploads include large PPTX files, so plain fetch() gives no feedback and its 15s timeout is far
// too short. This variant uses XHR: no timeout, and reports upload progress for a real progress bar.
export function uploadAttachment<T = any>(path: string, file: File, onProgress?: (percent: number) => void): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    return uploadForm<T>(path, form, onProgress);
}
export function uploadForm<T = any>(path: string, form: FormData, onProgress?: (percent: number) => void): Promise<T> {
    const id = crypto.randomUUID(), action = 'upload';
    const files = [form.get('file'), form.get('pdf')];
    if (files.some(file => file instanceof Blob && file.size > 1024 * 1024 * 1024)) {
        feedback({ id, action, state: 'error', code: 'FILE_TOO_LARGE' });
        return Promise.reject(new ApiError('FILE_TOO_LARGE', 'File exceeds 1 GiB'));
    }
    const original = path.endsWith('/current-file') && ['original', 'original-pdf', 'preview-pdf'].includes(String(form.get('kind')));
    feedback({ id, action, state: 'pending', progress: 0 });
    return new Promise<T>((resolve, reject) => {
        const isAdmin = path.startsWith('/admin/');
        const request = new XMLHttpRequest();
        request.open('POST', `/api/v1${path}`);
        request.withCredentials = true;
        request.setRequestHeader('X-CSRF-Token', isAdmin ? adminCsrf : csrf);
        request.setRequestHeader('X-Operation-Id', id);
        let stop = () => {};
        request.upload.onload = () => { stop = isAdmin ? watchOperation(id, action) : () => {}; onProgress?.(100); feedback({ id, action, state: 'pending', progress: 100, processing: original }); }; 
        request.upload.onprogress = event => { if (event.lengthComputable) {
            const progress = Math.round(event.loaded / event.total * 100);
            onProgress?.(progress); feedback({ id, action, state: 'pending', progress, processing: original && progress === 100 });
        } };

        request.onload = () => {
            stop();
            let payload: any = null;
            try {
                payload = JSON.parse(request.responseText);
            }
            catch {
                payload = null;
            }
            if (request.status >= 200 && request.status < 300 && payload && !payload.code) {
                feedback({ id, action, state: payload.previewWarning ? 'warning' : 'success', code: payload.previewWarning, count: payload.previewCount });
                resolve(payload as T);
            } else {
                feedback({ id, action, state: 'error', code: payload?.code });
                reject(new ApiError(payload?.code || 'UPLOAD_FAILED', Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message || 'Upload failed', payload?.requestId));
            }
        };
        request.onerror = () => { stop(); feedback({ id, action, state: 'error', code: 'NETWORK_ERROR' }); reject(new ApiError('NETWORK_ERROR', 'Network unavailable')); };
        request.onabort = () => { stop(); feedback({ id, action, state: 'error', code: 'UPLOAD_ABORTED' }); reject(new ApiError('UPLOAD_ABORTED', 'Upload cancelled')); };
        request.send(form);
    });
}
