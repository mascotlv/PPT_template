'use client';
import Link from 'next/link';
import { useStore } from '@/components/store';
export default function NotFound() { const { t } = useStore(); return <main className="narrow"><h1>404 · {t.empty}</h1><Link href="/">{t.back}</Link></main>; }
