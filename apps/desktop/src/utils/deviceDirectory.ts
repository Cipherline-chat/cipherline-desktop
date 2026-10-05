/**
 * Sender-attribution directory cache (F1 — sender-identity binding).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Nothing in the v:3 envelope cryptographically ties the claimed sender
 * user id (`su`) to the signing key (`sp`). The Ed25519 signature is verified
 * against `sp` READ OUT OF THE ENVELOPE ITSELF, so it only ever proves
 * self-consistency: "whoever signed this holds the private half of the key
 * they chose to name". It never proves `sp` belongs to `su`.
 *
 * That is not a fixable property of the signature. Adding `su`/`sd` to the
 * signed transcript changes nothing — they are already inside `ct`, which the
 * transcript covers. A forger simply signs the whole thing with their own key
 * and names whatever `su` they like. The missing half is ATTRIBUTION: some
 * source, independent of the envelope, that says which identity keys really
 * belong to `su`.
 *
 * There are exactly two such sources available to this client:
 *
 *   1. The server's published key directory (this module). Defeats every
 *      forger who cannot WRITE that directory — a malicious conversation
 *      member, an injected envelope, a compromised delivery path, a relay
 *      that can reorder/replay but not provision devices. It does NOT defeat
 *      a malicious server, which can simply publish a device it controls.
 *      What it buys against a malicious server is that the forgery must now
 *      be PERSISTENT and PUBLISHED: the fake device appears in the
 *      impersonated user's own device list and in every contact's safety
 *      number view, instead of being a one-shot invisible event.
 *
 *   2. Out-of-band verification (Safety Numbers) — `keyVerification.ts`.
 *      That is the only layer that binds against a malicious server, and it
 *      is what `isUnrecognizedForVerifiedContact` implements.
 *
 * `senderTrust.ts` combines both. This module supplies (1).
 *
 * ── Metadata discipline ─────────────────────────────────────────────────────
 * v:3 keeps the sender out of the envelope and out of the pull response, but
 * it is NOT sealed sender: the server records the sending device on every
 * envelope (`MessagesService.sendMessage`). What a recipient-side lookup would
 * add is the RECIPIENT's side of it — firing
 * `GET /keys/identity_keys?user_id=<sender>` the instant an envelope arrives
 * confirms to the server, from this device, that it was received and
 * decrypted and when. Don't add that signal.
 *
 * So the default population path is PASSIVE: `record()` is fed from directory
 * responses the client already makes for reasons the server already knows
 * about (`GET /conversations/:id/devices` on chat open and on send). No new
 * request, no new correlation.
 *
 * The one active fetch (`ensureUser`) is deliberately restricted by callers to
 * key-material paths (`call_key`, `channel_key`), where the distributor is
 * already known to the server because the server routed the handshake — so no
 * receipt signal is added there either. It is never called on the
 * plain message path.
 */

export type DirectoryStatus =
    /** No snapshot for this user — attribution is unknown, NOT a failure. */
    | 'unknown'
    /** This pub is published for this user (and for this device, if given). */
    | 'match'
    /** We have a snapshot for this user and this pub is not in it. */
    | 'mismatch';

interface UserSnapshot {
    /** device_id → identity pub (base64). */
    devices: Record<string, string>;
    fetchedAt: number;
}

/** In-memory only, by design: a directory snapshot is a cache of server state,
 *  never a trust anchor. Persisting it would create a second, staler pin store
 *  competing with `keyVerification.ts`, which IS the trust anchor. */
const snapshots = new Map<string, UserSnapshot>();

/** How long a snapshot is considered fresh enough to answer a key-material
 *  attribution query without re-fetching. Short: a legitimately-new device of
 *  a peer must become usable quickly, or adding a device breaks calling. */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** In-flight dedupe so a burst of envelopes from one sender makes one request. */
const inFlight = new Map<string, Promise<void>>();

export interface DirectoryEntry {
    user_id?: string | null;
    device_id?: string | null;
    /** `GET /conversations/:id/devices` spells it `identity_pub_b64`;
     *  `GET /keys/identity_keys` spells it `identity_key_pub_b64`. Both are
     *  accepted so call sites can pass raw responses through unchanged. */
    identity_pub_b64?: string | null;
    identity_key_pub_b64?: string | null;
}

