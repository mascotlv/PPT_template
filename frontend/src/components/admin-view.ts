'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Keep navigation state per administrator and browser tab; never store form credentials.
export function useAdminView(adminId: string | undefined, view: any, restore: (view: any) => void) {
    const layout = useRef<HTMLElement>(null), sidebar = useRef<HTMLElement>(null), content = useRef<HTMLElement>(null);
    const [ready, setReady] = useState(false);
    const saved = useRef<any>({}), current = useRef(view), restoreCallback = useRef(restore), pendingScroll = useRef(true);
    current.current = view;
    restoreCallback.current = restore;
    const key = 'workshop-admin-view-v1:' + adminId;
    useEffect(() => {
        if (!adminId) { setReady(false); return; }
        try { saved.current = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { saved.current = {}; }
        restoreCallback.current(saved.current);
        pendingScroll.current = true;
        setReady(true);
        const persist = () => {
            saved.current = { ...saved.current, ...current.current };
            try { sessionStorage.setItem(key, JSON.stringify(saved.current)); } catch { /* Storage can be disabled. */ }
        };
        window.addEventListener('pagehide', persist);
        return () => { persist(); window.removeEventListener('pagehide', persist); };
    }, [adminId, key]);
    useEffect(() => {
        if (!ready) return;
        saved.current = { ...saved.current, ...view };
        try { sessionStorage.setItem(key, JSON.stringify(saved.current)); } catch { /* Storage can be disabled. */ }
    }, [ready, key, view.tab, view.page, view.search, view.filters, view.period]);
    useLayoutEffect(() => {
        if (!ready || !layout.current) return;
        const resize = () => {
            const header = document.querySelector('.header');
            layout.current?.style.setProperty('--admin-header-height', (header?.getBoundingClientRect().height || 0) + 'px');
        };
        resize();
        const observer = new ResizeObserver(resize);
        const header = document.querySelector('.header');
        if (header) observer.observe(header);
        return () => observer.disconnect();
    }, [ready]);
    useLayoutEffect(() => {
        if (!ready) return;
        pendingScroll.current = true;
        if (sidebar.current) sidebar.current.scrollTop = saved.current.sidebarScroll || 0;
    }, [ready, view.tab]);
    const restoreScroll = () => {
        if (!pendingScroll.current || !content.current) return;
        content.current.scrollTop = saved.current.scroll?.[current.current.tab] || 0;
        pendingScroll.current = false;
    };
    const onScroll = (side: 'sidebar' | 'content') => {
        if (!ready || pendingScroll.current) return;
        const top = (side === 'sidebar' ? sidebar : content).current?.scrollTop || 0;
        if (side === 'sidebar') saved.current.sidebarScroll = top;
        else saved.current.scroll = { ...saved.current.scroll, [current.current.tab]: top };
        try { sessionStorage.setItem(key, JSON.stringify({ ...saved.current, ...current.current })); } catch { /* Storage can be disabled. */ }
    };
    return { ready, layout, sidebar, content, restoreScroll, onScroll };
}
