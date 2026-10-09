/**
 * Screen-share audio follows the watch decision (utils/screenShareAudioWatch.ts).
 *
 * Node-env suite (no DOM, no React renderer), so this is:
 *   - behavioural tests of the pure decisions and of the event-driven
 *     reconciler against a fake room that mimics LiveKit's subscription
 *     semantics (autoSubscribe => `isDesired` true until told otherwise),
 *   - an end-to-end decision scenario with a NEGATIVE CONTROL that replays the
 *     old rules and shows them playing an unwatched share's audio,
 *   - source pins for the React wiring a full render would exercise, each with
 *     a positive control proving the matcher can fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Track } from 'livekit-client';
import {
    attachShareAudioReconciler,
    reconcileShareAudioSubscriptions,
    shouldPlayShareAudio,
    wantsShareAudio,
    SHARE_AUDIO_RECONCILE_EVENTS,
    type ShareAudioParticipantLike,
    type ShareAudioRoomLike,
} from './screenShareAudioWatch';
import { collectFocusCandidates, pickNextFocus, isFocusableShare, PublishOrder, type ParticipantLike } from './pickNextFocus';

/** LiveKit RemoteTrackPublication subscription semantics, minus the network. */
class FakePub {
    /** `undefined` never happens in LiveKit: the constructor seeds it from autoSubscribe. */
    subscribed: boolean;
    calls: boolean[] = [];
    readonly source: Track.Source;
    constructor(source: Track.Source, autoSubscribe = true) {
        this.source = source;
        this.subscribed = autoSubscribe;
    }
    get isDesired() { return this.subscribed !== false; }
    setSubscribed(v: boolean) { this.subscribed = v; this.calls.push(v); }
}

class FakeParticipant implements ShareAudioParticipantLike {
    pubs = new Map<Track.Source, FakePub>();
    readonly identity: string;
    constructor(identity: string, sources: Track.Source[] = []) {
        this.identity = identity;
        for (const s of sources) this.pubs.set(s, new FakePub(s));
    }
    getTrackPublication(source: Track.Source) { return this.pubs.get(source); }
    /** The sharer (re)publishes a source: a NEW publication, autoSubscribed. */
    publish(source: Track.Source) { const p = new FakePub(source); this.pubs.set(source, p); return p; }
}

class FakeRoom implements ShareAudioRoomLike {
    remoteParticipants = new Map<string, FakeParticipant>();
    localParticipant = { identity: 'me' };
    private handlers = new Map<string, Set<() => void>>();
    on(ev: string, fn: () => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(fn); }
    off(ev: string, fn: () => void) { this.handlers.get(ev)?.delete(fn); }
    emit(ev: string) { this.handlers.get(ev)?.forEach(fn => fn()); }
    listenerCount() { let n = 0; this.handlers.forEach(s => { n += s.size; }); return n; }
    add(p: FakeParticipant) { this.remoteParticipants.set(p.identity, p); return p; }
}

const SSA = Track.Source.ScreenShareAudio;
const SS = Track.Source.ScreenShare;
const MIC = Track.Source.Microphone;
const CAM = Track.Source.Camera;

describe('decisions', () => {
    it('wantsShareAudio: only a remote sharer in the watch set', () => {
        expect(wantsShareAudio('alice', new Set(['alice']), 'me')).toBe(true);
        expect(wantsShareAudio('alice', new Set(), 'me')).toBe(false);
        expect(wantsShareAudio('alice', new Set(['bob']), 'me')).toBe(false);
        // your own share is never received back, even if it somehow got in the set
        expect(wantsShareAudio('me', new Set(['me']), 'me')).toBe(false);
    });

    it('shouldPlayShareAudio: a mounted share tile is NOT enough — it must be watched', () => {
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: true, watched: true })).toBe(true);
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: true, watched: false })).toBe(false);
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: false, watched: true })).toBe(false); // camera tile
        expect(shouldPlayShareAudio({ isLocal: true, isScreenShareTile: true, watched: true })).toBe(false);   // own share
    });
});

