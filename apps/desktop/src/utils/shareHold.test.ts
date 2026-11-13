import { describe, expect, it, vi } from 'vitest';
import { RoomEvent, Track } from 'livekit-client';
import {
    HOLD_ARM_TIMEOUT_MS, HOLD_RESUME_TIMEOUT_MS, HOLD_TIMEOUT_MS, HOLD_TOTAL_CAP_MS, SHARE_REPUBLISH_ATTR,
    ShareHoldTracker, attachShareHoldToRoom, initialShareHoldState, sharePublications, stepShareHold,
    type ShareHoldDeps, type ShareHoldEvent, type ShareHoldRoom, type ShareHoldState,
} from './shareHold';
import { TrackCueController, type TrackCue } from './callTrackCues';
import { initialViewerCueState, reduceViewerCues } from './screenShareViewers';

const ID = 'publisher';

/** A manual clock: timers fire only when advanced. */
function fakeTime() {
    let t = 1_000_000;
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const started: number[] = [];
    const deps: Pick<ShareHoldDeps, 'now' | 'setTimer' | 'clearTimer'> = {
        now: () => t,
        setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); started.push(ms); return id; },
        clearTimer: id => { timers.delete(id as number); },
    };
    const advance = (ms: number) => {
        const end = t + ms;
        for (;;) {
            let due: [number, { at: number; fn: () => void }] | null = null;
            for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
            if (!due) break;
            timers.delete(due[0]);
            t = due[1].at;
            due[1].fn();
        }
        t = end;
    };
    return { deps, advance, started, pending: () => timers.size };
}

function tracker() {
    const time = fakeTime();
    const logged: Array<Record<string, unknown>> = [];
    const hold = new ShareHoldTracker({ ...time.deps, log: d => { logged.push(d as Record<string, unknown>); } });
    return { hold, time, logged };
}

/** Run a list of events from idle; returns the final state. */
const run = (events: ShareHoldEvent[], from: ShareHoldState = initialShareHoldState()): ShareHoldState =>
    events.reduce((s, ev) => stepShareHold(s, ev, 1000).state, from);

const signal = (seq = 'a'): ShareHoldEvent => ({ type: 'signal', seq, hasPublication: true });

describe('behaviour B: an unpublish with no signal is the stream ending, now', () => {
    it('a plain stop is gone on the same tick, and no timer was started', () => {
        const { hold, time, logged } = tracker();
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.phase(ID)).toBe('idle');
        expect(hold.heldIds().has(ID)).toBe(false);
        expect(time.started).toEqual([]);
        expect(time.pending()).toBe(0);
        expect(logged).toEqual([{ phase: 'gone', self: false, held: false }]);
    });

    it('positive control: the same unpublish after a signal DOES hold and DOES start a timer', () => {
        // Proves the assertions above can fail: this instrument sees a timer when there is one.
        const { hold, time } = tracker();
        hold.dispatch(ID, signal());
        expect(time.started).toEqual([HOLD_ARM_TIMEOUT_MS]);
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.phase(ID)).toBe('holding');
        expect(time.started).toEqual([HOLD_ARM_TIMEOUT_MS, HOLD_TIMEOUT_MS]);
        expect(time.pending()).toBe(1);
    });

    it('a viewer who gets the unpublish first does not hold when the signal follows', () => {
        // The ordering makes this unreachable in practice; if it ever happened the
        // stream has already closed and a late signal must not bring anything back.
        const { hold, time } = tracker();
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'signal', seq: 'a', hasPublication: false });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.started).toEqual([]);
    });

    it('a stop right after a republish is instant even if the flag has not been cleared yet', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'published' });
        hold.dispatch(ID, { type: 'first_frame' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
        hold.dispatch(ID, { type: 'unpublished' }); // the flag is still up: this token is spent
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
    });

    it('a stop while the new track has not painted yet is instant too', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'published' });
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
    });

    it('a stop after a flag that expired without an unpublish is instant', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal());
        time.advance(HOLD_ARM_TIMEOUT_MS);
        expect(hold.phase(ID)).toBe('idle');
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
    });

    it('the stale flag of an expired republish cannot arm again', () => {
        const s = run([signal('a'), { type: 'timeout', timerId: 1 }]);
        expect(s.phase).toBe('idle');
        expect(run([signal('a')], s).phase).toBe('idle');
        expect(run([signal('b')], s).phase).toBe('armed');
    });

    it('the publisher leaving ends a hold at once, in every phase', () => {
        for (const events of [[signal()], [signal(), { type: 'unpublished' } as const], [signal(), { type: 'unpublished' } as const, { type: 'published' } as const]]) {
            const { hold, time } = tracker();
            for (const ev of events) hold.dispatch(ID, ev);
            expect(hold.phase(ID)).not.toBe('idle');
            hold.left(ID);
            expect(hold.phase(ID)).toBe('idle');
            expect(hold.heldIds().size).toBe(0);
            expect(time.pending()).toBe(0);
        }
    });

    it('the publisher giving up (flag cleared, no new track) ends a hold at once', () => {
        const { hold, time, logged } = tracker();
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'signal_cleared' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
        expect(logged[logged.length - 1]).toMatchObject({ phase: 'end', end: 'cancelled' });
    });
});

