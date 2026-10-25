import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveKeyRequestsPass, type PendingKeyRequest, type ServePassDeps } from './keyServePass';
import { DeliveryLedger, HandshakeBackoff, SingleFlight, keyRequestVersion } from './keyDistributionThrottle';

/**
 * 2026-10-20 (owner: "someone joined and waited a while for the channel keys").
 * The member joined 6 s after another member LEFT. The leave rotated the
 * channels (new epochs minted by a few holders, then distributed to everyone
 * else at the pacer's 350 ms per POST), and the joiner's asks named those new
 * epochs. Every holder that had not received the new epoch YET answered the
 * ask with nothing and marked that request version answered — "nothing to look
 * at again until it is asked anew" — so seconds later, holding the epoch, it
 * still never looked again. Only the minter could answer; most channels took
 * 20-25 s, five took 90-323 s.
 *
 * Now a version stays answered only while the holder's newest held epoch for
 * the channel is unchanged; installing a newer one makes it look again.
 */

const req = (channel: string, epochs?: number[] | null): PendingKeyRequest => ({
    request_id: `r-${channel}`, channel_id: channel, requester_user_id: 'u', requester_device_id: 'jd',
    created_at: '2026-10-20T17:28:43.000Z', ...(epochs !== undefined ? { epochs } : {}),
});

function holder(pending: PendingKeyRequest[], initiallyHeld: number[], opts: { trackHeld: boolean }) {
    const sent: string[] = [];
    let held = [...initiallyHeld];
    const answeredOpen: Set<string>[] = [];
    const deps: ServePassDeps = {
        listPending: async () => pending,
        listHeldEpochs: async () => held,
        getMemberDevices: async () => [{ device_id: 'jd', spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
        refreshProtectedEpochs: async () => new Map(),
        distribute: async (_s, cid, epochs, recipients, _r, o) => {
            let posted = 0;
            for (const e of epochs) {
                if (deps.ledger.shouldSkip(cid, e, recipients[0].device_id, o?.requestVersion, o?.requestSeenAt)) continue;
                sent.push(`${cid}:${e}`);
                deps.ledger.record(cid, e, recipients[0].device_id, o?.requestVersion);
                posted++;
            }
            return { status: 'done', posted };
        },
        backoff: new HandshakeBackoff(),
        ledger: new DeliveryLedger(),
        flight: new SingleFlight(),
        scheduleResume: () => {},
        answered: new Set(),
        seenAt: new Map(),
        owed: new Map(),
        now: Date.now,
        ...(opts.trackHeld ? {
            answeredHeldMax: new Map<string, number>(),
            onAnsweredOpen: (c: Set<string>) => { answeredOpen.push(c); },
        } : {}),
    };
    return {
        deps, sent, answeredOpen,
        install: (e: number) => { held = [...held, e]; },
        serve: () => serveKeyRequestsPass(deps, 's'),
    };
}

describe('a holder that receives the asked-for epoch AFTER it first looked', () => {
    it('CONTROL — old behaviour: the precise ask for a just-rotated epoch is never answered by this holder', async () => {
        const h = holder([req('c', [22])], [20, 21], { trackHeld: false });
        await h.serve();
        expect(h.sent).toEqual([]);
        h.install(22); // the rotator's envelope reaches us
        await h.serve();
        expect(h.sent).toEqual([]); // still "answered" — the joiner waits for a re-ask
    });

    it('precise ask: answered as soon as this holder holds the epoch', async () => {
        const h = holder([req('c', [22])], [20, 21], { trackHeld: true });
        await h.serve();
        expect(h.sent).toEqual([]);
        expect(h.deps.answered.has(keyRequestVersion(req('c', [22])))).toBe(true);
        h.install(22);
        await h.serve();
        expect(h.sent).toEqual(['c:22']);
    });

    it('keyless ("everything") ask: what it already got is not re-sent; only the new epoch goes out', async () => {
        const h = holder([req('c', null)], [19, 20, 21], { trackHeld: true });
        await h.serve();
        expect(h.sent).toEqual(['c:21', 'c:20', 'c:19']);
        // Still open (its newest, 22, is not acked yet); we then get 22.
        h.install(22);
        await h.serve();
        expect(h.sent).toEqual(['c:21', 'c:20', 'c:19', 'c:22']);
    });

    it('an epoch installed BELOW the newest held (it minted 17 itself, 16 was still on its way) is served too', async () => {
        // 2026-10-23, double-rotation-then-join: two leaves, two rotations; the
        // holder minted 17 and only then received 16. Keyed on the newest
        // epoch held, the ask for 16 stayed "answered" here for good.
        const h = holder([req('c', [16])], [14, 15, 17], { trackHeld: true });
        await h.serve();
        expect(h.sent).toEqual([]);
        h.install(16);
        await h.serve();
        expect(h.sent).toEqual(['c:16']);
    });

    it('nothing new held → nothing re-evaluated, nothing sent (no churn for an orphan epoch nobody has)', async () => {
        const h = holder([req('c', [17])], [16, 18], { trackHeld: true });
        await h.serve();
        await h.serve();
        await h.serve();
        expect(h.sent).toEqual([]);
    });

    it('a newer epoch that the ask does not name sends nothing (orphan gap stays quiet)', async () => {
        const h = holder([req('c', [17])], [16, 18], { trackHeld: true });
        await h.serve();
        h.install(19);
        await h.serve();
        expect(h.sent).toEqual([]);
    });

    it('reports which channels have an open request it answered with what it held (the install trigger)', async () => {
        const h = holder([req('c', [22]), req('d', null)], [20, 21], { trackHeld: true });
        await h.serve();
        expect([...h.answeredOpen.at(-1)!].sort()).toEqual(['c', 'd']);
    });
});

describe('wiring (Dashboard)', () => {
    const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');

    it('the serve pass gets the held-max map and the answered-open callback', () => {
        expect(dash).toContain('answeredHeldMax: answeredHeldMaxRef.current');
        expect(dash).toMatch(/onAnsweredOpen: \(channelIds\) => \{ answeredOpenChannelsRef\.current\.set\(serverId, channelIds\); \}/);
    });

    it('a pull that installed a NEW key for such a channel schedules a serve pass', () => {
        const pull = dash.slice(dash.indexOf('const pullChannelKeysOnce = useCallback('), dash.indexOf('const [keyPullFlight]'));
        expect(pull).toContain("if (stored === 'stored') {");
        expect(pull).toContain('installedChannels.add(env.channel_id)');
        expect(pull).toMatch(/answeredOpenChannelsRef\.current\.get\(serverId\)[\s\S]*keyResumeTimers\.schedule\(`serve:\$\{serverId\}`, pickServeJitterMs\(\)/);
    });
});