/**
 * Fold a directory response into the cache.
 *
 * Merges per user rather than replacing, because `GET /conversations/:id/devices`
 * returns only the members of ONE conversation and deliberately omits the
 * caller's own current device — a replace would drop devices we legitimately
 * learned from another conversation and turn a 'match' into a 'mismatch'.
 * Attribution failures are load-bearing (they reject key material), so this
 * cache must never manufacture one.
 */
export function record(entries: DirectoryEntry[] | undefined | null): void {
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const e of entries) {
        const userId = e?.user_id;
        const deviceId = e?.device_id;
        const pub = e?.identity_pub_b64 ?? e?.identity_key_pub_b64;
        if (!userId || !deviceId || !pub) continue;
        const snap = snapshots.get(userId) ?? { devices: {}, fetchedAt: 0 };
        snap.devices[deviceId] = pub;
        snap.fetchedAt = now;
        snapshots.set(userId, snap);
    }
}

/**
 * Record a full, authoritative snapshot for one user, REPLACING what we hold.
 * Only `GET /keys/identity_keys?user_id=` is complete enough to justify this —
 * it returns every non-revoked device of that user. A replace is what makes a
 * revoked/forged device eventually disappear from the cache rather than
 * lingering as a permanent 'match'.
 */
export function recordFullUser(userId: string, entries: DirectoryEntry[] | undefined | null): void {
    if (!userId || !Array.isArray(entries)) return;
    const devices: Record<string, string> = {};
    for (const e of entries) {
        const deviceId = e?.device_id;
        const pub = e?.identity_pub_b64 ?? e?.identity_key_pub_b64;
        if (!deviceId || !pub) continue;
        devices[deviceId] = pub;
    }
    if (!Object.keys(devices).length) return;
    snapshots.set(userId, { devices, fetchedAt: Date.now() });
}

/**
 * Is `pub` a published identity key for `userId`?
 *
 * With a `deviceId` we have a snapshot entry for, this is the exact check:
 * the pub must be the one published for THAT device. Without it (or for a
 * device id we have never seen), the question degrades to "is this pub
 * published for any device of this user" — still the check that matters,
 * and critically it still works when a sender omits `sd`, which is the
 * v:3 omission path that otherwise bypasses every per-device check.
 *
 * Returns 'unknown' — never 'mismatch' — when we hold no snapshot at all.
 * Absence of evidence is not evidence; a caller that treated it as a failure
 * would reject every first-ever contact.
 */
export function status(userId: string, pub: string, deviceId?: string | null): DirectoryStatus {
    if (!userId || !pub) return 'unknown';
    const snap = snapshots.get(userId);
    if (!snap) return 'unknown';

    if (deviceId && snap.devices[deviceId]) {
        return snap.devices[deviceId] === pub ? 'match' : 'mismatch';
    }
    return Object.values(snap.devices).includes(pub) ? 'match' : 'mismatch';
}

/** True when a snapshot exists and is inside the TTL. */
export function isFresh(userId: string): boolean {
    const snap = snapshots.get(userId);
    return !!snap && Date.now() - snap.fetchedAt < SNAPSHOT_TTL_MS;
}

/**
 * Fetch and cache the full device directory for one user.
 *
 * Key-material paths ONLY — see the metadata note at the top of this
 * file. Never awaited on the plain message path.
 *
 * Failures are swallowed: a network error must leave attribution 'unknown'
 * (permissive) rather than 'mismatch' (rejecting). A server that wants to
 * suppress a call key can already just drop the envelope; making a failed
 * lookup reject would hand it a second, quieter way to do the same thing.
 *
 * The HTTP call is injected rather than imported. That is not ceremony: this
 * module is imported by pure trust-decision tests that run in vitest's `node`
 * environment, and `axios` dereferences `window.location` at import time and
 * throws there. Keeping the transport at the call site keeps the attribution
 * logic testable without a browser stub.
 */
export async function ensureUser(
    userId: string,
    fetchIdentityKeys: (userId: string) => Promise<DirectoryEntry[]>,
): Promise<void> {
    if (!userId) return;
    if (isFresh(userId)) return;

    const existing = inFlight.get(userId);
    if (existing) return existing;

    const p = (async () => {
        try {
            recordFullUser(userId, await fetchIdentityKeys(userId));
        } catch {
            /* leave 'unknown' — see the doc comment. */
        } finally {
            inFlight.delete(userId);
        }
    })();
    inFlight.set(userId, p);
    return p;
}

