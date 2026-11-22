import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    AloneUpstream, ALONE_PAUSE_AFTER_MS, ALONE_RECHECK_MS, certainlyAlone, setSendersActive, pauseAudioUpstream, resumeAudioUpstream,
    type ActiveSenderLike, type UpstreamResumeReason, type UpstreamRoomLike,
} from './aloneUpstream';
import { setAlonePresenceProbe, subscribeAlonePresence, type AloneCounts } from './aloneLeave';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ALONE: AloneCounts = { hook: 0, live: 0, presence: null };

/** Deterministic timers + a controllable probe and fake media actions. */
function makeHarness(opts: { pause?: () => Promise<boolean> } = {}) {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let counts: AloneCounts | null | 'throw' = { ...ALONE };
    const calls: string[] = [];
    const resumed: UpstreamResumeReason[] = [];
    let senderActive = true;
    const c = new AloneUpstream({
        probe: () => { calls.push('probe'); if (counts === 'throw') throw new Error('room gone'); return counts; },
        schedule: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: (h) => { timers.delete(h as number); },
        now: () => now,
        pause: opts.pause ?? (async () => { calls.push('pause'); senderActive = false; return true; }),
        resume: async () => { calls.push('resume'); senderActive = true; },
        onPaused: () => { calls.push('onPaused'); },
        onResumed: (r) => { calls.push(`onResumed:${r}`); resumed.push(r); },
    });
    const advance = async (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].fn();
            await flush();
        }
        now = end;
        await flush();
    };
    return {
        c, advance, calls, resumed,
        set: (v: AloneCounts | null | 'throw') => { counts = v; },
        sending: () => senderActive,
    };
}

/** Alone from t=0 until paused. */
async function pausedHarness() {
    const h = makeHarness();
    h.c.check();
    await h.advance(ALONE_PAUSE_AFTER_MS);
    expect(h.c.paused).toBe(true);
    h.calls.length = 0;
    return h;
}

describe('certainlyAlone: every live source must say nobody, and the room must be readable', () => {
    it.each<[AloneCounts | null, boolean]>([
        [{ hook: 0, live: 0, presence: null }, true],     // DM / group call: no presence source
        [{ hook: 0, live: 0, presence: 0 }, true],
        [{ hook: 0, live: null, presence: 0 }, false],    // the room is unreadable: doubt
        [{ hook: 1, live: 0, presence: 0 }, false],       // a frozen hook still counts as someone (fail open)
        [{ hook: 0, live: 1, presence: 0 }, false],
        [{ hook: 0, live: 0, presence: 1 }, false],       // presence sees a joiner LiveKit does not yet
        [null, false],
    ])('%j -> %s', (c, want) => { expect(certainlyAlone(c)).toBe(want); });
});

describe('AloneUpstream: pausing needs 30 s of continuous certainty', () => {
    it('alone for ALONE_PAUSE_AFTER_MS pauses, not a millisecond earlier', async () => {
        const h = makeHarness();
        h.c.check();
        await h.advance(ALONE_PAUSE_AFTER_MS - 1);
        expect(h.c.paused).toBe(false);
        expect(h.calls).not.toContain('pause');
        await h.advance(1);
        expect(h.c.paused).toBe(true);
        expect(h.calls.filter(x => x === 'onPaused')).toHaveLength(1);
        expect(h.sending()).toBe(false);
    });

    it('the probe is re-read when the window ends: someone there by then = no pause', async () => {
        const h = makeHarness();
        h.c.check();
        await h.advance(ALONE_PAUSE_AFTER_MS - 5);
        h.set({ hook: 0, live: 1, presence: null }); // nobody called check() (a missed event)
        await h.advance(10);
        expect(h.c.paused).toBe(false);
        expect(h.sending()).toBe(true);
    });

    it('company in the middle of the window restarts it (positive control: same total time alone, no pause)', async () => {
        const h = makeHarness();
        h.c.check();
        await h.advance(20_000);
        h.set({ hook: 1, live: 1, presence: null }); h.c.check();
        await h.advance(1_000);
        h.set({ ...ALONE }); h.c.check();
        await h.advance(ALONE_PAUSE_AFTER_MS - 1);
        expect(h.c.paused).toBe(false);          // 20 s + 29.999 s alone, but not continuously
        await h.advance(1);
        expect(h.c.paused).toBe(true);
    });

    it('never pauses while the room is unreadable or a source disagrees', async () => {
        for (const v of [{ hook: 0, live: null, presence: null }, { hook: 1, live: 0, presence: null }, null, 'throw'] as const) {
            const h = makeHarness();
            h.set(v as AloneCounts | null | 'throw');
            h.c.check();
            await h.advance(10 * ALONE_PAUSE_AFTER_MS);
            expect(h.c.paused).toBe(false);
            expect(h.calls).not.toContain('pause');
        }
    });

    it('stays paused for hours alone (the "Never" auto-leave case) and keeps re-checking', async () => {
        const h = await pausedHarness();
        await h.advance(3 * 3600_000);
        expect(h.c.paused).toBe(true);
        expect(h.calls.filter(x => x === 'probe').length).toBeGreaterThanOrEqual(3 * 3600_000 / ALONE_RECHECK_MS - 1);
        expect(h.calls).not.toContain('resume');
    });
});

