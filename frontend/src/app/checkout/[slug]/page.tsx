import { Checkout } from '@/components/storefront';
export default async function Page({ params }: {
    params: Promise<{
        slug: string;
    }>;
}) { return <Checkout slug={(await params).slug}/>; }