describe('behaviour A: a republish keeps the viewer in place', () => {
    it('walks signal -> unpublish -> new track -> first frame, with the hold visible throughout', () => {
        const { hold, time, logged } = tracker();
        hold.dispatch(ID, signal());
        expect(hold.phase(ID)).toBe('armed');
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.phase(ID)).toBe('holding');
        expect(hold.heldIds().has(ID)).toBe(true);
        time.advance(3000);
        hold.dispatch(ID, { type: 'published' });
        expect(hold.phase(ID)).toBe('resuming');
        expect(hold.heldIds().has(ID)).toBe(true);
        time.advance(300);
        hold.dispatch(ID, { type: 'first_frame' });
        expect(hold.phase(ID)).toBe('idle');
        expect(hold.heldIds().has(ID)).toBe(false);
        expect(time.pending()).toBe(0);
        expect(logged.map(l => l.phase)).toEqual(['armed', 'start', 'new_track', 'end']);
        expect(logged[2]).toMatchObject({ ms: 3000 });
        expect(logged[3]).toMatchObject({ end: 'resumed', ms: 3300 });
    });

    it('clearing the flag in the normal way changes nothing while the new track arrives', () => {
        const s = run([signal(), { type: 'unpublished' }, { type: 'published' }, { type: 'signal_cleared' }]);
        expect(s.phase).toBe('resuming');
    });

    it('a new track during a hold keeps the identity held (focus and fullscreen stay) until it paints', () => {
        const { hold } = tracker();
        const seen: Array<boolean> = [];
        hold.subscribe(() => seen.push(hold.heldIds().has(ID)));
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'published' });
        hold.dispatch(ID, { type: 'first_frame' });
        expect(seen).toEqual([true, true, true, false]);
    });
});

describe('the hold is bounded', () => {
    it('a hold times out and closes like a normal end', () => {
        const { hold, time, logged } = tracker();
        const ended: string[] = [];
        hold.onEnded((_id, end) => ended.push(end));
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        time.advance(HOLD_TIMEOUT_MS - 1);
        expect(hold.phase(ID)).toBe('holding');
        time.advance(1);
        expect(hold.phase(ID)).toBe('idle');
        expect(hold.heldIds().size).toBe(0);
        expect(ended).toEqual(['timeout']);
        expect(logged[logged.length - 1]).toMatchObject({ phase: 'end', end: 'timeout', ms: HOLD_TIMEOUT_MS });
    });

    it('a new publication after the timeout is an ordinary new share', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        time.advance(HOLD_TIMEOUT_MS);
        hold.dispatch(ID, { type: 'published' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
    });

    it('a new track that never paints stops the placeholder without closing anything', () => {
        const { hold, time } = tracker();
        const ended: string[] = [];
        hold.onEnded((_id, end) => ended.push(end));
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'published' });
        time.advance(HOLD_RESUME_TIMEOUT_MS);
        expect(hold.phase(ID)).toBe('idle');
        expect(ended).toEqual(['resume_timeout']);
    });

    it('a run of changes cannot hold past the ceiling', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal('a'));
        hold.dispatch(ID, { type: 'unpublished' });
        let n = 0;
        // A new token every 2 s, forever: each one would restart a 6 s timer.
        while (hold.phase(ID) !== 'idle' && n < 100) {
            time.advance(2000);
            if (hold.phase(ID) === 'holding') hold.dispatch(ID, { type: 'signal', seq: `s${n++}`, hasPublication: false });
        }
        expect(hold.phase(ID)).toBe('idle');
        expect(n * 2000).toBeLessThanOrEqual(HOLD_TOTAL_CAP_MS);
    });
});