describe('AloneUpstream: resume is immediate and fail-open', () => {
    it('a participant connecting resumes at once, without waiting for any source to catch up', async () => {
        const h = await pausedHarness();
        // the hook / presence have not caught up yet: the probe still says alone
        h.c.joined();
        await flush();
        expect(h.c.paused).toBe(false);
        expect(h.resumed).toEqual(['join']);
        expect(h.calls.indexOf('resume')).toBeLessThan(h.calls.indexOf('onResumed:join'));
        expect(h.calls.filter(x => x === 'resume')).toHaveLength(1);
    });

    it('a presence join (server voice presence before LiveKit) resumes on check()', async () => {
        const h = await pausedHarness();
        h.set({ hook: 0, live: 0, presence: 1 });
        h.c.check();
        await flush();
        expect(h.resumed).toEqual(['join']);
    });

    it('a missed event is caught by the re-check within ALONE_RECHECK_MS', async () => {
        const h = await pausedHarness();
        h.set({ hook: 0, live: 1, presence: null });
        await h.advance(ALONE_RECHECK_MS);
        expect(h.resumed).toEqual(['join']);
    });

    it('doubt resumes: the room becomes unreadable, or the probe throws', async () => {
        for (const v of [{ hook: 0, live: null, presence: null }, 'throw'] as const) {
            const h = await pausedHarness();
            h.set(v as AloneCounts | 'throw');
            await h.advance(ALONE_RECHECK_MS);
            expect(h.resumed).toEqual(['uncertain']);
            expect(h.sending()).toBe(true);
        }
    });

    it('reconnect: hold(true) resumes and blocks pausing; hold(false) starts a fresh 30 s window', async () => {
        const h = await pausedHarness();
        h.c.hold(true);
        await flush();
        expect(h.resumed).toEqual(['reconnect']);
        await h.advance(5 * ALONE_PAUSE_AFTER_MS);
        expect(h.c.paused).toBe(false);
        h.c.hold(false);
        await h.advance(ALONE_PAUSE_AFTER_MS - 1);
        expect(h.c.paused).toBe(false);
        await h.advance(1);
        expect(h.c.paused).toBe(true);
    });

    it.each(['device', 'publish'] as const)('interrupt(%s) resumes and restarts the window', async (reason) => {
        const h = await pausedHarness();
        h.c.interrupt(reason);
        await flush();
        expect(h.resumed).toEqual([reason]);
        await h.advance(ALONE_PAUSE_AFTER_MS - 1);
        expect(h.c.paused).toBe(false);
        await h.advance(1);
        expect(h.c.paused).toBe(true);
    });

    it('interrupts while NOT paused resume nothing and log nothing (a publish at call start)', async () => {
        const h = makeHarness();
        h.c.check();
        h.c.interrupt('publish'); h.c.joined(); h.c.hold(true); h.c.hold(false);
        await flush();
        expect(h.calls).not.toContain('resume');
        expect(h.resumed).toEqual([]);
    });

    it('dispose (call left / remount into another portal) resumes and stops all timers', async () => {
        const h = await pausedHarness();
        h.c.dispose();
        await flush();
        expect(h.resumed).toEqual(['stop']);
        h.calls.length = 0;
        await h.advance(10 * ALONE_PAUSE_AFTER_MS);
        expect(h.calls).toEqual([]);
        h.c.check(); h.c.joined();
        await flush();
        expect(h.calls).toEqual([]);
    });

    it('a join that lands while the pause is still being applied ends sending (no stuck pause)', async () => {
        let release!: (v: boolean) => void;
        const h = makeHarness({ pause: () => new Promise<boolean>(r => { release = r; }) });
        h.c.check();
        await h.advance(ALONE_PAUSE_AFTER_MS);
        h.c.joined();                    // pause() has not resolved yet
        release(true);
        await flush();
        expect(h.c.paused).toBe(false);
        expect(h.resumed).toEqual(['join']);
    });

    it('a pause that fails (throws or reports nothing paused) leaves the call sending and tries again later', async () => {
        for (const pause of [async () => { throw new Error('setParameters'); }, async () => false]) {
            const spy = vi.fn(pause);
            const h = makeHarness({ pause: spy });
            h.c.check();
            await h.advance(ALONE_PAUSE_AFTER_MS);
            expect(h.c.paused).toBe(false);
            expect(h.calls).not.toContain('onPaused');
            await h.advance(ALONE_PAUSE_AFTER_MS);
            expect(spy).toHaveBeenCalledTimes(2);
        }
    });
});