describe('reconcileShareAudioSubscriptions', () => {
    it('releases an autoSubscribed share-audio track nobody is watching; leaves a watched one', () => {
        const alice = new FakeParticipant('alice', [SSA, SS, MIC]);
        const bob = new FakeParticipant('bob', [SSA, SS, MIC]);
        const r = reconcileShareAudioSubscriptions([alice, bob], new Set(['bob']), 'me');
        expect(r).toEqual({ subscribed: [], unsubscribed: ['alice'] });
        expect(alice.pubs.get(SSA)!.isDesired).toBe(false);
        expect(bob.pubs.get(SSA)!.isDesired).toBe(true);
        expect(bob.pubs.get(SSA)!.calls).toEqual([]); // already right: nothing sent
    });

    it('re-requests a released track once the sharer is watched', () => {
        const alice = new FakeParticipant('alice', [SSA]);
        alice.pubs.get(SSA)!.subscribed = false;
        const r = reconcileShareAudioSubscriptions([alice], new Set(['alice']), 'me');
        expect(r.subscribed).toEqual(['alice']);
        expect(alice.pubs.get(SSA)!.calls).toEqual([true]);
    });

    it('never touches the microphone, the camera, or the share VIDEO', () => {
        const alice = new FakeParticipant('alice', [SSA, SS, MIC, CAM]);
        reconcileShareAudioSubscriptions([alice], new Set(), 'me');
        for (const s of [SS, MIC, CAM]) {
            expect(alice.pubs.get(s)!.calls, String(s)).toEqual([]);
            expect(alice.pubs.get(s)!.isDesired, String(s)).toBe(true);
        }
        // positive control: the share audio of the same participant WAS changed
        expect(alice.pubs.get(SSA)!.calls).toEqual([false]);
    });

    it('skips the local participant and participants with no share audio', () => {
        const me = new FakeParticipant('me', [SSA]);
        const quiet = new FakeParticipant('quiet', [SS]);
        expect(reconcileShareAudioSubscriptions([me, quiet], new Set(), 'me')).toEqual({ subscribed: [], unsubscribed: [] });
        expect(me.pubs.get(SSA)!.calls).toEqual([]);
    });

    it('is idempotent: a second pass sends nothing', () => {
        const alice = new FakeParticipant('alice', [SSA]);
        reconcileShareAudioSubscriptions([alice], new Set(), 'me');
        reconcileShareAudioSubscriptions([alice], new Set(), 'me');
        expect(alice.pubs.get(SSA)!.calls).toEqual([false]);
    });

    it('a throwing setSubscribed does not stop the pass for everyone else', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken = new FakeParticipant('broken', [SSA]);
        broken.pubs.get(SSA)!.setSubscribed = () => { throw new Error('gone'); };
        const alice = new FakeParticipant('alice', [SSA]);
        const r = reconcileShareAudioSubscriptions([broken, alice], new Set(), 'me');
        expect(r.unsubscribed).toEqual(['alice']);
        warn.mockRestore();
    });

    it('ignores a publication-shaped value without the LiveKit subscription API', () => {
        const odd: ShareAudioParticipantLike = { identity: 'odd', getTrackPublication: () => ({ isDesired: 'yes' }) };
        expect(reconcileShareAudioSubscriptions([odd], new Set(), 'me')).toEqual({ subscribed: [], unsubscribed: [] });
    });
});

