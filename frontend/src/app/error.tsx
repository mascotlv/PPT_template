'use client';
import { useStore } from '@/components/store';
export default function Error({ reset }: {
    reset: () => void;
}) { const { t } = useStore(); return <main className="narrow"><h1>{t.requestError}</h1><button onClick={reset}>{t.retry}</button></main>; }
