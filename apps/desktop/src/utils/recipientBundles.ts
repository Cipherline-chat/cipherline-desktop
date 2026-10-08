/**
 * Recipient devices for a DM / group send, fetched BEFORE Enter is pressed.
 *
 * Every DM send needs `GET /conversations/:id/devices?claim_otp=1`: the
 * roster plus one freshly claimed one-time prekey per recipient device. That
 * prekey is what gives each message forward secrecy against a later compromise
 * of the recipient (the recipient deletes its private half after decrypting),
 * so it has to be a NEW claim per message — the roster cannot simply be cached
 * and reused. But nothing says the claim has to happen after Enter: it was a
 * whole network round trip on the critical path of every message.
 *
 * So the composer PRIMES a bundle as soon as the user starts typing, and the
 * send TAKES it. By the time Enter is pressed the round trip has usually
 * already finished, and delivery is encrypt + POST.
 *
 * Rules that keep this safe:
 *   • Single use. `take` removes the bundle before returning it, so two sends
 *     can never encrypt to the same one-time prekey.
 *   • Bounded age (`ttlMs`). A bundle older than that is dropped and a fresh
 *     one fetched. The roster can only be stale in the ADD direction inside
 *     that window — the server re-validates every recipient at send time and
 *     drops anyone no longer allowed to receive — and roster-changing events
 *     invalidate everything immediately anyway.
 *   • Bounded waste. A primed bundle that is never sent (an abandoned draft,
 *     an expired prime) spends one prekey per recipient device. Priming
 *     happens only on typing, at most once per TTL per conversation, so this
 *     is far inside the per-claimer budget (60 / device / hour, server-side)
 *     and the 30 / 10 s `prekeyClaim` route limit.
 *   • A failed prime is invisible: `take` just fetches fresh.
 */

export interface RecipientDevice {
    device_id: string;
    spk_pub_b64: string;
    [k: string]: unknown;
}

type Fetch = () => Promise<RecipientDevice[]>;

interface Entry {
    promise: Promise<RecipientDevice[]>;
    startedAt: number;
}

/** Long enough to cover composing a message, short enough to keep the roster fresh. */
export const RECIPIENT_BUNDLE_TTL_MS = 120_000;

export function createRecipientBundles(opts: { ttlMs?: number; now?: () => number } = {}) {
    const ttlMs = opts.ttlMs ?? RECIPIENT_BUNDLE_TTL_MS;
    const now = opts.now ?? (() => Date.now());
    const primed = new Map<string, Entry>();

    const fresh = (e: Entry | undefined): e is Entry => !!e && now() - e.startedAt < ttlMs;

    /** Start fetching a bundle for `key` unless a fresh one is already primed or in flight. */
    function prime(key: string, fetch: Fetch): void {
        if (fresh(primed.get(key))) return;
        let promise: Promise<RecipientDevice[]>;
        try { promise = fetch(); } catch { return; }
        const entry: Entry = { promise, startedAt: now() };
        primed.set(key, entry);
        // A failed prime is simply forgotten; the send fetches its own.
        promise.catch(() => { if (primed.get(key) === entry) primed.delete(key); });
    }

    /** The primed bundle (removed — single use), or a fresh fetch when there is none. */
    async function take(key: string, fetch: Fetch): Promise<RecipientDevice[]> {
        const entry = primed.get(key);
        primed.delete(key);
        if (fresh(entry)) {
            try {
                return await entry.promise;
            } catch {
                // fall through: the prime failed, fetch our own
            }
        }
        return fetch();
    }

    /** Forget primed bundles — one key, or all of them (a roster may have changed). */
    function invalidate(key?: string): void {
        if (key === undefined) primed.clear();
        else primed.delete(key);
    }

    function has(key: string): boolean {
        return fresh(primed.get(key));
    }

    return { prime, take, invalidate, has };
}

/** The app-wide instance. Keys are `${deviceId}:${conversationId}`, so two accounts never share one. */
export const recipientBundles = createRecipientBundles();

export const recipientBundleKey = (deviceId: string | null | undefined, conversationId: string): string =>
    `${deviceId ?? ''}:${conversationId}`;
