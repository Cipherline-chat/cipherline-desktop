import { describe, it, expect, beforeEach } from 'vitest';
import { getCallEvents, clearCallEvents } from './callEventLog';
import {
    formatDecodeCaps, parseDecodeCaps, roomHevcState, hevcCapableCount, HevcPolicy, shareWantsHevc, liveShareWantsHevc, remoteCapsAtTick, hevcSwitchReason, probeHevcDecode, probeHevcEncode,
    HEVC_ATTR, HEVC_JOIN_GRACE_MS, HEVC_UP_MS, HEVC_MIN_GAP_MS,
    HEVC_RETRY_MS, markHevcFailed, hasHevcFailed, markHevcGpuLost, effectiveHevcCaps, __resetHevcForTests,
} from './hevcNegotiation';

describe('capability advertisement format', () => {
    it('attribute key and values', () => {
        expect(HEVC_ATTR).toBe('cl.vdec');
        expect(formatDecodeCaps({ h265: true })).toBe('1:h265');
        expect(formatDecodeCaps({ h265: false })).toBe('1:');
    });
    it.each([
        ['1:h265', { h265: true }],
        ['1:', { h265: false }],
        ['1:av1,h265', { h265: true }],   // a future list still parses
        ['1:vp9', { h265: false }],
        ['2:h265', null],                  // unknown version → not capable
        ['h265', null],
        ['1:H265', null],                  // strict lower-case format
        ['', null],
        [undefined, null],
        [null, null],
        ['1:' + 'x'.repeat(80), null],    // oversize
    ] as const)('parseDecodeCaps(%j) → %j', (raw, want) => {
        expect(parseDecodeCaps(raw as string | undefined | null)).toEqual(want);
    });
    it('round-trips', () => {
        for (const h265 of [true, false]) expect(parseDecodeCaps(formatDecodeCaps({ h265 }))).toEqual({ h265 });
    });
});

describe('roomHevcState', () => {
    const cap = (joinedMsAgo = 60_000) => ({ attr: '1:h265', joinedMsAgo });
    const noCap = (joinedMsAgo = 60_000) => ({ attr: '1:', joinedMsAgo });
    const silent = (joinedMsAgo = 60_000) => ({ joinedMsAgo }); // mobile / older desktop: never advertises
    it('alone', () => expect(roomHevcState([])).toBe('alone'));
    it('all capable', () => expect(roomHevcState([cap(), cap()])).toBe('all'));
    it('one says it cannot', () => expect(roomHevcState([cap(), noCap()])).toBe('incapable'));
    it('one never advertised (Android app) → incapable after the grace', () => {
        expect(roomHevcState([cap(), silent(HEVC_JOIN_GRACE_MS - 1)])).toBe('pending');
        expect(roomHevcState([cap(), silent(HEVC_JOIN_GRACE_MS)])).toBe('incapable');
    });
    it('an explicit "cannot" is never pending', () => expect(roomHevcState([noCap(10)])).toBe('incapable'));
    it('counts', () => expect(hevcCapableCount([cap(), noCap(), silent()])).toEqual({ capable: 1, total: 3 }));
});