// ── Senders ─────────────────────────────────────────────────────────────────

class FakeSender implements ActiveSenderLike {
    enc: RTCRtpEncodingParameters[];
    sets = 0;
    failNext = false;
    constructor(n = 1) { this.enc = Array.from({ length: n }, () => ({ maxBitrate: 64_000 })); }
    getParameters(): RTCRtpSendParameters {
        return { transactionId: 't', encodings: this.enc.map(e => ({ ...e })), headerExtensions: [], rtcp: {}, codecs: [] } as unknown as RTCRtpSendParameters;
    }
    async setParameters(p: RTCRtpSendParameters) {
        if (this.failNext) { this.failNext = false; throw new Error('InvalidStateError'); }
        this.sets++;
        this.enc = p.encodings.map(e => ({ ...e }));
    }
    get active() { return this.enc.map(e => e.active !== false); }
}

function fakeRoom(senders: (FakeSender | undefined)[]) {
    const mute = vi.fn(); const unmute = vi.fn();
    const mst = { enabled: true };
    const pubs = new Map(senders.map((s, i) => [`TR_${i}`, { isMuted: false, track: { sender: s, mute, unmute, mediaStreamTrack: mst } }]));
    return { room: { localParticipant: { audioTrackPublications: pubs } } as unknown as UpstreamRoomLike, mute, unmute, mst, pubs };
}

describe('the media actions: encodings inactive, nothing else touched', () => {
    it('pauses and resumes every audio sender (mic + share audio) and never touches mute / the track', async () => {
        const mic = new FakeSender(); const shareAudio = new FakeSender();
        const r = fakeRoom([mic, shareAudio]);
        expect(await pauseAudioUpstream(r.room)).toBe(true);
        expect(mic.active).toEqual([false]);
        expect(shareAudio.active).toEqual([false]);
        expect(mic.enc[0].maxBitrate).toBe(64_000);        // the rest of the encoding is kept
        await resumeAudioUpstream(r.room);
        expect(mic.active).toEqual([true]);
        expect(shareAudio.active).toEqual([true]);
        expect(r.mute).not.toHaveBeenCalled();
        expect(r.unmute).not.toHaveBeenCalled();
        expect(r.mst.enabled).toBe(true);
        expect([...r.pubs.values()].every(p => p.isMuted === false)).toBe(true);
    });

    it('a MUTED mic stays muted through pause and resume (the mute button is not upstream state)', async () => {
        const mic = new FakeSender();
        const r = fakeRoom([mic]);
        r.pubs.get('TR_0')!.isMuted = true; r.mst.enabled = false;
        await pauseAudioUpstream(r.room);
        await resumeAudioUpstream(r.room);
        expect(r.pubs.get('TR_0')!.isMuted).toBe(true);
        expect(r.mst.enabled).toBe(false);
        expect(r.mute).not.toHaveBeenCalled();
        expect(r.unmute).not.toHaveBeenCalled();
    });

    it('idempotent: an already-inactive sender is not set again', async () => {
        const s = new FakeSender();
        await setSendersActive([s], false);
        await setSendersActive([s], false);
        expect(s.sets).toBe(1);
        await setSendersActive([s], true);
        await setSendersActive([s], true);
        expect(s.sets).toBe(2);
    });

    it('a failure while pausing rolls the others back (never half-paused) and rejects', async () => {
        const a = new FakeSender(); const b = new FakeSender();
        b.failNext = true;
        const r = fakeRoom([a, b]);
        await expect(pauseAudioUpstream(r.room)).rejects.toThrow();
        expect(a.active).toEqual([true]);
        expect(b.active).toEqual([true]);
    });

    it('a sender with no encodings cannot be paused: report false and leave everything sending', async () => {
        const a = new FakeSender(); const b = new FakeSender(0);
        const r = fakeRoom([a, b]);
        expect(await pauseAudioUpstream(r.room)).toBe(false);
        expect(a.active).toEqual([true]);
    });

    it('nothing published: nothing to pause', async () => {
        expect(await pauseAudioUpstream(fakeRoom([undefined]).room)).toBe(false);
        expect(await pauseAudioUpstream(fakeRoom([]).room)).toBe(false);
    });

    it('resume keeps going past a failing sender and still reports the failure', async () => {
        const a = new FakeSender(); const b = new FakeSender();
        await setSendersActive([a, b], false);
        a.failNext = true;
        await expect(setSendersActive([a, b], true)).rejects.toThrow();
        expect(b.active).toEqual([true]);
    });
});

