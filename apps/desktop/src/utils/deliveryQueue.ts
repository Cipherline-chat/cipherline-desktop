/**
 * Delivery of instantly-shown messages, per conversation, in send order —
 * pipelined.
 *
 * Each message has two steps: PREPARE (resolve recipients + encrypt — local
 * work plus, for a DM, the recipient-device read) and POST (hand it to the
 * server). Before this, one promise chain ran prepare→post for message 1,
 * then prepare→post for message 2, so every message waited for the ENTIRE
 * previous delivery and a quick burst queued up behind itself.
 *
 * Now a message's prepare starts the moment it is queued (overlapping the
 * previous message's POST), while POSTs stay strictly one at a time in queue
 * order: message N+1 is handed to the server only after message N's POST has
 * settled. That is what keeps the server's order — the order every client
 * sorts by (utils/messageOrder.ts) — equal to the order the user typed.
 *
 * The queue is module-level and keyed by conversation, not owned by a
 * ChatPane: the pane remounts on every conversation switch, and a per-pane
 * queue let a message sent after switching away and back race one still in
 * flight from the previous mount. Different conversations never wait on each
 * other.
 */

/**
 * How long one message-send POST may take before it is abandoned. Without a
 * limit a request that never answers holds this conversation's lane forever
 * (POSTs run strictly one at a time) and a Retry would queue behind it. On
 * timeout the job's `fail` runs, the message is marked failed (the red "!"),
 * and the lane moves on. The abandoned attempt may still have reached the
 * server; Retry reuses the same client_msg_id and the server's copy, when it
 * shows up, is adopted onto the local row (pendingSend.adoptServerCopy), which
 * clears the "!" — see utils/undeliveredSend.ts for the no-duplicate ledger.
 */
export const SEND_POST_TIMEOUT_MS = 20_000;

export interface DeliveryJob<P> {
    /** Recipients + encryption. Starts immediately; may run concurrently with earlier POSTs. */
    prepare: () => Promise<P>;
    /** The server hand-off. Runs only after every earlier POST for the same key has settled. */
    post: (prepared: P) => Promise<void>;
    /** Called once, with whatever prepare or post threw. Never rethrown. */
    fail: (err: unknown) => void;
}

type Prepared<P> = { ok: true; value: P } | { ok: false; error: unknown };

export function createDeliveryQueue() {
    const tails = new Map<string, Promise<void>>();

    function enqueue<P>(key: string, job: DeliveryJob<P>): Promise<void> {
        let prepared: Promise<Prepared<P>>;
        try {
            prepared = job.prepare().then(
                (value): Prepared<P> => ({ ok: true, value }),
                (error): Prepared<P> => ({ ok: false, error }),
            );
        } catch (error) {
            prepared = Promise.resolve({ ok: false, error });
        }
        const previous = tails.get(key) ?? Promise.resolve();
        const run = previous.then(async () => {
            const r = await prepared;
            if (!r.ok) { job.fail(r.error); return; }
            try {
                await job.post(r.value);
            } catch (err) {
                job.fail(err);
            }
        }).catch(() => undefined); // a throwing fail() must never break the chain
        tails.set(key, run);
        void run.then(() => { if (tails.get(key) === run) tails.delete(key); });
        return run;
    }

    /** Resolves once everything queued for `key` so far has been delivered (or failed). */
    function idle(key: string): Promise<void> {
        return tails.get(key) ?? Promise.resolve();
    }

    return { enqueue, idle };
}

/** The app-wide instance (survives ChatPane remounts). */
export const deliveryQueue = createDeliveryQueue();

const statusOf = (err: unknown): number | undefined =>
    (err as { response?: { status?: number } } | null)?.response?.status;

/** Seconds the server asked us to wait, if the header is readable. The throttler
 *  names it per bucket (`Retry-After-message`); a cross-origin response may hide
 *  it entirely, so absence is normal. */
function retryAfterMs(err: unknown): number | undefined {
    const h = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers ?? {};
    for (const name of ['retry-after-message', 'retry-after']) {
        const n = Number(h[name]);
        if (Number.isFinite(n) && n > 0) return n * 1000;
    }
    return undefined;
}

/**
 * Run `fn`; if the server answers 429 (the `message` bucket), wait out the
 * window and try again, up to `maxRetries` times. This RESPECTS the server's
 * limit — it never sends faster than the server allows — but it stops a burst
 * that briefly crossed it from landing on the user as "Not delivered".
 * Anything other than a 429 is thrown straight away.
 */
export async function withRateLimitRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries?: number; defaultWaitMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
    const maxRetries = opts.maxRetries ?? 2;
    // The `message` bucket is a fixed 3 s window, so 3 s always clears it.
    const defaultWaitMs = opts.defaultWaitMs ?? 3_000;
    const maxWaitMs = opts.maxWaitMs ?? 10_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (statusOf(err) !== 429 || attempt >= maxRetries) throw err;
            await sleep(Math.min(maxWaitMs, retryAfterMs(err) ?? defaultWaitMs));
        }
    }
}
