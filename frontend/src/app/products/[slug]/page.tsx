import { ProductDetail } from '@/components/storefront';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
export async function generateMetadata({ params }: {
    params: Promise<{
        slug: string;
    }>;
}): Promise<Metadata> { const { slug } = await params; try {
    const response = await fetch(`${process.env.BACKEND_URL || 'http://127.0.0.1:4100'}/api/v1/products/${encodeURIComponent(slug)}`, { headers: { Cookie: (await cookies()).toString() }, cache: 'no-store' });
    if (response.ok) {
        const p = await response.json();
        return { title: p.titleZh, description: p.descriptionZh, openGraph: { title: p.titleZh, description: p.descriptionZh, images: p.versions[0]?.previews[0] ? [{ url: `/api/v1/previews/${p.versions[0].previews[0]}` }] : [] } };
    }
}
catch { } return { title: '原创演示模板' }; }
export default async function Page({ params }: {
    params: Promise<{
        slug: string;
    }>;
}) { return <ProductDetail slug={(await params).slug}/>; }
