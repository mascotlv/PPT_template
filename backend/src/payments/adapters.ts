import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DB } from '../db';
import { mac, same } from '../security';
import { CURRENCIES } from '../commerce/constants';
export const eventSchema = z.object({ eventId: z.uuid(), paymentId: z.uuid(), orderId: z.uuid(), channelOrderId: z.string(), transactionId: z.string(), merchant: z.string(), amount: z.number().int().positive(), currency: z.enum(CURRENCIES), status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) }).strict();
export type PaymentEvent = z.infer<typeof eventSchema>;
export interface PaymentAdapter {
    createCheckout(input: {
        paymentId: string;
    }): Promise<{
        type: 'mock';
        paymentId: string;
    }>;
    confirmPayment(input: {
        paymentId: string;
        scenario: string;
    }): Promise<PaymentEvent | undefined>;
    queryPayment(input: {
        paymentId: string;
    }): Promise<PaymentEvent>;
    verifyAndParseNotification(raw: Buffer, headers: Record<string, any>): PaymentEvent;
    refund(input: {
        refundId: string;
    }): Promise<{
        status: string;
    }>;
    queryRefund(input: {
        refundId: string;
    }): Promise<{
        status: string;
    }>;
    getCapabilities(): {
        enabled: boolean;
        implemented: boolean;
        currencies: string[];
    };
}
export class DisabledAdapter implements PaymentAdapter {
    constructor(readonly provider: string) { }
    getCapabilities() { return { enabled: false, implemented: false, currencies: [] }; }
    private fail(): never { throw new ServiceUnavailableException({ code: 'PAYMENT_DISABLED', message: 'Real payment channel is not implemented or configured' }); }
    async createCheckout(_input: {
        paymentId: string;
    }): Promise<any> { return this.fail(); }
    async confirmPayment(_input: {
        paymentId: string;
        scenario: string;
    }): Promise<any> { return this.fail(); }
    async queryPayment(_input: {
        paymentId: string;
    }): Promise<any> { return this.fail(); }
    verifyAndParseNotification(_raw: Buffer, _headers: Record<string, any>): never { return this.fail(); }
    async refund(_input: {
        refundId: string;
    }): Promise<any> { return this.fail(); }
    async queryRefund(_input: {
        refundId: string;
    }): Promise<any> { return this.fail(); }
}
export class MockAdapter implements PaymentAdapter {
    constructor(private db: DB, private key: string) { }
    getCapabilities() { return { enabled: true, implemented: true, currencies: [...CURRENCIES] }; }
    async createCheckout({ paymentId }: {
        paymentId: string;
    }) { await this.db.mockPayment.upsert({ where: { paymentId }, create: { paymentId, transactionId: `mock_tx_${randomUUID()}` }, update: {} }); return { type: 'mock' as const, paymentId }; }
    async queryPayment({ paymentId }: {
        paymentId: string;
    }) {
        let p = await this.db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { channel: true } });
        if (!p.channel)
            throw new BadRequestException('Channel record missing');
        if (p.channel.settleAt && p.channel.settleAt <= new Date()) {
            await this.db.mockPayment.update({ where: { paymentId }, data: { status: 'SUCCEEDED', settleAt: null } });
            p = await this.db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { channel: true } });
        }
        return { eventId: randomUUID(), paymentId: p.id, orderId: p.orderId, channelOrderId: p.channelOrderId, transactionId: p.channel!.transactionId, merchant: p.merchant, amount: p.amount, currency: p.currency as PaymentEvent['currency'], status: p.channel!.status as PaymentEvent['status'] };
    }
    async confirmPayment({ paymentId, scenario }: {
        paymentId: string;
        scenario: string;
    }) {
        const states: Record<string, string> = { success: 'SUCCEEDED', cancel: 'CANCELLED', failure: 'FAILED', pending: 'PENDING', delayed: 'PENDING', lost: 'SUCCEEDED', duplicate: 'SUCCEEDED', different: 'SUCCEEDED' };
        if (!(scenario in states))
            throw new BadRequestException('Invalid mock scenario');
        const p = await this.db.mockPayment.findUniqueOrThrow({ where: { paymentId } });
        if (p.status === 'SUCCEEDED' && states[scenario] !== 'SUCCEEDED')
            return this.queryPayment({ paymentId });
        await this.db.mockPayment.update({ where: { paymentId }, data: { status: states[scenario], settleAt: scenario === 'delayed' ? new Date(Date.now() + 3000) : null } });
        return scenario === 'lost' ? undefined : this.queryPayment({ paymentId });
    }
    sign(raw: Buffer, eventId: string, timestamp = Math.floor(Date.now() / 1000).toString()) { return { 'x-mock-timestamp': timestamp, 'x-mock-event': eventId, 'x-mock-signature': mac(this.key, `${timestamp}.${eventId}.${raw.toString('utf8')}`) }; }
    verifyAndParseNotification(raw: Buffer, headers: Record<string, any>) {
        const timestamp = String(headers['x-mock-timestamp'] || '');
        const eventId = String(headers['x-mock-event'] || '');
        const signature = String(headers['x-mock-signature'] || '');
        if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !same(mac(this.key, `${timestamp}.${eventId}.${raw.toString('utf8')}`), signature))
            throw new BadRequestException({ code: 'INVALID_SIGNATURE', message: 'Invalid payment notification' });
        const parsed = eventSchema.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success || parsed.data.eventId !== eventId)
            throw new BadRequestException('Invalid event fields');
        return parsed.data;
    }
    async refund({ refundId }: {
        refundId: string;
    }) {
        const result = await this.db.$transaction(async (tx) => { await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${`mock-refund:${refundId}`}))`; const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId } }); if (r.channelRefundId)
            return { status: r.channelStatus || 'UNKNOWN', timeout: false }; const status = r.scenario === 'failure' ? 'FAILED' : r.scenario === 'pending' ? 'PENDING' : 'SUCCEEDED'; await tx.refund.update({ where: { id: refundId }, data: { channelRefundId: `mock_ref_${randomUUID()}`, channelStatus: status, settleAt: r.scenario === 'pending' ? new Date(Date.now() + 3000) : null } }); return { status, timeout: r.scenario === 'timeout' }; });
        if (result.timeout)
            throw new Error('CHANNEL_RESULT_UNKNOWN');
        return { status: result.status };
    }
    async queryRefund({ refundId }: {
        refundId: string;
    }) {
        let r = await this.db.refund.findUniqueOrThrow({ where: { id: refundId } });
        if (r.settleAt && r.settleAt <= new Date())
            r = await this.db.refund.update({ where: { id: refundId }, data: { channelStatus: 'SUCCEEDED', settleAt: null } });
        return { status: r.channelStatus || 'UNKNOWN' };
    }
}
export function registry(db: DB, key: string) { return { mock: new MockAdapter(db, key), alipay: new DisabledAdapter('alipay'), wechat: new DisabledAdapter('wechat'), paypal: new DisabledAdapter('paypal') }; }
