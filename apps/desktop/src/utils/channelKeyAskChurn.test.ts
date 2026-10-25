import { describe, it, expect } from 'vitest';
import { serveKeyRequestsPass, type PendingKeyRequest, type ServePassDeps } from './keyServePass';
import { DeliveryLedger, HandshakeBackoff, SingleFlight, type OwedServe } from './keyDistributionThrottle';
import { computeMissingEpochsForChannel, decideGapReask, type GapAsk } from './channelKeyDistribution';

/**
 * Key-ask churn (2026-10-19), simulated over a day.
 *
 * What the prod/staging data showed for one beta tester (busta, 1.0.23-staging):
 * 850 of 856 key requests in three days were filed while the device already
 * held the channel's NEWEST epoch — each one was the repair sweep's history-gap
 * ask for a single epoch that no online holder had (minted by a member who is
 * rarely online). The client was right that the epoch was missing; what made
 * it expensive was the protocol:
 *
 *   1. a request named only the channel, so every online holder answered it
 *      with EVERY epoch it held (20-40 envelopes) — all of which the device
 *      already had — and
 *   2. the request closed the moment the newest epoch was acked, so the gap
 *      survived only in the device's re-ask timer (5 min → 2 h, reset on every
 *      app start): every re-ask repeated (1), and the one holder who HAS the
 *      epoch was reached only if a re-ask happened to land while it was online.
 *
 * This runs the REAL holder pass (serveKeyRequestsPass with a real
 * DeliveryLedger / SingleFlight) and the REAL gap decision
 * (computeMissingEpochsForChannel + decideGapReask) against an in-memory model
 * of the API, old semantics vs new, and counts what crosses the wire.
 */

const HOUR = 3_600_000;
const TICK = 5 * 60_000;
const REQUESTER = 'busta-dev';
const REQUESTER_USER = 'busta';
const T0 = Date.parse('2026-10-18T22:40:00Z');

interface Scenario {
    /** Requester sends `epochs`, API stores/serves/fulfils them precisely. */
    precise: boolean;
    /** Holders honour `epochs` (false = every holder still on the old client). */
    holdersHonour: boolean;
    channels: number;
    gapChannels: number;
    epochs: number;
    orphan: number;
    onlineHolders: number;
    /** When the one holder that has the orphan epochs connects (null = never). */
    rareOnlineAt: number | null;
    /** Requester app starts (the repair sweep's back-off memory is per mount). */
    requesterRestarts: number[];
    /** Online holders reconnect (their answered / ledger state is per session). */
    holderRestarts: number[];
    hours: number;
}

interface Req { request_id: string; channel_id: string; created_at: string; epochs: number[] | null; open: boolean; newestAcked: boolean }

