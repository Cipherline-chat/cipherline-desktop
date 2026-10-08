import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDeliveryQueue } from './deliveryQueue';
import { createRecipientBundles } from './recipientBundles';

/**
 * A timing model of "Enter → the message is on the other person's screen",
 * driven through the REAL delivery queue and recipient-bundle code with fake
 * timers. The network is the only thing modelled; its numbers are parameters:
 *
 *   RTT   client ↔ API round trip (via Cloudflare). 100 ms is a typical
 *         home-broadband figure for the prod path; the conclusions hold for
 *         any RTT because every saving below is a whole round trip.
 *   S_*   server time per endpoint, medians measured with the real services
 *         against a scratch Postgres 16 + Redis 7 on the (loaded) dev box:
 *         devices+claim ≈ 7 ms; send ≈ 21 ms before the INSERT/notify change,
 *         ≈ 14 ms after. Pull is not measured; 3 ms is assumed.
 *   ENC   per-message encryption for a 2-device recipient set, incl. IPC ≈ 3 ms.
 *
 * Each step's arithmetic is asserted, so a change that quietly puts a round
 * trip back on the critical path fails here.
 */

const RTT = 100;
const S_DEVICES = 7;
const S_SEND_OLD = 21;
const S_SEND_NEW = 14;
const S_PULL = 3;
const ENC = 3;
const DECRYPT_PERSIST = 5;

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const request = (serverMs: number) => wait(RTT + serverMs);

/** Recipient side after the server commit: WS ping (½ RTT) → pull → decrypt+store → [ACK] → shown. */
async function recipientShows(ackGatesDisplay: boolean) {
    await wait(RTT / 2);
    await request(S_PULL);
    await wait(DECRYPT_PERSIST);
    if (ackGatesDisplay) await request(1);
}

afterEach(() => { vi.useRealTimers(); });

interface Result { sent: number[]; shown: number[] }

/** BEFORE: one chain per pane; each message does devices → encrypt → POST, serially. */
async function before(enterAt: number[]): Promise<Result> {
    const t0 = Date.now();
    const sent: number[] = [];
    const shown: number[] = [];
    let chain = Promise.resolve();
    const all: Promise<void>[] = [];
    for (const [i, at] of enterAt.entries()) {
        all.push(wait(at).then(() => {
            chain = chain.then(async () => {
                await request(S_DEVICES);           // GET devices?claim_otp=1
                await wait(ENC);
                await wait(RTT / 2 + S_SEND_OLD);    // POST reaches the server and commits
                const commit = Date.now();
                all.push(recipientShows(true).then(() => { shown[i] = Date.now() - t0 - at; }));
                await wait(RTT / 2);                 // response back to the sender
                sent[i] = commit - t0 - at;
            });
        }));
    }
    while (all.length) await all.shift();
    await chain;
    while (all.length) await all.shift();   // the recipients' side of the last messages
    return { sent, shown };
}

/** AFTER: recipients primed while typing; prepare overlaps the previous POST; POSTs in order. */
async function after(enterAt: number[], typingStartsAt: number[]): Promise<Result> {
    const t0 = Date.now();
    const q = createDeliveryQueue();
    const bundles = createRecipientBundles();
    const fetchDevices = () => request(S_DEVICES).then(() => [{ device_id: 'd', spk_pub_b64: 's' }]);
    const sent: number[] = [];
    const shown: number[] = [];
    const all: Promise<void>[] = [];
    for (const at of typingStartsAt) all.push(wait(at).then(() => bundles.prime('k', fetchDevices)));
    for (const [i, at] of enterAt.entries()) {
        all.push(wait(at).then(() => {
            void q.enqueue('k', {
                prepare: async () => { await bundles.take('k', fetchDevices); await wait(ENC); return i; },
                post: async () => {
                    await wait(RTT / 2 + S_SEND_NEW);
                    const commit = Date.now();
                    all.push(recipientShows(false).then(() => { shown[i] = Date.now() - t0 - at; }));
                    await wait(RTT / 2);
                    sent[i] = commit - t0 - at;
                },
                fail: () => {},
            });
        }));
    }
    while (all.length) await all.shift();
    await q.idle('k');
    while (all.length) await all.shift();   // the recipients' side of the last messages
    return { sent, shown };
}

async function runFake<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const p = fn();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    // Timers fire at their exact scheduled times inside each advance, so the
    // step size does not affect the measured numbers.
    for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(10);
    return p;
}

describe('delivery timing model (RTT 100 ms)', () => {
    it('one message, typed for 2 s: one round trip less to the server, two less to the screen', async () => {
        const b = await runFake(() => before([0]));
        const a = await runFake(() => after([2000], [0]));
        // committed on the server, measured from Enter
        expect(b.sent[0]).toBe(RTT + S_DEVICES + ENC + RTT / 2 + S_SEND_OLD);   // 181
        expect(a.sent[0]).toBe(ENC + RTT / 2 + S_SEND_NEW);                      //  67
        // on the recipient's screen, measured from Enter
        expect(b.shown[0]).toBe(b.sent[0] + RTT / 2 + RTT + S_PULL + DECRYPT_PERSIST + RTT + 1);   // 440
        expect(a.shown[0]).toBe(a.sent[0] + RTT / 2 + RTT + S_PULL + DECRYPT_PERSIST);               // 225
        console.log(`[timing] single message — server: ${b.sent[0]} → ${a.sent[0]} ms; recipient screen: ${b.shown[0]} → ${a.shown[0]} ms`);
    });

    it('a burst of 5 (Enter every 300 ms): every message is faster', async () => {
        const enters = [0, 300, 600, 900, 1200];
        const b = await runFake(() => before(enters));
        // typing for each message starts right after the previous Enter
        const a = await runFake(() => after(enters.map(e => e + 2000), [0, ...enters.slice(1).map(e => e + 2000 - 250)]));
        console.log(`[timing] burst of 5 — server commit after Enter: before ${b.sent.join('/')} ms, after ${a.sent.join('/')} ms`);
        console.log(`[timing] burst of 5 — recipient screen after Enter: before ${b.shown.join('/')} ms, after ${a.shown.join('/')} ms`);
        // every message in the burst is faster
        for (let i = 0; i < 5; i++) expect(a.sent[i]).toBeLessThan(b.sent[i]);
        expect(Math.max(...a.sent)).toBeLessThan(ENC + RTT / 2 + S_SEND_NEW + 1);
    });

    it('a burst faster than a round trip (Enter every 50 ms) stays in order and pipelines', async () => {
        const enters = [0, 50, 100, 150, 200];
        const b = await runFake(() => before(enters));
        const a = await runFake(() => after(enters.map(e => e + 2000), [0]));
        console.log(`[timing] 5 in 200 ms — server commit after Enter: before ${b.sent.join('/')} ms, after ${a.sent.join('/')} ms`);
        // before: each waits for every earlier delivery (2 round trips each)
        expect(b.sent[4]).toBeGreaterThan(4 * 2 * RTT);
        // after: only the in-order POSTs serialise (1 round trip each)
        expect(a.sent[4]).toBeLessThan(b.sent[4] / 2 + RTT);
        // and server commit order is still Enter order
        const commitAt = a.sent.map((s, i) => s + enters[i]);
        expect([...commitAt].sort((x, y) => x - y)).toEqual(commitAt);
    });
});
