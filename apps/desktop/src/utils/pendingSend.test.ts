import { describe, it, expect } from 'vitest';
import { applySendPatch, adoptServerCopy, settleInterruptedSends, sendFailureReason, isUnconfirmedSend } from './pendingSend';

type Row = { id: string; content: { client_msg_id: string; type: string; text: string }; timestamp: string; send_state?: 'sending' | 'failed'; send_error?: string; sender_user_id?: string };
const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, content: { client_msg_id: id, type: 'text', text: id }, timestamp: 't', ...extra });

describe('applySendPatch', () => {
    it('marks a row failed with a reason, by id or client_msg_id', () => {
        const t = [row('a'), row('b', { send_state: 'sending' })];
        const out = applySendPatch(t, 'b', { send_state: 'failed', send_error: 'No connection' });
        expect(out[1]).toMatchObject({ send_state: 'failed', send_error: 'No connection' });
        expect(out[0]).toBe(t[0]);
        expect(t[1].send_state).toBe('sending'); // input untouched
    });

    it('delivered (null) removes the marker and the error entirely', () => {
        const t = [row('a', { send_state: 'failed', send_error: 'x' })];
        const out = applySendPatch(t, 'a', { send_state: null });
        expect('send_state' in out[0]).toBe(false);
        expect('send_error' in out[0]).toBe(false);
    });

    it('a retry (sending) clears the old error', () => {
        const out = applySendPatch([row('a', { send_state: 'failed', send_error: 'x' })], 'a', { send_state: 'sending' });
        expect(out[0].send_state).toBe('sending');
        expect('send_error' in out[0]).toBe(false);
    });

    it('a channel row takes its server id and sender on delivery', () => {
        const out = applySendPatch([row('local-1', { send_state: 'sending' })], 'local-1', { send_state: null, id: 'srv-9', sender_user_id: 'u1' });
        expect(out[0]).toMatchObject({ id: 'srv-9', sender_user_id: 'u1' });
        expect((out[0].content as { client_msg_id: string }).client_msg_id).toBe('local-1');
    });

    it('returns the same array when nothing matches or nothing changes', () => {
        const t = [row('a')];
        expect(applySendPatch(t, 'zzz', { send_state: 'failed' })).toBe(t);
        expect(applySendPatch(t, 'a', { send_state: null })).toBe(t);
    });
});

describe('adoptServerCopy', () => {
    it('the server copy of our pending row takes over its id instead of duplicating', () => {
        const t = [row('x'), row('c1', { send_state: 'sending' })];
        const out = adoptServerCopy(t, { id: 'srv-1', content: { client_msg_id: 'c1' }, sender_user_id: 'u' })!;
        expect(out).toHaveLength(2);
        expect(out[1]).toMatchObject({ id: 'srv-1', sender_user_id: 'u' });
        expect('send_state' in out[1]).toBe(false);
    });

    it('also rescues a FAILED row the server actually received (the reply was lost, not the message)', () => {
        const out = adoptServerCopy([row('c1', { send_state: 'failed', send_error: 'No connection' })], { id: 'srv-1', content: { client_msg_id: 'c1' } })!;
        expect(out[0].id).toBe('srv-1');
        expect('send_error' in out[0]).toBe(false);
    });

    it('is null for rows that are not ours, already adopted, or carry no client id', () => {
        const t = [row('c1')];
        expect(adoptServerCopy(t, { id: 'srv-2', content: { client_msg_id: 'other' } })).toBeNull();
        expect(adoptServerCopy([{ ...row('c1'), id: 'srv-1' }], { id: 'srv-1', content: { client_msg_id: 'c1' } })).toBeNull();
        expect(adoptServerCopy(t, { id: 'srv-3', content: {} })).toBeNull();
    });

    it("takes the server's timestamp, replacing this device's compose time", () => {
        const out = adoptServerCopy([row('c1', { send_state: 'sending', timestamp: 'local-clock' })], { id: 'srv-1', content: { client_msg_id: 'c1' }, timestamp: '2026-10-07T12:00:00.000Z' })!;
        expect(out[0].timestamp).toBe('2026-10-07T12:00:00.000Z');
    });
});

describe('applySendPatch — the server timestamp (utils/messageOrder.ts)', () => {
    const ts = (s: number) => `2026-10-07T12:00:0${s}.000Z`;

    it('a confirmed DM row takes server_ts as its ordering key and time, and moves to its server position', () => {
        // b arrived (server time 3) while ours was still sending, so it sits
        // above our pending row — until the server says ours came first.
        const t = [
            row('a', { server_ts: ts(1) } as Partial<Row>),
            row('b', { server_ts: ts(3) } as Partial<Row>),
            row('mine', { send_state: 'sending' }),
        ] as (Row & { server_ts?: string })[];
        const out = applySendPatch(t, 'mine', { send_state: null, server_ts: ts(2) });
        expect(out.map(r => r.id)).toEqual(['a', 'mine', 'b']);
        expect(out[1]).toMatchObject({ server_ts: ts(2), timestamp: ts(2) });
        expect('send_state' in out[1]).toBe(false);
    });

    it('a supplied (clamped) display timestamp wins over server_ts for display, not for order', () => {
        const out = applySendPatch([row('m', { send_state: 'sending' })], 'm', { send_state: null, server_ts: ts(5), timestamp: ts(4) });
        expect(out[0]).toMatchObject({ server_ts: ts(5), timestamp: ts(4) });
    });

    it('without server_ts (an older API) the row is confirmed in place, exactly as before', () => {
        const t = [row('mine', { send_state: 'sending' }), row('b', { server_ts: ts(3) } as Partial<Row>)];
        const out = applySendPatch(t, 'mine', { send_state: null });
        expect(out.map(r => r.id)).toEqual(['mine', 'b']);
    });
});

describe('settleInterruptedSends', () => {
    it('a message still "sending" at load becomes failed (retryable), others untouched', () => {
        const map = { a: [row('1'), row('2', { send_state: 'sending' })], b: [row('3')] };
        const out = settleInterruptedSends(map);
        expect(out.a[1]).toMatchObject({ send_state: 'failed' });
        expect(out.a[0]).toBe(map.a[0]);
        expect(out.b).toBe(map.b);
    });
    it('returns the same map when nothing was mid-send', () => {
        const map = { a: [row('1', { send_state: 'failed' })] };
        expect(settleInterruptedSends(map)).toBe(map);
    });
});

describe('sendFailureReason / isUnconfirmedSend', () => {
    it('maps the common failures to a short reason', () => {
        expect(sendFailureReason(new Error('No channel key for epoch 3'))).toMatch(/key/);
        expect(sendFailureReason({ response: { status: 429 } })).toBe('Sending too fast');
        expect(sendFailureReason({ response: { status: 403 } })).toMatch(/permission/);
        expect(sendFailureReason({ response: { status: 502 } })).toBe('Server problem');
        expect(sendFailureReason(new Error('Network Error'))).toBe('No connection');
        expect(sendFailureReason(new Error('weird'))).toBe('Not delivered');
    });
    it('only sending/failed rows are unconfirmed', () => {
        expect(isUnconfirmedSend(row('a'))).toBe(false);
        expect(isUnconfirmedSend(row('a', { send_state: 'sending' }))).toBe(true);
        expect(isUnconfirmedSend(row('a', { send_state: 'failed' }))).toBe(true);
    });
});