describe('attachShareAudioReconciler — event-driven, not render-timed', () => {
    const setup = (watched: Set<string> = new Set()) => {
        const room = new FakeRoom();
        let w: ReadonlySet<string> = watched;
        const dispose = attachShareAudioReconciler(room, () => w);
        return { room, dispose, setWatched: (s: Set<string>) => { w = s; } };
    };

    it('listens to exactly the documented events', () => {
        const { room } = setup();
        expect(room.listenerCount()).toBe(SHARE_AUDIO_RECONCILE_EVENTS.length);
        expect([...SHARE_AUDIO_RECONCILE_EVENTS].sort()).toEqual(
            ['participantConnected', 'reconnected', 'trackPublished', 'trackSubscribed'],
        );
    });

    it('viewer joins mid-share: the existing autoSubscribed share audio is released on the first pass', () => {
        const room = new FakeRoom();
        const alice = room.add(new FakeParticipant('alice', [SS, SSA, MIC]));
        attachShareAudioReconciler(room, () => new Set());
        expect(alice.pubs.get(SSA)!.isDesired).toBe(false);
        expect(alice.pubs.get(MIC)!.isDesired).toBe(true);
    });

    it('sharer turns audio on mid-share (new publication): released for a non-watcher on trackPublished', () => {
        const { room } = setup();
        const alice = room.add(new FakeParticipant('alice', [SS]));
        const audio = alice.publish(SSA);
        expect(audio.isDesired).toBe(true); // autoSubscribe: the SFU is already sending it
        room.emit('trackPublished');
        expect(audio.isDesired).toBe(false);
    });

    it('sharer switches source (republish): a watcher keeps the new audio, a non-watcher does not get it', () => {
        const { room } = setup(new Set(['alice']));
        const alice = room.add(new FakeParticipant('alice', [SS, SSA]));
        const bob = room.add(new FakeParticipant('bob', [SS, SSA]));
        room.emit('participantConnected');
        const aliceNew = alice.publish(SSA);
        const bobNew = bob.publish(SSA);
        room.emit('trackPublished');
        expect(aliceNew.isDesired).toBe(true);
        expect(aliceNew.calls).toEqual([]);
        expect(bobNew.isDesired).toBe(false);
    });

    it('full reconnect rebuilds publications autoSubscribed: released again on trackSubscribed', () => {
        const { room } = setup();
        room.add(new FakeParticipant('alice', [SSA]));
        room.emit('trackSubscribed');
        // reconnect: brand-new participant object, brand-new autoSubscribed pubs
        const fresh = room.add(new FakeParticipant('alice', [SSA]));
        expect(fresh.pubs.get(SSA)!.isDesired).toBe(true);
        room.emit('trackSubscribed');
        expect(fresh.pubs.get(SSA)!.isDesired).toBe(false);
    });

    it('start watching -> subscribed; stop watching -> released (per sharer)', () => {
        const { room, setWatched } = setup();
        const alice = room.add(new FakeParticipant('alice', [SSA]));
        const bob = room.add(new FakeParticipant('bob', [SSA]));
        room.emit('participantConnected');
        expect([alice, bob].map(p => p.pubs.get(SSA)!.isDesired)).toEqual([false, false]);
        setWatched(new Set(['alice']));
        reconcileShareAudioSubscriptions(room.remoteParticipants.values(), new Set(['alice']), 'me'); // the hook's watch-set effect
        expect([alice, bob].map(p => p.pubs.get(SSA)!.isDesired)).toEqual([true, false]);
        setWatched(new Set());
        room.emit('trackSubscribed'); // any later event uses the CURRENT set
        expect(alice.pubs.get(SSA)!.isDesired).toBe(false);
    });

    it('the disposer removes every listener', () => {
        const { room, dispose } = setup();
        dispose();
        expect(room.listenerCount()).toBe(0);
        const alice = room.add(new FakeParticipant('alice', [SSA]));
        room.emit('trackPublished');
        expect(alice.pubs.get(SSA)!.isDesired).toBe(true); // nobody reconciled it
    });
});

describe('end to end: the stage moves onto a share the viewer never opened', () => {
    // Bob's camera is focused; Carol is sharing with audio and the viewer has
    // NOT clicked Watch. autoSubscribe means Carol's share has a live track.
    // Bob turns his camera off -> the focus banner auto-advances.
    const livePub = { isMuted: false, track: {} };
    const room = (bobCam: boolean): ParticipantLike[] => [
        { identity: 'bob', isLocal: false, getTrackPublication: s => (s === CAM && bobCam ? livePub : undefined) },
        { identity: 'carol', isLocal: false, getTrackPublication: s => (s === SS ? livePub : undefined) },
    ];
    const hidden = { video: new Set<string>(), screenShare: new Set<string>() };
    const watched = new Set<string>();

    it('NEGATIVE CONTROL — old rules: focus lands on Carol\'s share and its audio plays', () => {
        const o = new PublishOrder();
        collectFocusCandidates(room(true), o, hidden);
        const focus = pickNextFocus(collectFocusCandidates(room(false), o, hidden), { identity: 'bob', source: CAM });
        expect(focus).toMatchObject({ identity: 'carol', source: SS });
        // old VideoTile: `screenShareSubscribed: isScreenShare` — the banner
        // mounted a share tile, so the audio chain attached.
        const oldPlays = focus!.source === SS;
        expect(oldPlays).toBe(true);
        // ...and nothing released the audio: the old defensive unsubscribe
        // lived in ScreenShareGate, and Carol's gate is not mounted while her
        // share is on the focus stage.
        const carol = new FakeParticipant('carol', [SS, SSA]);
        expect(carol.pubs.get(SSA)!.isDesired).toBe(true);
    });

    it('new rules: focus does not move there, a forced focus is refused, nothing plays, nothing is received', () => {
        const o = new PublishOrder();
        collectFocusCandidates(room(true), o, hidden, watched);
        const focus = pickNextFocus(collectFocusCandidates(room(false), o, hidden, watched), { identity: 'bob', source: CAM });
        expect(focus).toBeNull();
        // A focus restored from elsewhere (Home/Friends parking) is unfocused by the banner...
        expect(isFocusableShare({ identity: 'carol', isLocal: false }, SS, watched)).toBe(false);
        // ...and even a mounted share tile would not play it.
        expect(shouldPlayShareAudio({ isLocal: false, isScreenShareTile: true, watched: watched.has('carol') })).toBe(false);
        const carol = new FakeParticipant('carol', [SS, SSA]);
        reconcileShareAudioSubscriptions([carol], watched, 'me');
        expect(carol.pubs.get(SSA)!.isDesired).toBe(false);
    });
});

