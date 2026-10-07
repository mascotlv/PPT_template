import nodemailer from 'nodemailer';
import { Config } from '../config';
import { DB } from '../db';
import { decrypt, escapeHtml } from '../security';
import { dictionaries } from '../commerce/dictionaries';
import { LANGUAGES, Language, DIGITS } from '../commerce/constants';
export interface MailAdapter {
    send(job: any): Promise<void>;
}
export class MailTransport implements MailAdapter {
    failNext = false;
    constructor(readonly db: DB, readonly config: Config) { }
    async send(job: any) {
        if (this.failNext) {
            this.failNext = false;
            throw new Error('TEST_MAIL_UNAVAILABLE');
        }
        const payload = job.payload as any;
        let email: string, subject: string, html: string;
        const customer = job.kind === 'RECOVERY' ? await this.db.customer.findUnique({ where: { email: payload.email } }) : null;
        const lang = (LANGUAGES.includes(payload.language) ? payload.language : customer?.language || 'zh') as Language;
        let t: any = dictionaries[lang];
        if (job.kind === 'OWNER_MAIL') {
            const o = await this.db.order.findUniqueOrThrow({ where: { id: job.relatedId }, include: { item: true, customer: true } });
            const refund = payload.refundId ? await this.db.refund.findUniqueOrThrow({ where: { id: payload.refundId } }) : null;
            const snapshot = o.item?.snapshot as any, amount = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: o.currency }).format((refund?.amount ?? o.amount) / 10 ** DIGITS[o.currency]);
            email = refund ? this.config.OWNER_REFUND_EMAIL : this.config.OWNER_PURCHASE_EMAIL;
            subject = `${o.isTest ? '【模拟测试】' : ''}${refund ? '买家申请退款，请审核' : '购买成功通知'} · ${o.number}`;
            html = `<html lang="zh"><body><p>${o.isTest ? '测试模式，不收取真实费用。' : '交易通知'}</p><h2>${escapeHtml(refund ? '买家申请退款' : '商品购买成功')}</h2><p>订单号：${escapeHtml(o.number)}</p><p>商品：${escapeHtml(snapshot?.translations?.zh?.title || snapshot?.titleZh || '')}</p><p>购买邮箱：${escapeHtml(o.email)}</p><p>国家/地区：${escapeHtml(o.country ? new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(o.country) || o.country : '未知')}</p><p>${refund ? '原付款退款金额' : '付款金额'}：${escapeHtml(amount)} (${escapeHtml(o.currency)})</p>${refund ? `<p>退款原因：${escapeHtml(refund.reason)}</p><p>请在后台同意或拒绝；同意后按原付款币种和金额原路处理。</p>` : ''}<p><a href="${this.config.PUBLIC_ORIGIN}/admin">进入管理后台</a></p></body></html>`;
        }
        else if (job.kind === 'ACCOUNT' || job.kind === 'RECOVERY') {
            email = payload.email;
            const raw = decrypt(payload.encryptedToken, this.config.ADMIN_ENCRYPTION_KEY);
            const account = job.kind === 'ACCOUNT';
            subject = account ? (payload.template === 'RESET' ? t.reset : t.verify) : t.recover;
            const url = account ? `/account#token=${raw}&kind=${payload.template}` : `/recover#token=${raw}`;
            html = `<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><body><p>${escapeHtml(this.config.MAIL_TRANSPORT === 'outbox' ? t.test : '')}</p><h2>${escapeHtml(subject)}</h2><p><a href="${this.config.PUBLIC_ORIGIN}${url}">${escapeHtml(t.confirm)}</a></p><p>${escapeHtml(account ? payload.template === 'RESET' ? t.passwordRule : t.verificationRequired : t.recoverInfo)}</p></body></html>`;
        }
        else {
            const o = await this.db.order.findUniqueOrThrow({ where: { id: job.relatedId }, include: { item: true } });
            email = o.email;
            t = dictionaries[o.language as Language] || dictionaries.zh;
            const labels: Record<string, string> = { delivery: t.ready, 'refund-request': t.refundRequested, 'refund-success': t.refunded, 'refund-failure': t.failure, 'refund-rejected': t.rejected };
            subject = labels[payload.template] || t.ready;
            const snapshot = o.item?.snapshot as any;
            const name = snapshot?.translations?.[o.language]?.title || (o.language === 'zh' ? snapshot?.titleZh : o.language === 'en' ? snapshot?.titleEn : t.translationMissing) || '';
            html = `<html lang="${escapeHtml(o.language)}" dir="${o.language === 'ar' ? 'rtl' : 'ltr'}"><body><p>${escapeHtml(o.isTest ? t.test : '')}</p><h2>${escapeHtml(subject)}</h2><p>${escapeHtml(o.number)}</p><p>${escapeHtml(name)}</p><p><a href="${this.config.PUBLIC_ORIGIN}/recover">${escapeHtml(t.recover)}</a></p></body></html>`;
        }
        const old = await this.db.mailMessage.findUnique({ where: { jobId: job.id } });
        if (old?.status === 'SENT')
            return;
        await this.db.mailMessage.upsert({ where: { jobId: job.id }, create: { jobId: job.id, recipient: email, subject, html, status: 'QUEUED' }, update: { subject, html, status: 'QUEUED' } });
        if (this.config.MAIL_TRANSPORT === 'smtp') {
            const transport = nodemailer.createTransport({ host: this.config.SMTP_HOST, port: this.config.SMTP_PORT, secure: this.config.SMTP_SECURE, requireTLS: this.config.SMTP_REQUIRE_TLS, auth: this.config.SMTP_USER ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD } : undefined, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, disableFileAccess: true, disableUrlAccess: true });
            const result = await transport.sendMail({ messageId: `<${job.id}@workshop.test>`, from: this.config.MAIL_FROM, to: email, subject, html });
            if (!result.accepted?.length || result.rejected?.length)
                throw new Error('MAIL_RECIPIENT_REJECTED');
        }
        await this.db.mailMessage.update({ where: { jobId: job.id }, data: { status: this.config.MAIL_TRANSPORT === 'smtp' ? 'SENT' : 'CAPTURED' } });
    }
}