describe('rapid changes', () => {
    it('a stale timeout from an earlier change cannot close the stream that followed', () => {
        const s1 = run([signal('a'), { type: 'unpublished' }]);
        const staleId = s1.timerId;
        const s2 = run([{ type: 'published' }, signal('b'), { type: 'unpublished' }], s1);
        expect(s2.phase).toBe('holding');
        expect(stepShareHold(s2, { type: 'timeout', timerId: staleId }, 2000).state).toBe(s2);
        expect(stepShareHold(s2, { type: 'timeout', timerId: s2.timerId }, 2000).state.phase).toBe('idle');
    });

    it('tapping through resolutions: one unbroken hold, a fresh deadline each time, one frame taken', () => {
        const { hold, time } = tracker();
        const capture = vi.fn(() => true);
        hold.registerCapture(ID, capture);
        const phases: string[] = [];
        hold.subscribe(() => phases.push(hold.phase(ID)));
        for (const seq of ['a', 'b', 'c']) {
            hold.dispatch(ID, { type: 'signal', seq, hasPublication: true });
            hold.dispatch(ID, { type: 'unpublished' });
            time.advance(HOLD_TIMEOUT_MS - 1000); // past what the previous token's timer would have allowed
            expect(hold.phase(ID)).toBe('holding');
            hold.dispatch(ID, { type: 'published' });
            expect(hold.phase(ID)).toBe('resuming');
        }
        hold.dispatch(ID, { type: 'first_frame' });
        expect(hold.phase(ID)).toBe('idle');
        expect(capture).toHaveBeenCalledTimes(1);
        expect(phases.filter(p => p === 'idle')).toHaveLength(1); // never idle mid-run: no flicker
        expect(time.pending()).toBe(0);
    });

    it('a further change during the gap renews the deadline', () => {
        const { hold, time } = tracker();
        hold.dispatch(ID, signal('a'));
        hold.dispatch(ID, { type: 'unpublished' });
        time.advance(4000);
        hold.dispatch(ID, { type: 'signal', seq: 'b', hasPublication: false });
        time.advance(4000);
        expect(hold.phase(ID)).toBe('holding');
        time.advance(2000);
        expect(hold.phase(ID)).toBe('idle');
    });
});

describe('the last frame', () => {
    it('is taken once, at the signal, before the track goes', () => {
        const { hold } = tracker();
        const order: string[] = [];
        hold.registerCapture(ID, () => { order.push(`capture:${hold.phase(ID)}`); return true; });
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        expect(order).toEqual(['capture:armed']);
    });

    it('is never taken when no tile is showing the share (not watching)', () => {
        const { hold, logged } = tracker();
        hold.dispatch(ID, signal());
        expect(logged[0]).toMatchObject({ phase: 'armed', tiles: 0, frame: false });
    });

    it('is not taken by anything during normal playback or a plain stop', () => {
        const { hold } = tracker();
        const capture = vi.fn(() => true);
        hold.registerCapture(ID, capture);
        hold.dispatch(ID, { type: 'published' });
        hold.dispatch(ID, { type: 'first_frame' });
        hold.dispatch(ID, { type: 'unpublished' });
        expect(capture).not.toHaveBeenCalled();
    });

    it('a capture that throws is just the fallback', () => {
        const { hold, logged } = tracker();
        hold.registerCapture(ID, () => { throw new Error('no'); });
        hold.dispatch(ID, signal());
        expect(hold.phase(ID)).toBe('armed');
        expect(logged[0]).toMatchObject({ frame: false });
    });

    it('logs that a frame exists, never anything about it, and never who', () => {
        const { hold, logged } = tracker();
        hold.registerCapture(ID, () => true);
        hold.dispatch(ID, signal());
        hold.dispatch(ID, { type: 'unpublished' });
        hold.dispatch(ID, { type: 'published' });
        hold.dispatch(ID, { type: 'first_frame' });
        const text = JSON.stringify(logged);
        expect(text).not.toContain(ID);
        for (const l of logged) {
            for (const v of Object.values(l)) expect(['string', 'number', 'boolean']).toContain(typeof v);
        }
    });
});

describe('heldIds is a stable store snapshot', () => {
    it('keeps its identity until the membership changes', () => {
        const { hold } = tracker();
        const empty = hold.heldIds();
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.heldIds()).toBe(empty);
        hold.dispatch(ID, signal());
        const armed = hold.heldIds();
        expect(armed).not.toBe(empty);
        hold.dispatch(ID, { type: 'unpublished' });
        expect(hold.heldIds()).toBe(armed);
    });
});

// ── The room wiring, with LiveKit's real event order ────────────────────────

class FakeRoom implements ShareHoldRoom {
    localParticipant = { identity: 'me' };
    private map = new Map<string, Set<(...args: never[]) => void>>();
    on(event: string, fn: (...args: never[]) => void) {
        if (!this.map.has(event)) this.map.set(event, new Set());
        this.map.get(event)!.add(fn);
    }
    off(event: string, fn: (...args: never[]) => void) { this.map.get(event)?.delete(fn); }
    emit(event: string, ...args: unknown[]) { for (const fn of this.map.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args); }
    listeners(event: string) { return this.map.get(event)?.size ?? 0; }
}