describe('wiring (source pins)', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
    const tile = src('../components/call/VideoTile.tsx');
    const gate = src('../components/call/ScreenShareGate.tsx');
    const audio = src('../hooks/useParticipantAudio.ts');
    const hook = src('../hooks/useScreenShareAudioSubscriptions.ts');
    const sidebar = src('../components/SidebarConference.tsx');
    const banner = src('../components/call/FocusedStreamBanner.tsx');
    const ctx = src('../contexts/CallContext.tsx');

    it('VideoTile plays share audio only for a watched share (not "any mounted share tile")', () => {
        expect(tile).toMatch(/screenShareSubscribed: playShareAudio,/);
        expect(tile).toMatch(/shouldPlayShareAudio\(\{\s*isLocal,\s*isScreenShareTile: isScreenShare,\s*watched: callCtx\?\.watchedScreenShareIds\?\.has\(p\.identity\) \?\? false,\s*\}\)/);
        expect(tile).not.toMatch(/screenShareSubscribed: isScreenShare/);
        // positive control: the old line is exactly what the negative matcher catches
        expect('        screenShareSubscribed: isScreenShare,').toMatch(/screenShareSubscribed: isScreenShare/);
    });

    it('the gate never plays share audio, and its Watch click no longer subscribes the audio itself', () => {
        expect(gate).toMatch(/screenShareSubscribed: false,/);
        const watch = gate.slice(gate.indexOf('const handleWatch'), gate.indexOf('return (', gate.indexOf('const handleWatch')));
        expect(watch).toMatch(/Track\.Source\.ScreenShare\)/);
        expect(watch).not.toMatch(/Track\.Source\.ScreenShareAudio/);
        expect(watch).toMatch(/onSubscribed\(p\.identity\)/);
    });

    it('useParticipantAudio decides playback only — it never changes a subscription', () => {
        expect(audio).not.toMatch(/setSubscribed\(/);
        // positive control
        expect('if (pub?.isSubscribed) { try { pub.setSubscribed(false); } catch {} }').toMatch(/setSubscribed\(/);
        // and the share chain is still gated on the flag
        expect(audio).toMatch(/if \(!screenShareSubscribed\) return;/);
    });

    it('SidebarConference owns the subscription via the hook and mirrors the watch set into CallContext', () => {
        expect(sidebar).toMatch(/useScreenShareAudioSubscriptions\(room, subscribedScreenshares\);/);
        expect(sidebar).toMatch(/setWatchedScreenShareIdsCtx\?\.\(subscribedScreenshares\);/);
        expect(sidebar).toMatch(/\(\) => \(\) => \{ setWatchedScreenShareIdsCtx\?\.\(new Set\(\)\); \}/);
        // no other code path subscribes ScreenShareAudio any more (one owner)
        expect(sidebar).not.toMatch(/ssAudioPub\.setSubscribed\(true\)/);
        expect(gate).not.toMatch(/ssAudioPub/);
        // positive control
        expect('if (ssAudioPub && !ssAudioPub.isSubscribed) await ssAudioPub.setSubscribed(true);').toMatch(/ssAudioPub\.setSubscribed\(true\)/);
    });

    it('the hook is the reconciler on the live room, re-run on watch-set changes', () => {
        expect(hook).toMatch(/attachShareAudioReconciler\(room as unknown as ShareAudioRoomLike, \(\) => watchedRef\.current\)/);
        expect(hook).toMatch(/\}, \[room, watched\]\);/);
    });

    it('CallContext carries the watch set', () => {
        expect(ctx).toMatch(/watchedScreenShareIds: Set<string>;/);
        expect(ctx).toMatch(/setWatchedScreenShareIds: \(s: Set<string>\) => void;/);
        expect(ctx).toMatch(/watchedScreenShareIds,\s*setWatchedScreenShareIds,/);
    });

    it('the focus banner never advances onto, or keeps, an unwatched remote share', () => {
        expect(banner).toMatch(/collectFocusCandidates\([\s\S]{0,200}watchedShares,\s*\);/);
        expect(banner).toMatch(/if \(!isFocusableShare\([\s\S]{0,160}watchedShares\)\) \{\s*callCtx\.setFocusedStream\(null\);/);
    });
});
