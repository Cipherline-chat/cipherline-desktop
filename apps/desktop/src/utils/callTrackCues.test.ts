import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    cameraCueForEvent, TrackCueController, CAMERA_REPUBLISH_WINDOW_MS, SHARE_STOP_DELAY_MS,
    type TrackCue, type CuePublication, type CueParticipant,
} from './callTrackCues';

// ── A fake call: participants with publications, a clock, timers ───────────
const CAMERA = 'camera';
const SHARE = 'screen_share';

function harness(opts: { ready?: boolean } = {}) {
    let now = 1_000_000;
    let ready = opts.ready ?? true;
    const played: TrackCue[] = [];
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextTimer = 1;
    const adjusting = new Set<string>();
    const c = new TrackCueController({
        isReady: () => ready,
        isAdjusting: id => adjusting.has(id),
        play: cue => played.push(cue),
        now: () => now,
        setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: t => { timers.delete(t as number); },
        sources: { camera: CAMERA, screenShare: SHARE },
    });
    const advance = (ms: number) => {
        now += ms;
        for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    };
    let sid = 0;
    const people = new Map<string, Map<string, CuePublication>>();
    const participant = (identity: string): CueParticipant => {
        if (!people.has(identity)) people.set(identity, new Map());
        return { identity, trackPublications: people.get(identity)! };
    };
    /** LiveKit adds the publication to the participant, then emits TrackPublished. */
    const publish = (identity: string, source: string, muted = false) => {
        const pub: CuePublication = { source, trackSid: `TR_${++sid}`, isMuted: muted };
        const p = participant(identity);
        (p.trackPublications as Map<string, CuePublication>).set(pub.trackSid!, pub);
        c.trackPublished(pub, p);
        return pub;
    };
    /** LiveKit removes the publication, then emits TrackUnpublished. */
    const unpublish = (identity: string, pub: CuePublication) => {
        const p = participant(identity);
        (p.trackPublications as Map<string, CuePublication>).delete(pub.trackSid!);
        c.trackUnpublished(pub, p);
    };
    return {
        c, played, advance, publish, unpublish, participant, adjusting,
        setReady: (r: boolean) => { ready = r; },
        leave: (identity: string) => { for (const pub of [...(people.get(identity)?.values() ?? [])]) unpublish(identity, pub); people.delete(identity); c.participantDisconnected({ identity }); },
    };
}

describe('TrackCueController — cues only for what a person actually did', () => {
    it('a genuine first camera-on plays camera_on; mute/unmute play off/on (positive controls)', () => {
        const h = harness();
        const cam = h.publish('ann', CAMERA);
        expect(h.played).toEqual(['camera_on']);
        cam.isMuted = true; h.c.trackMuted(cam);
        cam.isMuted = false; h.c.trackUnmuted(cam);
        expect(h.played).toEqual(['camera_on', 'camera_off', 'camera_on']);
    });

    it('H.265 negotiation / "Allow H.265" / layering republish (make-before-break) plays NOTHING — for the camera', () => {
        const h = harness();
        const old = h.publish('ann', CAMERA);
        h.played.length = 0;
        h.advance(60_000);
        const fresh = h.publish('ann', CAMERA); // new publication while the old is still up
        h.advance(1_500);
        h.unpublish('ann', old); // REPUBLISH_HOLD_MS later
        h.advance(10_000);
        expect(h.played).toEqual([]);
        // …and the republished camera still cues on a genuine later toggle.
        fresh.isMuted = true; h.c.trackMuted(fresh);
        fresh.isMuted = false; h.c.trackUnmuted(fresh);
        expect(h.played).toEqual(['camera_off', 'camera_on']);
    });

    it('the hardware-encoder fallback\'s break-before-make republish plays nothing', () => {
        const h = harness();
        const old = h.publish('ann', CAMERA);
        h.played.length = 0;
        h.unpublish('ann', old);
        h.advance(800);
        h.publish('ann', CAMERA);
        expect(h.played).toEqual([]);
    });

    it('a camera publish long after an unpublish is cued (outside the republish window)', () => {
        const h = harness();
        const old = h.publish('ann', CAMERA);
        h.played.length = 0;
        h.unpublish('ann', old);
        h.advance(CAMERA_REPUBLISH_WINDOW_MS + 1);
        h.publish('ann', CAMERA);
        expect(h.played).toEqual(['camera_on']);
    });

    it('a camera publication that arrives muted is not "on" (its unmute cues)', () => {
        const h = harness();
        const cam = h.publish('ann', CAMERA, true);
        expect(h.played).toEqual([]);
        cam.isMuted = false; h.c.trackUnmuted(cam);
        expect(h.played).toEqual(['camera_on']);
    });

    it('leaving and rejoining is not a republish: the rejoiner\'s camera-on is cued', () => {
        const h = harness();
        h.publish('ann', CAMERA);
        h.leave('ann');
        h.advance(1_000);
        h.played.length = 0;
        h.publish('ann', CAMERA);
        expect(h.played).toEqual(['camera_on']);
    });

    it('a genuine share start / stop plays screenshare_on / screenshare_off (positive controls)', () => {
        const h = harness();
        const s = h.publish('bob', SHARE);
        expect(h.played).toEqual(['screenshare_on']);
        h.unpublish('bob', s);
        expect(h.played).toEqual(['screenshare_on']); // delayed
        h.advance(SHARE_STOP_DELAY_MS);
        expect(h.played).toEqual(['screenshare_on', 'screenshare_off']);
    });

    it('a share codec swap (make-before-break) plays neither start nor stop', () => {
        const h = harness();
        const old = h.publish('bob', SHARE);
        h.played.length = 0;
        h.publish('bob', SHARE);
        h.advance(1_500);
        h.unpublish('bob', old);
        h.advance(1_000);
        expect(h.played).toEqual([]);
    });

    it('a swap whose unpublish and publish land in the same update plays nothing either', () => {
        const h = harness();
        const old = h.publish('bob', SHARE);
        h.played.length = 0;
        h.unpublish('bob', old);
        h.publish('bob', SHARE);
        h.advance(1_000);
        expect(h.played).toEqual([]);
    });

    it('a real stop, then a real new share a few seconds later, cue normally', () => {
        const h = harness();
        const s = h.publish('bob', SHARE);
        h.unpublish('bob', s);
        h.advance(3_000);
        h.publish('bob', SHARE);
        expect(h.played).toEqual(['screenshare_on', 'screenshare_off', 'screenshare_on']);
    });

    it('a sharer who leaves gets the leave cue, not screenshare_off', () => {
        const h = harness();
        h.publish('bob', SHARE);
        h.played.length = 0;
        h.leave('bob');
        h.advance(1_000);
        expect(h.played).toEqual([]);
    });

    it('Change Source / Adjust Quality (ss-adjust) stays silent', () => {
        const h = harness();
        const s = h.publish('bob', SHARE);
        h.played.length = 0;
        h.adjusting.add('bob');
        h.unpublish('bob', s);
        h.advance(100);
        h.publish('bob', SHARE);
        h.advance(1_000);
        expect(h.played).toEqual([]);
    });

    it('nothing before the ready gate opens (join storm / reconnect replay)', () => {
        const h = harness({ ready: false });
        const cam = h.publish('ann', CAMERA);
        h.publish('bob', SHARE);
        cam.isMuted = true; h.c.trackMuted(cam);
        expect(h.played).toEqual([]);
    });

    it('microphone and other sources never cue here', () => {
        const h = harness();
        const mic = h.publish('ann', 'microphone');
        mic.isMuted = true; h.c.trackMuted(mic);
        h.c.trackUnmuted(mic);
        expect(h.played).toEqual([]);
    });
});