function simulate(sc: Scenario) {
    let now = T0;
    const channelIds = Array.from({ length: sc.channels }, (_, i) => `ch${String(i).padStart(2, '0')}`);
    const gapChannels = new Set(channelIds.slice(0, sc.gapChannels));
    const allEpochs = Array.from({ length: sc.epochs }, (_, i) => i + 1);
    const latest = sc.epochs;
    const serverEpochs = allEpochs.map(epoch => ({ epoch, fingerprint_b64: 'fp', created_at: new Date(T0 - 2 * 24 * HOUR).toISOString() }));

    // What each device holds.
    const requesterHeld = new Map<string, Set<number>>(channelIds.map(c => [c, new Set(allEpochs.filter(e => !(gapChannels.has(c) && e === sc.orphan)))]));
    const holderHeld = (rare: boolean, c: string) => allEpochs.filter(e => rare || !(gapChannels.has(c) && e === sc.orphan));

    // ── API model ──
    const requests = new Map<string, Req>();
    let reqSeq = 0;
    const unacked = new Map<string, { channel_id: string; epoch: number }>(); // per (channel, epoch) for the requester
    const counts = { asks: 0, envelopesPosted: 0, redundantInstalls: 0, orphanInstalledAt: null as number | null };

    // `precise` = the caller sent ?epochs=1. Without it, a precise request is
    // listed only until the newest epoch was acked since the last ask.
    const listPendingFor = (precise: boolean): PendingKeyRequest[] =>
        [...requests.values()].filter(r => r.open && (precise || r.epochs === null || !r.newestAcked)).map(r => ({
            request_id: r.request_id, channel_id: r.channel_id, requester_user_id: REQUESTER_USER,
            requester_device_id: REQUESTER, created_at: r.created_at,
            ...(sc.precise ? { epochs: r.epochs } : {}),
        }));

    const pullAndAck = () => {
        const acked: { channel_id: string; epoch: number }[] = [];
        for (const [k, env] of unacked) {
            const held = requesterHeld.get(env.channel_id)!;
            if (held.has(env.epoch)) counts.redundantInstalls += 1;
            held.add(env.epoch);
            if (gapChannels.has(env.channel_id) && env.epoch === sc.orphan && counts.orphanInstalledAt === null
                && [...gapChannels].every(c => requesterHeld.get(c)!.has(sc.orphan))) counts.orphanInstalledAt = now;
            acked.push(env);
            unacked.delete(k);
        }
        // ackKeys
        for (const r of requests.values()) {
            if (!r.open) continue;
            const mine = acked.filter(a => a.channel_id === r.channel_id).map(a => a.epoch);
            if (!mine.length) continue;
            if (r.epochs === null) {
                if (mine.some(e => e >= latest)) r.open = false;
            } else {
                r.epochs = r.epochs.filter(e => !mine.includes(e));
                if (!r.epochs.length) r.open = false;
                if (mine.some(e => e >= latest)) r.newestAcked = true;
            }
        }
    };

    // ── Holders, running the real serve pass ──
    interface Holder { id: string; rare: boolean; online: boolean; deps: ServePassDeps }
    const mkHolder = (id: string, rare: boolean, online: boolean): Holder => {
        const h: Holder = { id, rare, online, deps: undefined as unknown as ServePassDeps };
        const fresh = () => ({
            listPending: async () => {
                // A new holder sends ?epochs=1 and honours the list; an old one
                // sends neither and serves everything it holds.
                const list = listPendingFor(sc.holdersHonour);
                return sc.holdersHonour ? list : list.map(({ epochs: _ignored, ...rest }) => rest);
            },
            listHeldEpochs: async (cid: string) => holderHeld(h.rare, cid),
            getMemberDevices: async () => [{ device_id: REQUESTER, spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
            refreshProtectedEpochs: async () => new Map<string, number[]>(),
            distribute: async (_sid: string, cid: string, epochs: number[], recipients: { device_id: string }[], _reason: string, opts?: { requestVersion?: string; requestSeenAt?: number }) => {
                let posted = 0;
                for (const epoch of epochs) {
                    for (const r of recipients) {
                        if (h.deps.ledger.shouldSkip(cid, epoch, r.device_id, opts?.requestVersion, opts?.requestSeenAt)) continue;
                        h.deps.ledger.record(cid, epoch, r.device_id, opts?.requestVersion);
                        unacked.set(`${cid}:${epoch}`, { channel_id: cid, epoch });
                        counts.envelopesPosted += 1;
                        posted += 1;
                    }
                }
                pullAndAck(); // envelopes_ready → the requester pulls and acks
                return { status: 'done' as const, posted };
            },
            backoff: new HandshakeBackoff({ now: () => now }),
            ledger: new DeliveryLedger({ now: () => now }),
            flight: new SingleFlight(),
            scheduleResume: () => {},
            answered: new Set<string>(),
            seenAt: new Map<string, number>(),
            owed: new Map<string, OwedServe<PendingKeyRequest>>(),
            now: () => now,
        });
        h.deps = fresh();
        (h as Holder & { restart: () => void }).restart = () => { h.deps = fresh(); };
        return h;
    };
    const holders: Holder[] = [
        ...Array.from({ length: sc.onlineHolders }, (_, i) => mkHolder(`holder${i}`, false, true)),
        mkHolder('rare', true, false),
    ];
    // Holders race for each push; who lists first varies (seeded, so runs repeat).
    let seed = 0x9e3779b9;
    const rand = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return seed / 4294967296; };
    const serveAll = async () => {
        const order = holders.filter(h => h.online).map(h => ({ h, k: rand() })).sort((a, b) => a.k - b.k);
        for (const { h } of order) await serveKeyRequestsPass(h.deps, 'srv');
    };

    // ── The requester: createKeyRequest + the repair sweep's gap ask ──
    const fileKeyRequest = async (cid: string, epochs?: number[]) => {
        counts.asks += 1;
        const key = `${cid}:${REQUESTER}`;
        const wanted = sc.precise && epochs ? [...epochs] : null;
        const existing = [...requests.values()].find(r => r.open && `${r.channel_id}:${REQUESTER}` === key);
        const at = new Date(now).toISOString();
        if (existing) {
            existing.created_at = at;
            existing.newestAcked = false;
            existing.epochs = existing.epochs === null || wanted === null ? null : [...new Set([...existing.epochs, ...wanted])];
        } else {
            requests.set(`r${++reqSeq}`, { request_id: `r${reqSeq}`, channel_id: cid, created_at: at, epochs: wanted, open: true, newestAcked: false });
        }
        await serveAll(); // server:key_requested → every online holder runs a pass
    };
    let gapAsks = new Map<string, GapAsk>();
    const sweep = async () => {
        for (const cid of channelIds) {
            const held = [...requesterHeld.get(cid)!];
            const { missingEpochs } = computeMissingEpochsForChannel(serverEpochs, held, now);
            const gap = decideGapReask(missingEpochs, gapAsks.get(cid), now);
            if (gap.next) gapAsks.set(cid, gap.next); else gapAsks.delete(cid);
            if (gap.ask) await fileKeyRequest(cid, missingEpochs);
        }
    };

    return (async () => {
        const end = T0 + sc.hours * HOUR;
        const reqRestarts = new Set(sc.requesterRestarts.map(h => T0 + h * HOUR));
        const holdRestarts = new Set(sc.holderRestarts.map(h => T0 + h * HOUR));
        await sweep(); // app start
        for (now = T0 + TICK; now <= end; now += TICK) {
            if (sc.rareOnlineAt !== null && now === T0 + sc.rareOnlineAt * HOUR) {
                holders.find(h => h.rare)!.online = true;
                await serveKeyRequestsPass(holders.find(h => h.rare)!.deps, 'srv'); // its connect sweep
            }
            if (holdRestarts.has(now)) {
                for (const h of holders) if (h.online) { (h as Holder & { restart: () => void }).restart(); await serveKeyRequestsPass(h.deps, 'srv'); }
            }
            if (reqRestarts.has(now)) gapAsks = new Map(); // Dashboard remount: back-off memory is gone
            await sweep();
        }
        return counts;
    })();
}

// busta's shape: 23 channels, 8 of them each missing one epoch only a rarely
// online member holds, ~20 epochs per channel, a few holders online, a couple
// of app restarts a day.
const busta: Scenario = {
    precise: false, holdersHonour: false,
    channels: 23, gapChannels: 8, epochs: 20, orphan: 17,
    onlineHolders: 3, rareOnlineAt: null,
    requesterRestarts: [6, 14], holderRestarts: [9, 18],
    hours: 24,
};

describe('key-ask churn: a day of history-gap re-asks (busta\'s shape)', () => {
    it('REPRODUCES the old cost: every re-ask of an unanswerable gap re-sends every epoch the device already holds', async () => {
        const old = await simulate(busta);
        // 8 gap channels, back-off 5 min → 2 h, reset at 2 restarts: ~13 asks each.
        expect(old.asks).toBeGreaterThan(8 * 10);
        // Each ask: at least the first responder's 19 held epochs, all already held.
        expect(old.envelopesPosted).toBeGreaterThanOrEqual(old.asks * 19);
        expect(old.redundantInstalls).toBe(old.envelopesPosted);
        expect(old.orphanInstalledAt).toBeNull();
        console.log('[churn] OLD   asks=%d envelopes=%d redundant=%d', old.asks, old.envelopesPosted, old.redundantInstalls);
    });

    it('NEW: the same asks cost zero envelopes — holders send only the named epoch, and nobody online has it', async () => {
        const neu = await simulate({ ...busta, precise: true, holdersHonour: true });
        expect(neu.envelopesPosted).toBe(0);
        expect(neu.redundantInstalls).toBe(0);
        console.log('[churn] NEW   asks=%d envelopes=%d redundant=%d', neu.asks, neu.envelopesPosted, neu.redundantInstalls);
    });

    it('NEW: the holder who HAS the epoch answers on connect — the request is still open, no re-ask needed', async () => {
        // It connects 3 h 10 min in, between two of the requester's back-off asks.
        const at = 3 + 10 / 60;
        const neu = await simulate({ ...busta, precise: true, holdersHonour: true, rareOnlineAt: at });
        expect(neu.orphanInstalledAt).toBe(T0 + at * HOUR);
        // Exactly the 8 missing epochs, once.
        expect(neu.envelopesPosted).toBe(8);
        // OLD: the request had closed seconds after each ask, so the rare holder's
        // connect sweep finds nothing; the gap waits for a later re-ask — and
        // then only fills if the rare holder happens to answer FIRST (the
        // request closes on whoever's newest epoch is acked first).
        const old = await simulate({ ...busta, rareOnlineAt: at });
        expect(old.orphanInstalledAt === null || old.orphanInstalledAt > T0 + at * HOUR).toBe(true);
        console.log('[churn] rare holder connects at +%sh: NEW installs at +%sh, OLD at %s; envelopes NEW %d / OLD %d',
            at.toFixed(2), ((neu.orphanInstalledAt! - T0) / HOUR).toFixed(2),
            old.orphanInstalledAt === null ? 'not within the day' : `+${((old.orphanInstalledAt - T0) / HOUR).toFixed(2)}h`,
            neu.envelopesPosted, old.envelopesPosted);
    });

    it('MIXED (new requester + API, holders still on the old client): never more envelopes than OLD', async () => {
        const old = await simulate(busta);
        const mixed = await simulate({ ...busta, precise: true, holdersHonour: false });
        expect(mixed.envelopesPosted).toBeLessThanOrEqual(old.envelopesPosted);
        console.log('[churn] MIXED asks=%d envelopes=%d (old %d)', mixed.asks, mixed.envelopesPosted, old.envelopesPosted);
    });

    it('a channel with no gap is never asked about, old or new (the planner was not asking without need)', async () => {
        const quiet = await simulate({ ...busta, gapChannels: 0 });
        expect(quiet.asks).toBe(0);
    });
});
