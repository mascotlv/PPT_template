'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { cnyMinor } from '../../../packages/contracts/cny.cjs';
import { DIGITS } from '@/locales/constants';
import { api } from '@/lib/api';
import { price, useStore } from './store';

const Rates = createContext<any>(null);
export function AdminMoneyProvider({ children }: { children: ReactNode }) {
    const [rates, setRates] = useState<any>(null);
    useEffect(() => {
        let active = true;
        const load = () => api('/admin/reporting-rates').then(data => { if (active) setRates(data.rates); }).catch(() => {});
        void load();
        const timer = setInterval(() => void load(), 15 * 60000);
        const refresh = () => void load();
        window.addEventListener('admin-rates-refresh', refresh);
        return () => { active = false; clearInterval(timer); window.removeEventListener('admin-rates-refresh', refresh); };
    }, []);
    return <Rates.Provider value={rates}>{children}</Rates.Provider>;
}
export function useAdminMoney() {
    const rates = useContext(Rates), { lang, t } = useStore();
    const convert = (amount: number, currency: string) => cnyMinor(amount, currency, rates?.[currency]?.rate, DIGITS[currency]);
    const format = (amount: number, currency: string, displayLanguage = lang) => {
        const value = convert(amount, currency);
        return value === null ? t.rateUnavailable : price(value, 'CNY', displayLanguage);
    };
    const total = (rows: any[]) => {
        let amount = 0;
        for (const row of rows) {
            const value = convert(row._sum.amount || 0, row.currency);
            if (value === null) return t.rateUnavailable;
            amount += value;
        }
        return price(amount, 'CNY', lang);
    };
    return { format, total };
}

export function AdminMailPreview({ mail }: { mail: { html: string; subject: string } }) {
    const rates = useContext(Rates), { lang } = useStore(), { format } = useAdminMoney();
    const [html, setHtml] = useState(mail.html);
    useEffect(() => {
        const document = new DOMParser().parseFromString(mail.html, 'text/html');
        for (const paragraph of document.querySelectorAll('p')) {
            const match = paragraph.textContent?.match(/^(付款金额|原付款退款金额)：(.+)\s+\(([A-Z]{3})\)$/);
            if (!match || !(match[3] in DIGITS)) continue;
            const amount = Math.round(Number(match[2].replace(/[^\d.-]/g, '')) * 10 ** DIGITS[match[3]]);
            paragraph.textContent = match[1] + '：' + format(amount, match[3]) + ' (CNY)';
        }
        setHtml(document.documentElement.outerHTML);
    }, [mail.html, rates, lang]);
    return <iframe title={mail.subject} sandbox="" srcDoc={html}/>;
}