describe('HevcPolicy — negotiation with hysteresis', () => {
    it('all capable → H.265 only after HEVC_UP_MS of everyone qualifying', () => {
        const p = new HevcPolicy('base');
        expect(p.observe('all', true, 0)).toBeNull();
        expect(p.observe('all', true, HEVC_UP_MS - 1)).toBeNull();
        expect(p.observe('all', true, HEVC_UP_MS)).toBe('h265');
    });

    it('someone who cannot decode joins → back to base IMMEDIATELY (no hold, no min gap)', () => {
        const p = new HevcPolicy('base');
        p.observe('all', true, 0);
        expect(p.observe('all', true, HEVC_UP_MS)).toBe('h265');
        p.applied('h265', HEVC_UP_MS);
        expect(p.observe('incapable', true, HEVC_UP_MS + 1)).toBe('base');
    });

    it('they leave → H.265 again only after another HEVC_UP_MS (and the min gap)', () => {
        const p = new HevcPolicy('h265');
        p.applied('h265', 0);
        expect(p.observe('incapable', true, 1000)).toBe('base');
        p.applied('base', 1000);
        expect(p.observe('all', true, 2000)).toBeNull();                 // starts the clock
        expect(p.observe('all', true, 2000 + HEVC_UP_MS - 1)).toBeNull();
        expect(p.observe('all', true, 2000 + HEVC_UP_MS)).toBe('h265');
    });

    it('no oscillation: someone briefly joining and leaving inside the window restarts the clock', () => {
        const p = new HevcPolicy('base');
        p.observe('all', true, 0);
        p.observe('incapable', true, 10_000);   // joined
        p.observe('all', true, 12_000);         // left
        expect(p.observe('all', true, HEVC_UP_MS + 1)).toBeNull();
        expect(p.observe('all', true, 12_000 + HEVC_UP_MS)).toBe('h265');
    });

    it('a pending participant (attribute not arrived yet) neither switches down nor resets the clock', () => {
        const up = new HevcPolicy('h265');
        expect(up.observe('pending', true, 100)).toBeNull();
        const down = new HevcPolicy('base');
        down.observe('all', true, 0);
        down.observe('pending', true, 1000);
        expect(down.observe('all', true, HEVC_UP_MS)).toBe('h265');
    });

    it('the min gap bounds switching', () => {
        const p = new HevcPolicy('base');
        p.applied('base', 0);
        p.observe('all', true, 0);
        p.applied('h265', HEVC_UP_MS);
        p.applied('base', HEVC_UP_MS + 1);
        p.observe('all', true, HEVC_UP_MS + 2);
        expect(p.observe('all', true, HEVC_UP_MS + 1 + Math.min(HEVC_MIN_GAP_MS, HEVC_UP_MS) - 1)).toBeNull();
    });

    it('not allowed (setting off, no HW encoder, failed this session) → base, never H.265', () => {
        const p = new HevcPolicy('h265');
        expect(p.observe('all', false, 0)).toBe('base');
        p.applied('base', 0);
        expect(p.observe('all', false, 10 * HEVC_UP_MS)).toBeNull();
    });

    it('alone → base (nobody to save bandwidth for; avoids an immediate switch when an incapable joiner arrives)', () => {
        const p = new HevcPolicy('h265');
        expect(p.observe('alone', true, 0)).toBe('base');
    });
});

