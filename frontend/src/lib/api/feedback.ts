export type Feedback = { id: string; action: string; state: 'pending' | 'success' | 'error' | 'warning'; progress?: number; processing?: boolean; code?: string; count?: number; stage?: string; completed?: string[]; done?: number; total?: number };
export function feedback(value: Feedback) {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('operation-feedback', { detail: value }));
}
export function operation(path: string, method: string, body?: any): string | undefined {
    if (path === '/admin/customer-context') return;
    if (method === 'GET' || /\/translation$|\/analytics\/|\/events$|\/read$|\/seen$|\/chat\/preferences$/.test(path)) return;
    if (method === 'DELETE') return 'delete';
    // Delivery is confirmed in the chat itself; keep the conversation clear.
    if (/\/(chat|admin\/chat\/[^/]+)\/messages$/.test(path)) return;
    if (path.endsWith('/status') && body?.status) return body.status === 'PUBLISHED' ? 'publish' : 'unpublish';
    if (path.endsWith('/restore')) return 'restore';
    if (path.endsWith('/current-file') || path.endsWith('/attachments') || path.endsWith('/avatar')) return 'upload';
    if (path.endsWith('/download')) return; // The actual transfer reports its own progress.
    if (path.endsWith('/login')) return 'login';
    if (path.endsWith('/logout')) return 'logout';
    if (path.endsWith('/reauth')) return 'verify';
    if (/\/resend$|\/support$|\/refunds$|\/reply$|\/messages$|\/recover$/.test(path)) return 'send';
    if (/\/refresh$|\/query-payment$/.test(path)) return 'refresh';
    return 'save';
}

// Poll server-confirmed phases; percentages come from bytes or rendered pages.
export function watchOperation(id: string, action: string) {
    let stopped = false, running = false;
    const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const response = await fetch('/api/v1/admin/operations/' + id, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
            const value = response.ok ? await response.json() : null;
            if (!stopped && value && value.state === 'pending') feedback({ ...value, id, action, state: 'pending' });
        } catch { /* The mutation response remains the authority for success/failure. */ }
        finally { running = false; }
    };
    const timer = setInterval(() => void tick(), 800);
    return () => { stopped = true; clearInterval(timer); };
}