const makeParticipant = () => {
    const pubs = new Map<string, { source: Track.Source; trackSid: string }>();
    return {
        identity: ID,
        attributes: {} as Record<string, string>,
        trackPublications: pubs,
        getTrackPublication: (source: unknown) => [...pubs.values()].find(p => p.source === source),
    };
};

/** What RemoteParticipant.updateInfo does: attributes first, then track reconciliation, all synchronously. */
function applyUpdate(room: FakeRoom, p: ReturnType<typeof makeParticipant>, update: { attr?: string; addTrack?: string; removeTrack?: string }) {
    if (update.attr !== undefined) {
        if (update.attr) p.attributes[SHARE_REPUBLISH_ATTR] = update.attr;
        else delete p.attributes[SHARE_REPUBLISH_ATTR];
        room.emit(RoomEvent.ParticipantAttributesChanged, { [SHARE_REPUBLISH_ATTR]: update.attr }, p);
    }
    let added: { source: Track.Source; trackSid: string } | undefined;
    if (update.addTrack) {
        added = { source: Track.Source.ScreenShare, trackSid: update.addTrack };
        p.trackPublications.set(update.addTrack, added);
    }
    if (update.removeTrack) {
        const pub = p.trackPublications.get(update.removeTrack);
        p.trackPublications.delete(update.removeTrack);
        room.emit(RoomEvent.TrackUnpublished, pub, p);
    }
    if (added) room.emit(RoomEvent.TrackPublished, added, p);
}

describe('attachShareHoldToRoom', () => {
    it('the attribute and the unpublish in ONE update still hold, and the frame was taken first', () => {
        const { hold } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        const frameTakenWhilePublished: boolean[] = [];
        hold.registerCapture(ID, () => { frameTakenWhilePublished.push(!!p.getTrackPublication(Track.Source.ScreenShare)); return true; });
        applyUpdate(room, p, { attr: 'a', removeTrack: 'TR_old' });
        expect(hold.phase(ID)).toBe('holding');
        expect(frameTakenWhilePublished).toEqual([true]);
    });

    it('a flag cleared in the same update that brings the new track resumes, it does not cancel', async () => {
        const { hold } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        applyUpdate(room, p, { attr: '', addTrack: 'TR_new' }); // attributes apply first: the clear is seen before the track
        await Promise.resolve();
        expect(hold.phase(ID)).toBe('resuming');
    });

    it('positive control: a clear with no new track does cancel', async () => {
        const { hold } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        applyUpdate(room, p, { attr: '' });
        expect(hold.phase(ID)).toBe('holding'); // judged a microtask later
        await Promise.resolve();
        expect(hold.phase(ID)).toBe('idle');
    });

    it('a plain unpublish on the room is gone on the same tick with no timer', () => {
        const { hold, time } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        expect(hold.phase(ID)).toBe('idle');
        expect(time.started).toEqual([]);
    });

    it('ignores other attributes and other sources', () => {
        const { hold, time } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        room.emit(RoomEvent.ParticipantAttributesChanged, { 'cl.vdec': 'h265' }, p);
        room.emit(RoomEvent.TrackUnpublished, { source: Track.Source.Camera, trackSid: 'x' }, p);
        expect(hold.phase(ID)).toBe('idle');
        expect(time.started).toEqual([]);
    });

    it('the old half of an unannounced codec swap is not an unpublish', () => {
        const { hold } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { addTrack: 'TR_new' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        expect(hold.phase(ID)).toBe('idle');
    });

    it('an announced codec swap holds from the flag until the new track paints', () => {
        const { hold } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { addTrack: 'TR_new' });
        applyUpdate(room, p, { attr: 'a' });
        expect(hold.phase(ID)).toBe('armed');
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        // Nothing to wait for but the frame: the new publication has been here all along.
        expect(hold.phase(ID)).toBe('resuming');
        hold.dispatch(ID, { type: 'first_frame' });
        expect(hold.phase(ID)).toBe('idle');
    });

    it('sharePublications finds both halves of a swap, and only screen shares', () => {
        const pubs = [{ source: Track.Source.ScreenShare }, { source: Track.Source.ScreenShareAudio }, { source: Track.Source.ScreenShare }];
        expect(sharePublications({ trackPublications: new Map(pubs.map((x, i) => [String(i), x])) })).toEqual([pubs[0], pubs[2]]);
        expect(sharePublications({})).toEqual([]);
    });

    it('a participant leaving ends the hold; LiveKit unpublishes first, in the same tick', () => {
        const { hold, time } = tracker();
        const room = new FakeRoom();
        attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        room.emit(RoomEvent.ParticipantDisconnected, p);
        expect(hold.phase(ID)).toBe('idle');
        expect(time.pending()).toBe(0);
    });

    it('detaching drops every listener and every timer', () => {
        const { hold, time } = tracker();
        const room = new FakeRoom();
        const detach = attachShareHoldToRoom(room, hold);
        const p = makeParticipant();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        applyUpdate(room, p, { attr: 'a' });
        detach();
        expect(room.listeners(RoomEvent.TrackUnpublished)).toBe(0);
        expect(time.pending()).toBe(0);
        expect(hold.phase(ID)).toBe('idle');
    });
});

