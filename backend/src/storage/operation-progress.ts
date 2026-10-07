import { randomUUID } from 'node:crypto';
import type { DB } from '../db';
type Step = { stage: string; state: string; at: string; progress?: number; done?: number; total?: number; code?: string; reason?: string };
type Progress = { owner: string; updated: number; state: string; stage: string; completed: string[]; steps: Step[]; progress?: number; done?: number; total?: number; productId?: string; action?: string; requestId?: string; error?: string; reason?: string; db?: DB; queue?: Promise<void> };
const entries = new Map<string, Progress>();
const idOf = (req: any) => req.operationId || String(req.headers['x-operation-id'] || '');
function persist(id: string, item: Progress) {
    if (!item.db || !item.productId) return;
    const key = 'productTrace:' + item.productId + ':' + id;
    const { db, queue: _queue, owner: _owner, ...snapshot } = item;
    const value = JSON.parse(JSON.stringify({ ...snapshot, operationId: id }));
    item.queue = (item.queue || Promise.resolve()).then(async () => {
        await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }).catch(() => { console.error('Product trace persistence failed'); });
}
export function beginOperation(req: any, res: any, db: DB) {
    if (!req.admin) return;
    const supplied = String(req.headers['x-operation-id'] || '');
    const id = req.operationId = /^[a-f\d-]{36}$/i.test(supplied) ? supplied : randomUUID();
    for (const [key, value] of entries) if (Date.now() - value.updated > 600000) entries.delete(key);
    if (entries.size >= 1000 || entries.has(id)) return;
    const match = req.path.match(/\/admin\/products\/([^/]+)/);
    const action = req.path.endsWith('/status') ? (req.body?.status === 'PUBLISHED' ? 'publish' : 'unpublish') : req.path.endsWith('/current-file') ? 'upload' : req.path.endsWith('/previews/regenerate') ? 'preview' : req.method === 'DELETE' ? 'delete' : 'save';
    const item: Progress = { db, owner: req.admin.adminId, updated: Date.now(), state: 'pending', stage: 'receive', completed: [], steps: [{ stage: 'receive', state: 'pending', at: new Date().toISOString() }], productId: match?.[1], action, requestId: req.requestId };
    entries.set(id, item); persist(id, item);
    res.once('finish', () => {
        const last = item.steps.at(-1)!;
        last.state = res.statusCode < 400 ? 'success' : 'error';
        item.state = res.statusCode < 400 ? (item.error ? 'warning' : 'success') : 'error'; item.updated = Date.now();
        if (res.statusCode < 400) { item.completed.push(item.stage); item.stage = 'complete'; item.progress = 100; }
        persist(id, item);
    });
}
export function attachProduct(req: any, productId: string) {
    const item = entries.get(idOf(req)); if (!item) return;
    item.productId = productId; persist(idOf(req), item);
}
export function operationAction(req: any, action: string) {
    const item = entries.get(idOf(req)); if (!item) return;
    item.action = action; persist(idOf(req), item);
}
export function operationIssue(req: any, code: string, reason: string) {
    const item = entries.get(idOf(req)); if (!item) return;
    item.error = code; item.reason = reason.slice(0, 500); item.updated = Date.now();
    const last = item.steps.at(-1); if (last) Object.assign(last, { state: 'error', code, reason: item.reason });
    persist(idOf(req), item);
}
export function operationStage(req: any, stage: string, progress?: number, done?: number, total?: number) {
    const item = entries.get(idOf(req));
    if (!item || item.owner !== req.admin?.adminId || item.state !== 'pending') return;
    if (item.stage !== stage) {
        const last = item.steps.at(-1)!; if (last.state !== 'error') { last.state = 'success'; item.completed.push(item.stage); }
        item.stage = stage; item.steps.push({ stage, state: 'pending', at: new Date().toISOString() });
    }
    Object.assign(item, { updated: Date.now(), progress, done, total });
    Object.assign(item.steps.at(-1)!, { progress, done, total }); persist(idOf(req), item);
}
export function operationProgress(id: string, owner: string) {
    const item = entries.get(id);
    if (!item || item.owner !== owner || Date.now() - item.updated > 600000) return null;
    const { owner: _owner, updated: _updated, db: _db, queue: _queue, ...value } = item;
    return value;
}
export async function flushOperation(req: any) { await entries.get(idOf(req))?.queue; }
