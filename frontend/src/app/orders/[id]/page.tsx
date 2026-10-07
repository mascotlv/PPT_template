import { OrderPage } from '@/components/storefront';
export default async function Page({ params }: {
    params: Promise<{
        id: string;
    }>;
}) { return <OrderPage id={(await params).id}/>; }