// ── Sounds and the streamer's viewer count ──────────────────────────────────

describe('a republish is silent, a real stop is not', () => {
    function cueRig() {
        const { hold, time } = tracker();
        const room = new FakeRoom();
        const played: TrackCue[] = [];
        const cues = new TrackCueController({
            isReady: () => true,
            isAdjusting: identity => hold.isGapExpected(identity),
            play: c => played.push(c),
            now: time.deps.now,
            setTimer: time.deps.setTimer,
            clearTimer: time.deps.clearTimer,
            sources: { camera: Track.Source.Camera, screenShare: Track.Source.ScreenShare },
        });
        // Same order as CallPane: cue listeners first, so they see the state from before each event.
        room.on(RoomEvent.TrackPublished, ((pub: never, part: never) => cues.trackPublished(pub, part)) as never);
        room.on(RoomEvent.TrackUnpublished, ((pub: never, part: never) => cues.trackUnpublished(pub, part)) as never);
        attachShareHoldToRoom(room, hold);
        return { hold, time, room, played, cues, p: makeParticipant() };
    }

    it('a 3 s republish plays neither the stop nor the start cue', () => {
        const { time, room, played, p } = cueRig();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        played.length = 0;
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        time.advance(3000); // past the old 2 s ss-adjust window and the 250 ms republish window
        applyUpdate(room, p, { addTrack: 'TR_new' });
        time.advance(1000);
        expect(played).toEqual([]);
    });

    it('positive control: the same gap with no flag plays both', () => {
        const { time, room, played, p } = cueRig();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        played.length = 0;
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        time.advance(3000);
        applyUpdate(room, p, { addTrack: 'TR_new' });
        expect(played).toEqual(['screenshare_off', 'screenshare_on']);
    });

    it('a hold that closes without a stream plays the stop it held back, once', () => {
        const { hold, time, room, played, p, cues } = cueRig();
        hold.onEnded((_id, end) => { if (end === 'timeout' || end === 'cancelled') cues.shareHoldClosed(); });
        applyUpdate(room, p, { addTrack: 'TR_old' });
        played.length = 0;
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        expect(played).toEqual([]);
        time.advance(HOLD_TIMEOUT_MS);
        expect(played).toEqual(['screenshare_off']);
    });

    it('a stop just after a republish cues normally', () => {
        const { hold, time, room, played, p } = cueRig();
        applyUpdate(room, p, { addTrack: 'TR_old' });
        played.length = 0;
        applyUpdate(room, p, { attr: 'a' });
        applyUpdate(room, p, { removeTrack: 'TR_old' });
        applyUpdate(room, p, { addTrack: 'TR_new' });
        hold.dispatch(ID, { type: 'first_frame' });
        applyUpdate(room, p, { removeTrack: 'TR_new' });
        time.advance(1000);
        expect(played).toEqual(['screenshare_off']);
    });
});

describe("the streamer's viewer cues across a republish", () => {
    it('no stream_viewer_join, no leave, and the count is the same set after', () => {
        let state = initialViewerCueState();
        const viewers = ['alice', 'bob'];
        const fold = (epoch: string, list: string[], now: number) => {
            const r = reduceViewerCues(state, { epoch, viewers: list, now });
            state = r.state;
            return r.cues;
        };
        expect(fold('TR_old:live', viewers, 1000)).toEqual([]);
        expect(fold('TR_old:live', viewers, 10_000)).toEqual([]);
        // The republish: not sharing for a moment, then a new sid. The viewers' own
        // metadata never changed, because their watch set is held through the gap.
        expect(fold('', viewers, 10_100)).toEqual([]);
        expect(fold('pending:live', viewers, 13_000)).toEqual([]);
        expect(fold('TR_new:live', viewers, 13_200)).toEqual([]);
        expect(state.viewers).toEqual(viewers);
    });
});
