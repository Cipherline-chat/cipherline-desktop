import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { createDeliveryQueue, SEND_POST_TIMEOUT_MS } from './deliveryQueue';
import { sendFailureReason, adoptServerCopy, applySendPatch, type SendMarked } from './pendingSend';
import { wasDelivered, createSendClock } from './undeliveredSend';

// vitest.setup.ts stubs a bare `window`; axios reads window.location.href at import.
vi.hoisted(() => {
    (globalThis as unknown as { window: Record<string, unknown> }).window.location = { href: 'http://localhost/' };
});

/**
 * A POST that never answers must not hold the conversation's delivery lane:
 * with a timeout it fails (the red "!"), the next message goes out, and a
 * server copy that shows up later is adopted instead of duplicated.
 */

let server: http.Server | null = null;
const sockets = new Set<import('node:net').Socket>();
async function hangingServer(): Promise<string> {
    server = http.createServer(() => { /* never respond */ });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    server = null;
});

/** Two jobs on one lane; the first POSTs to the hanging server. Returns what happened. */
async function runTwoJobs(url: string, firstTimeoutMs: number | undefined, waitMs: number) {
    const q = createDeliveryQueue();
    const events: string[] = [];
    void q.enqueue('lane', {
        prepare: async () => 1,
        post: async () => { await axios.post(url, {}, { timeout: firstTimeoutMs }); },
        fail: (e) => { events.push(`fail1:${sendFailureReason(e)}`); },
    });
    void q.enqueue('lane', {
        prepare: async () => 2,
        post: async () => { events.push('post2'); },
        fail: () => { events.push('fail2'); },
    });
    await new Promise(r => setTimeout(r, waitMs));
    return events;
}

describe('send POST timeout', () => {
    it('is 20 s', () => {
        expect(SEND_POST_TIMEOUT_MS).toBe(20_000);
    });

    it('a hung POST times out -> the message fails ("Timed out") and the lane moves on', async () => {
        const url = await hangingServer();
        const events = await runTwoJobs(url, 150, 600);
        expect(events).toEqual(['fail1:Timed out', 'post2']);
    });

    it('CONTROL: without a timeout the same hung POST holds the lane (second message never goes out)', async () => {
        const url = await hangingServer();
        const events = await runTwoJobs(url, undefined, 600);
        expect(events).toEqual([]);
    });

    it('both ChatPane send POSTs pass the timeout (a regression here silently re-opens the stuck lane)', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
        const deliver = src.slice(src.indexOf('const enqueueDelivery = (job: DeliveryJob)'), src.indexOf('const handleSendAll = async'));
        expect(deliver.split('{ headers, timeout: SEND_POST_TIMEOUT_MS }').length - 1).toBe(2);
        expect(deliver).not.toContain('}, { headers })));');
    });
});

describe('timeout failure reason', () => {
    it('an axios timeout reads "Timed out"; a plain network error still reads "No connection" (control)', () => {
        expect(sendFailureReason(Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' }))).toBe('Timed out');
        expect(sendFailureReason(new Error('timeout of 20000ms exceeded'))).toBe('Timed out');
        expect(sendFailureReason(new Error('Network Error'))).toBe('No connection');
    });
});

describe('a timed-out attempt that landed anyway', () => {
    const row = (cid: string, state: 'sending' | 'failed'): SendMarked => ({ id: cid, content: { client_msg_id: cid }, send_state: state });

    it('the server copy arriving later clears the "!" and tells a queued Retry not to POST again', () => {
        const clock = createSendClock();
        let thread: SendMarked[] = [row('t1', 'sending')];
        thread = applySendPatch(thread, 't1', { send_state: 'failed', send_error: 'Timed out' });
        expect(clock.isUndelivered(thread[0])).toBe(true);
        expect(wasDelivered('t1')).toBe(false);
        // The WS echo / history fetch of the message the timed-out POST did deliver.
        const adopted = adoptServerCopy(thread, { id: 'srv-1', content: { client_msg_id: 't1' } })!;
        expect(adopted[0].send_state).toBeUndefined();
        expect(clock.isUndelivered(adopted[0])).toBe(false);
        expect(wasDelivered('t1')).toBe(true);
    });

    it('CONTROL: a server row that is not one of ours marks nothing delivered', () => {
        const thread: SendMarked[] = [row('t2', 'failed')];
        expect(adoptServerCopy(thread, { id: 'srv-2', content: { client_msg_id: 'someone-else' } })).toBeNull();
        expect(wasDelivered('t2')).toBe(false);
        expect(wasDelivered('someone-else')).toBe(false);
    });
});