describe('only publish / mute events can cue (subscribe, pause/resume, layers, focus cannot)', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p); } };
    walk(src);
    it('camera/share cue names are produced only by callTrackCues.ts', () => {
        const producers = files.filter(f => /playSound\(\s*'(camera_on|camera_off|screenshare_on|screenshare_off)'/.test(readFileSync(f, 'utf8')));
        expect(producers).toEqual([]);
        const cues = readFileSync(join(src, 'utils', 'callTrackCues.ts'), 'utf8');
        expect(cues).toMatch(/return 'camera_on'/);
    });
    it('CallPane feeds the controller from publish / unpublish / mute / unmute / disconnect only', () => {
        const pane = readFileSync(join(src, 'components', 'CallPane.tsx'), 'utf8');
        const a = pane.indexOf('const cues = new TrackCueController(');
        expect(a).toBeGreaterThan(-1);
        const effect = pane.slice(a, pane.indexOf('}, [room]);', a));
        for (const ev of ['TrackPublished', 'TrackUnpublished', 'LocalTrackPublished', 'LocalTrackUnpublished', 'TrackMuted', 'TrackUnmuted', 'ParticipantDisconnected']) {
            expect(effect).toMatch(new RegExp(`room\\.on\\(RoomEvent\\.${ev},`));
        }
        for (const ev of ['TrackSubscribed', 'TrackUnsubscribed', 'TrackStreamStateChanged', 'TrackSubscriptionStatusChanged']) {
            expect(effect).not.toMatch(new RegExp(`RoomEvent\\.${ev}\\b`));
        }
        expect(effect).toMatch(/play: cue => playSound\(cue, soundsPrefs\(\)\)/);
    });
});

describe('cameraCueForEvent', () => {
    it('maps a first-ever publish to camera_on when ready', () => {
        expect(cameraCueForEvent('published', true)).toBe('camera_on');
    });

    it('maps unmute to camera_on when ready', () => {
        expect(cameraCueForEvent('unmuted', true)).toBe('camera_on');
    });

    it('maps mute to camera_off when ready', () => {
        expect(cameraCueForEvent('muted', true)).toBe('camera_off');
    });

    it('suppresses every event type when not ready (join-storm / reconnect-resync gate)', () => {
        expect(cameraCueForEvent('published', false)).toBeNull();
        expect(cameraCueForEvent('unmuted', false)).toBeNull();
        expect(cameraCueForEvent('muted', false)).toBeNull();
    });

    it('never maps an unpublish event to a cue, ready or not — that path is participant-departure teardown, already covered by the leave cue', () => {
        // @ts-expect-error — 'unpublished' is deliberately not part of CameraTrackEvent;
        // verifying the runtime default branch is still safe if a caller widens the type.
        expect(cameraCueForEvent('unpublished', true)).toBeNull();
    });
});
