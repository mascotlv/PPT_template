import { Policy } from '@/components/storefront';
export default async function Page({ params }: {
    params: Promise<{
        type: string;
    }>;
}) { return <Policy type={(await params).type}/>; }