describe('presence changes notify (a joiner shows in server presence before LiveKit)', () => {
    it('registering a new presence probe calls subscribers; unsubscribe stops it', () => {
        const l = vi.fn();
        const off = subscribeAlonePresence(l);
        setAlonePresenceProbe(() => 1);
        setAlonePresenceProbe(null);
        expect(l).toHaveBeenCalledTimes(2);
        off();
        setAlonePresenceProbe(() => 0);
        expect(l).toHaveBeenCalledTimes(2);
        setAlonePresenceProbe(null);
    });
});

describe('wiring (SidebarConference)', () => {
    const sc = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    const block = sc.slice(sc.indexOf('const aloneUpstream = React.useMemo'), sc.indexOf('// The roster hook moved'));
    it('resumes on every listed event, reads the live room, logs label-only events', () => {
        expect(block).toMatch(/RoomEvent\.ParticipantConnected, onJoined/);
        expect(block).toMatch(/const onJoined = \(\) => c\.joined\(\)/);
        expect(block).toMatch(/RoomEvent\.LocalTrackSubscribed, onJoined/);
        expect(block).toMatch(/RoomEvent\.ConnectionStateChanged, onConnState/);
        expect(block).toMatch(/RoomEvent\.ActiveDeviceChanged, onDevice/);
        expect(block).toMatch(/RoomEvent\.LocalTrackPublished, onPublished/);
        expect(block).toMatch(/subscribeAlonePresence\(\(\) => c\.check\(\)\)/);
        expect(block).toMatch(/realRemoteCount\(r\.remoteParticipants\)/); // the Room's own roster, minus a phone's share-audio helper connection
        expect(block).toMatch(/readAlonePresence\(\)/);
        expect(block).toMatch(/logCallEvent\('upstream_paused', \{ reason: 'alone' \}\)/);
        expect(block).toMatch(/logCallEvent\('upstream_resumed', \{ reason \}\)/);
        expect(sc).toMatch(/aloneUpstream\?\.dispose\(\)/);
    });
    it('the silence watchdog is told about the pause, and the tray reads the local analyser while paused', () => {
        expect(sc).toMatch(/upstreamPaused: upstreamPausedRef\.current/);
        expect(sc).toMatch(/traySetCallSpeaking\?\.\(true, localSpeakingShown/);
    });
    it('video is left to dynacast: no pauseUpstream / video encodings are touched by the alone pause', () => {
        const lib = readFileSync(join(__dirname, 'aloneUpstream.ts'), 'utf8');
        expect(lib).not.toMatch(/\.pauseUpstream\(/);
        expect(lib).not.toMatch(/videoTrackPublications/);
        expect(sc).toMatch(/dynacast/i);
    });
});