/**
 * Which response URLs carry directory data worth caching.
 *
 * Exported so the matching is unit-testable rather than buried in an
 * interceptor: getting it wrong fails OPEN (a cold cache reads 'unknown'), so
 * a silent drift here would quietly disarm attribution instead of breaking
 * anything visible.
 */
export function isDirectoryUrl(url: string | undefined): boolean {
    if (!url) return false;
    const path = url.split('?')[0];
    return path.endsWith('/devices')
        || path.endsWith('/recipient-devices')
        || path.endsWith('/identity_keys');
}

/** Minimal structural view of the axios instance — declared rather than
 *  imported so this module stays loadable in vitest's `node` environment,
 *  where importing axios throws on `window.location`. */
interface DirectoryResponse {
    config?: { url?: string };
    data?: unknown;
}

interface InterceptorHost {
    interceptors: {
        response: {
            /* eslint-disable-next-line @typescript-eslint/no-explicit-any --
               axios types `use` with its own response generic; `any` here is
               what makes this structural declaration assignable from the real
               AxiosStatic without importing it. The callback below is typed. */
            use(onFulfilled: (res: any) => any): number;
            eject(id: number): void;
        };
    };
}

/**
 * Notified after each captured directory response, with the rows as served and
 * the user id from the query string when the response was the authoritative
 * full-user form (`/keys/identity_keys?user_id=`), else null.
 *
 * Consumers: `directoryKeyWatch`, which compares the served keys against the
 * PIN store, and the ghost-device checks (`ownDeviceLedger` for the user's
 * own rows, `publishedDeviceSets` for contacts' complete sets). Kept as an injected observer rather than an import so
 * this module keeps its stated contract — it is a cache, and it makes no trust
 * decision — and so the detection policy stays unit-testable on its own.
 */
export type DirectoryObserver = (
    entries: DirectoryEntry[],
    fullUserId: string | null,
    /** The request URL. Lets an observer tell which listings are complete per
     *  user (`publishedDeviceSets`) from ones that are only a slice. */
    url?: string,
) => void;

/**
 * Populate the cache from every directory response the app already makes.
 *
 * This is deliberately ONE interception point rather than a `record()` call
 * added at each of the dozen `/devices` fetch sites in Dashboard/ChatPane.
 * A missed site does not fail loudly — it leaves attribution 'unknown', which
 * is the permissive answer — so per-site wiring would degrade silently as call
 * sites are added. Catching it centrally makes the property hold by default.
 *
 * Purely a cache warm. No trust decision is made here; that is `status()` and,
 * for key-change detection, `directoryKeyWatch` behind `observe`.
 * Returns an eject function for unmount.
 */
export function installDirectoryCapture(
    http: InterceptorHost,
    observe?: DirectoryObserver,
): () => void {
    const id = http.interceptors.response.use((res: DirectoryResponse) => {
        try {
            const url = res?.config?.url;
            if (isDirectoryUrl(url) && Array.isArray(res.data)) {
                // `/keys/identity_keys` rows carry no `user_id` — it is in the
                // query string, and the response is the COMPLETE device set for
                // that user, so it warrants the authoritative replace. Everything
                // else is conversation- or channel-scoped and must only merge.
                const uid = url!.includes('/identity_keys')
                    ? new URLSearchParams(url!.split('?')[1] ?? '').get('user_id')
                    : null;
                if (uid) recordFullUser(uid, res.data as DirectoryEntry[]);
                else record(res.data as DirectoryEntry[]);

                // Observed AFTER the cache update, in its own try/catch: an
                // observer that throws must not take out the cache warm (or
                // the response) with it.
                if (observe) {
                    try {
                        observe(res.data as DirectoryEntry[], uid, url);
                    } catch { /* an observer fault is never a response fault */ }
                }
            }
        } catch { /* never let cache bookkeeping break a response */ }
        return res;
    });
    return () => http.interceptors.response.eject(id);
}

/** Test seam / sign-out hygiene. */
export function _reset(): void {
    snapshots.clear();
    inFlight.clear();
}