describe('probes', () => {
    const caps = (...mimes: string[]) => () => ({ codecs: mimes.map(mimeType => ({ mimeType })) });
    it('decode: needs H.265 in receiver capabilities AND decodingInfo supported', async () => {
        expect(await probeHevcDecode({ receiverCaps: caps('video/VP8', 'video/H265'), decodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(true);
        expect(await probeHevcDecode({ receiverCaps: caps('video/VP8'), decodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(false);
        expect(await probeHevcDecode({ receiverCaps: caps('video/H265'), decodingInfo: async () => ({ supported: false, powerEfficient: false }) })).toBe(false);
        expect(await probeHevcDecode({ receiverCaps: () => { throw new Error('x'); } })).toBe(false);
    });
    it('encode: needs H.265 in sender capabilities AND a power-efficient (hardware) encoder', async () => {
        expect(await probeHevcEncode({ senderCaps: caps('video/H265'), encodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(true);
        expect(await probeHevcEncode({ senderCaps: caps('video/H265'), encodingInfo: async () => ({ supported: true, powerEfficient: false }) })).toBe(false);
        expect(await probeHevcEncode({ senderCaps: caps('video/H264'), encodingInfo: async () => ({ supported: true, powerEfficient: true }) })).toBe(false);
        expect(await probeHevcEncode({ senderCaps: caps('video/H265') })).toBe(false); // no MediaCapabilities = unknown = no
    });
});

// Reports c344523e / 45a5e136 (1.0.24-staging.179): a resolution retune left the HW H.265
// sender on VP8, markHevcFailed() latched H.265 off for the whole app session - share and
// camera - "until restart". It now lifts after HEVC_RETRY_MS, on injected time.
describe('a failed H.265 is retried after 12 minutes', () => {
    const MIN = 60_000;
    beforeEach(() => { __resetHevcForTests(); clearCallEvents(); });

    it('the window is 12 minutes', () => { expect(HEVC_RETRY_MS).toBe(12 * MIN); });

    it('failed -> stays failed inside the window -> allowed again once it has passed', () => {
        expect(hasHevcFailed(0)).toBe(false);
        markHevcFailed(1_000);
        expect(hasHevcFailed(1_000)).toBe(true);
        expect(hasHevcFailed(1_000 + 12 * MIN - 1)).toBe(true);
        expect(hasHevcFailed(1_000 + 12 * MIN)).toBe(false);
        expect(hasHevcFailed(1_000 + 13 * MIN)).toBe(false);
    });

    it('a fresh failure re-arms the full window', () => {
        markHevcFailed(0);
        expect(hasHevcFailed(12 * MIN)).toBe(false);
        markHevcFailed(20 * MIN);
        expect(hasHevcFailed(20 * MIN + 11 * MIN)).toBe(true);
        expect(hasHevcFailed(20 * MIN + 12 * MIN)).toBe(false);
    });

    it('a second failure inside the window restarts it from the later failure', () => {
        markHevcFailed(0);
        markHevcFailed(10 * MIN);
        expect(hasHevcFailed(15 * MIN)).toBe(true);
        expect(hasHevcFailed(22 * MIN)).toBe(false);
    });

    it('expiry is logged once (h265_retry, seconds since the failure), not on every check', () => {
        markHevcFailed(0);
        hasHevcFailed(5 * MIN);
        expect(getCallEvents().filter(e => e.kind === 'h265_retry')).toHaveLength(0);
        hasHevcFailed(12 * MIN + 500);
        hasHevcFailed(13 * MIN);
        const ev = getCallEvents().filter(e => e.kind === 'h265_retry');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ after_s: 720 });
    });

    it('effectiveHevcCaps follows the expiry; a GPU loss is still permanent (negative control)', () => {
        markHevcFailed(Date.now() - 13 * MIN);
        expect(effectiveHevcCaps({ decode: true, encode: true }).encode).toBe(true);
        markHevcFailed();
        expect(effectiveHevcCaps({ decode: true, encode: true }).encode).toBe(false);
        markHevcGpuLost();
        expect(effectiveHevcCaps({ decode: true, encode: true })).toEqual({ decode: false, encode: false });
    });
});

// Report 923a0b23 ("Stream started out rough and then smoothed out", 1.0.24-staging.180)
// and dd3e84e3: every share began on H.264 and was republished as H.265 exactly 30 s
// (HEVC_UP_MS) after the room qualified - h265_caps capable=1/1 at -85.5 s, share
// start -64 s (H.264 High), h265_switch -51.8 s, then 5 s of 5 -> 88 fps while the
// new sender's bitrate ramped. The 30 s hysteresis keeps the CAMERA from flapping; a
// share that STARTS while everyone already qualifies has nothing to flap against.
describe('a share starts on H.265 as soon as the room qualifies (no 30 s wait, no second publish)', () => {
    it('the policy itself still waits 30 s before the camera moves (unchanged)', () => {
        const p = new HevcPolicy('base');
        expect(p.observe('all', true, 0)).toBeNull();
        expect(p.observe('all', true, 21_000)).toBeNull();
        expect(p.observe('all', true, HEVC_UP_MS)).toBe('h265');
    });

    it('21 s after everyone qualified (mode still base) a NEW share already wants H.265', () => {
        expect(shareWantsHevc('base', 'all', true)).toBe(true);
    });

    it('negative controls: a pending attribute, a blocked encoder or a peer who cannot decode do not', () => {
        expect(shareWantsHevc('base', 'pending', true)).toBe(false);
        expect(shareWantsHevc('base', 'all', false)).toBe(false);
        expect(shareWantsHevc('base', 'incapable', true)).toBe(false);
        expect(shareWantsHevc('base', 'alone', true)).toBe(false);
    });

    it('a share in H.265 mode keeps wanting it while an attribute is pending, and drops at once when someone cannot decode', () => {
        expect(shareWantsHevc('h265', 'all', true)).toBe(true);
        expect(shareWantsHevc('h265', 'pending', true)).toBe(true);
        expect(shareWantsHevc('h265', 'incapable', true)).toBe(false);
        expect(shareWantsHevc('h265', 'alone', true)).toBe(false);
        expect(shareWantsHevc('h265', 'all', false)).toBe(false);
    });
});

// Reports 566966f4 / c704ba3e: the only viewer left and rejoined 3.7 s later, which flipped
// a live share H.265 -> H.264 -> H.265, each flip republishing with a 2.5 s hold. This replays
// SidebarConference's 1 s tick on the real functions (the wiring test pins that the loop
// uses them), so the rule is checked across a whole visit, not one state at a time.
describe('a join during a live share', () => {
    type Peer = { sessionKey: string; attr?: string };
    /** Peers present at a time; returns when the share's codec changed. */
    function replay(opts: {
        start: boolean;
        mode: 'base' | 'h265';
        peersAt: (t: number) => Peer[];
        until: number;
        decide?: (isH265: boolean, mode: 'base' | 'h265', state: ReturnType<typeof roomHevcState>) => boolean;
    }) {
        const decide = opts.decide ?? ((isH265, _mode, state) => liveShareWantsHevc(isH265, state, true));
        const firstSeen = new Map<string, number>();
        const policy = new HevcPolicy(opts.mode);
        let h265 = opts.start;
        const flips: { at: number; h265: boolean }[] = [];
        for (let t = 0; t <= opts.until; t += 1000) {
            const state = roomHevcState(remoteCapsAtTick(firstSeen, opts.peersAt(t), t));
            const want = policy.observe(state, true, t);
            if (want) policy.applied(want, t);
            const next = decide(h265, policy.mode, state);
            if (next !== h265) { h265 = next; flips.push({ at: t, h265 }); }
        }
        return flips;
    }
    const viewer: Peer = { sessionKey: 'viewer', attr: '1:h265' };
    // The attribute lands inside the grace (reports: median 0.6 s, max 1.7 s after appearing).
    const capableJoin = (t: number): Peer[] => {
        if (t < 10_000) return [viewer];
        return [viewer, { sessionKey: 'joiner', attr: t >= 11_700 ? '1:h265' : undefined }];
    };
    // Report 566966f4: gone at -148.4, back at -144.7, capable by -144.
    const leavesAndRejoins = (t: number): Peer[] => {
        if (t < 10_000) return [{ sessionKey: 's1', attr: '1:h265' }];
        if (t < 14_000) return [];
        return [{ sessionKey: 's2', attr: t >= 15_000 ? '1:h265' : undefined }];
    };

    it('the only viewer leaving and rejoining causes no flip', () => {
        expect(replay({ start: true, mode: 'h265', peersAt: leavesAndRejoins, until: 60_000 })).toEqual([]);
    });

    it('negative control: asking shareWantsHevc about a live share flips down and back up, as in the reports', () => {
        const flips = replay({
            start: true, mode: 'h265', peersAt: leavesAndRejoins, until: 20_000,
            decide: (_isH265, mode, state) => shareWantsHevc(mode, state, true),
        });
        expect(flips).toEqual([{ at: 10_000, h265: false }, { at: 15_000, h265: true }]);
    });

    it('a capable viewer joining causes no flip, on either side of the camera timer', () => {
        expect(replay({ start: true, mode: 'base', peersAt: capableJoin, until: 60_000 })).toEqual([]);
        expect(replay({ start: true, mode: 'h265', peersAt: capableJoin, until: 60_000 })).toEqual([]);
    });

    it('negative control: the same join with the camera timer running flips under shareWantsHevc', () => {
        const flips = replay({
            start: true, mode: 'base', peersAt: capableJoin, until: 20_000,
            decide: (_isH265, mode, state) => shareWantsHevc(mode, state, true),
        });
        expect(flips).toEqual([{ at: 10_000, h265: false }, { at: 12_000, h265: true }]);
    });

    it('a viewer who says they cannot decode gets a decodable share on the next tick, not after the grace', () => {
        const peersAt = (t: number): Peer[] => (t < 10_000 ? [viewer] : [viewer, { sessionKey: 'joiner', attr: t >= 10_500 ? '1:' : undefined }]);
        expect(replay({ start: true, mode: 'h265', peersAt, until: 30_000 })).toEqual([{ at: 11_000, h265: false }]);
    });

    it('a viewer who never advertises (mobile) gets a decodable share when the grace ends, once', () => {
        const peersAt = (t: number): Peer[] => (t < 10_000 ? [viewer] : [viewer, { sessionKey: 'mobile' }]);
        expect(replay({ start: true, mode: 'h265', peersAt, until: 60_000 })).toEqual([{ at: 10_000 + HEVC_JOIN_GRACE_MS, h265: false }]);
    });

    it('someone who comes back as a new session between two ticks causes no flip', () => {
        // Same identity, new session: their attribute is gone for now.
        const inOneTick = (t: number): Peer[] => [{ sessionKey: t < 10_000 ? 's1' : 's2', attr: t < 10_000 || t >= 11_000 ? '1:h265' : undefined }];
        expect(replay({ start: true, mode: 'h265', peersAt: inOneTick, until: 60_000 })).toEqual([]);
    });

    it('negative control: timing the same return by identity reads them as unable to decode at once', () => {
        const byIdentity = (t: number): Peer[] => [{ sessionKey: 'same-user', attr: t < 10_000 || t >= 11_000 ? '1:h265' : undefined }];
        expect(replay({ start: true, mode: 'h265', peersAt: byIdentity, until: 10_000 })).toEqual([{ at: 10_000, h265: false }]);
    });

    it('liveShareWantsHevc: every state, on either codec', () => {
        for (const isH265 of [true, false]) {
            expect(liveShareWantsHevc(isH265, 'pending', true)).toBe(isH265);
            expect(liveShareWantsHevc(isH265, 'alone', true)).toBe(isH265);
            expect(liveShareWantsHevc(isH265, 'all', true)).toBe(true);
            expect(liveShareWantsHevc(isH265, 'incapable', true)).toBe(false);
            for (const s of ['pending', 'alone', 'all', 'incapable'] as const) expect(liveShareWantsHevc(isH265, s, false)).toBe(false);
        }
    });

    it('remoteCapsAtTick times each session and forgets the ones that left', () => {
        const seen = new Map<string, number>();
        expect(remoteCapsAtTick(seen, [{ sessionKey: 'a' }], 1000)).toEqual([{ attr: undefined, joinedMsAgo: 0 }]);
        expect(remoteCapsAtTick(seen, [{ sessionKey: 'a', attr: '1:' }], 4000)).toEqual([{ attr: '1:', joinedMsAgo: 3000 }]);
        expect(remoteCapsAtTick(seen, [{ sessionKey: 'b' }], 5000)).toEqual([{ attr: undefined, joinedMsAgo: 0 }]);
        expect([...seen.keys()]).toEqual(['b']);
    });
});

// Every reported move off H.265 in 21 days said "someone cannot decode H.265", and none
// was: two were an empty room, two the setting. The reason now names the real cause.
describe('hevcSwitchReason', () => {
    it.each([
        [true, '', 'all', 'everyone can decode H.265'],
        [false, 'setting_off', 'all', 'H.265 turned off in settings'],
        [false, 'no_hw_encode', 'all', 'no hardware H.265 encoder'],
        [false, 'gpu_lost', 'all', 'graphics driver reset'],
        [false, 'failed_earlier', 'all', 'H.265 failed'],
        [false, '', 'alone', 'nobody else in the call'],
        [false, '', 'incapable', 'someone cannot decode H.265'],
        // A block outranks the room: with the setting off, an empty room is not why.
        [false, 'setting_off', 'alone', 'H.265 turned off in settings'],
    ] as const)('toH265=%s blocked=%j state=%s -> %s', (toH265, blocked, state, want) => {
        expect(hevcSwitchReason(toH265, blocked, state)).toBe(want);
    });

    it('"someone cannot decode" only when someone in the room actually cannot', () => {
        for (const blocked of ['setting_off', 'no_hw_encode', 'gpu_lost', 'failed_earlier'] as const) {
            for (const state of ['all', 'incapable', 'pending', 'alone'] as const) {
                expect(hevcSwitchReason(false, blocked, state)).not.toBe('someone cannot decode H.265');
            }
        }
        expect(hevcSwitchReason(false, '', 'alone')).not.toBe('someone cannot decode H.265');
    });
});
