'use client';
import { api } from '@/lib/api';
import { useStore, countryName } from './store';
export async function enrichCustomers(data: any) {
    const ids = new Set<string>(), emails = new Set<string>();
    function collect(value: any) {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (typeof child === 'string' && (key === 'id' || key.endsWith('Id'))) ids.add(child);
            if ((key === 'email' || key === 'recipient') && typeof child === 'string') emails.add(child);
            if (typeof child === 'object') collect(child);
        }
    }
    collect(data);
    if (!ids.size && !emails.size) return data;
    const context = await api('/admin/customer-context', 'POST', { ids: [...ids].slice(0, 2000), emails: [...emails].slice(0, 1000) });
    function apply(value: any): any {
        if (Array.isArray(value)) return value.map(apply);
        if (!value || typeof value !== 'object') return value;
        const result: any = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, apply(v)]));
        const customer = context.byId[value.customerId] || context.byId[value.id] || context.byId[value.relatedId] || context.byId[value.objectId] || context.byId[value.jobId] || context.byEmail[value.email] || context.byEmail[value.recipient];
        if (customer) result.customerSummary = customer;
        return result;
    }
    return apply(data);
}
export function CustomerSummary({ record }: { record: any }) {
    const { t, lang } = useStore(), customer = record?.customerSummary;
    if (!customer) return null;
    return <dl className="customer-summary"><div><dt>{t.name}</dt><dd>{customer.name}</dd></div><div><dt>{t.nickname}</dt><dd>{customer.nickname}</dd></div><div><dt>{t.country}</dt><dd>{countryName(customer.country, lang)}</dd></div><div><dt>{t.email}</dt><dd>{customer.email}</dd></div><div><dt>{t.totalPurchases}</dt><dd>{customer.purchaseCount}</dd></div></dl>;
}
