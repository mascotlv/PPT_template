import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Store } from '@/components/store';
import './globals.css';
export const metadata: Metadata = { title: { default: '模板工坊 · 原创演示模板', template: '%s · 模板工坊' }, description: '原创可编辑演示文稿模板，清晰的结构与克制的设计。模拟支付测试商城，不收取真实费用。', robots: { index: false, follow: false }, openGraph: { title: '模板工坊 · 原创演示模板', description: '让好想法，有好看的开场。自有演示模板测试商城。', type: 'website' } };
export default async function Layout({ children }: {
    children: React.ReactNode;
}) { await headers(); return <html lang="zh"><body><Store>{children}</Store></body></html>; }
