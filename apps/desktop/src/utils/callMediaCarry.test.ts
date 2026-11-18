import { describe, it, expect, vi } from 'vitest';
import {
    createCallMediaCarry, decideCarriedMedia, carryStoppedToast, canPublishSource,
    CARRY_TTL_MS, PROTO_SOURCE_CAMERA, PROTO_SOURCE_SCREEN_SHARE, type LiveMediaSnapshot,
} from './callMediaCarry';
import { createCallTransitionTracker, runForceMove, type ForceMoveEventData, type ForceMoveFlowPorts } from './callTransition';
import { resolveCarriedIntent, selfCallIntent } from './selfCallIntent';
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

// ── Fakes: just enough of MediaStreamTrack and a LiveKit room ────────────────

class FakeTrack {
    readyState: 'live' | 'ended' = 'live';
    clones: FakeTrack[] = [];
    readonly label: string;
    constructor(label: string) { this.label = label; }
    clone(): FakeTrack { const c = new FakeTrack(`${this.label}#clone`); this.clones.push(c); return c; }
    stop(): void { this.readyState = 'ended'; }
}
const asTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;

/** A LiveKit room as far as a move cares: what the local participant publishes, and
 *  disconnect() stopping every local track (LiveKit's stopLocalTrackOnUnpublish). */
class FakeRoom {
    published = new Map<'screen_share' | 'camera' | 'microphone', FakeTrack>();
    readonly callId: string;
    readonly e2ee: boolean;
    constructor(callId: string, e2ee: boolean) { this.callId = callId; this.e2ee = e2ee; }
    publish(source: 'screen_share' | 'camera' | 'microphone', t: FakeTrack) { this.published.set(source, t); }
    disconnect() { for (const t of this.published.values()) t.stop(); this.published.clear(); }
}

const SHARE: ScreenShareOptions = { sourceId: 'screen:1:0', resolution: '1080p', frameRate: 60, audio: true };

/** What SidebarConference registers: the live share's options + a clone of its capture, and the camera. */
const snapshotOf = (room: FakeRoom, options: ScreenShareOptions | null) => (): LiveMediaSnapshot => {
    const ss = room.published.get('screen_share');
    return {
        share: ss && options ? { options, capture: ss.readyState === 'live' ? asTrack(ss.clone()) : null } : null,
        camera: room.published.has('camera'),
    };
};

const moveEvent = (over: Partial<ForceMoveEventData> = {}): ForceMoveEventData => ({
    huddle_id: 'h-b', call_id: 'call-b', call_name: 'Raid night', livekit_url: 'wss://lk', livekit_token: 't',
    moved_by: 'mod', moved_by_name: 'Mod', from_call_id: 'call-a', nonce: 1, ...over,
});

/**
 * The Dashboard's force_move flow against fake rooms: entering the destination
 * unmounts the old pane (its room disconnects, stopping its tracks) and mounts the
 * new one, whose in-call UI collects the carry and publishes it into ITS room.
 */
function simulateMove(opts: { carry: boolean; source: FakeRoom; options: ScreenShareOptions | null; destE2ee?: boolean }) {
    const carry = createCallMediaCarry({ setTimer: () => 0, clearTimer: () => {} });
    carry.register(snapshotOf(opts.source, opts.options));
    const dest = new FakeRoom('call-b', opts.destE2ee ?? true);
    let active: string | null = opts.source.callId;
    const ports: ForceMoveFlowPorts<number> = {
        activeCallId: () => active,
        isInSourceCall: () => true,
        beginJoin: () => 1,
        settleJoin: () => true,
        ...(opts.carry ? { carryMedia: (e: ForceMoveEventData) => { carry.capture(e.call_id, e.call_name); } } : {}),
        enter: sel => {
            active = sel.activeCall.id;
            opts.source.disconnect();           // old pane unmounts → its room stops every local track
            // new pane mounts, room connected: its SidebarConference takes the carry
            const got = carry.take(sel.activeCall.id);
            if (got?.share) {
                const d = decideCarriedMedia({ e2eeActive: dest.e2ee, channelAllows: true, moderatorDisabled: false, grantAllows: true });
                if (d.action === 'publish' && got.share.capture) dest.publish('screen_share', got.share.capture as unknown as FakeTrack);
                else got.share.capture?.stop();
            }
            if (got?.camera) dest.publish('camera', new FakeTrack('camera-b'));
        },
        announce: () => {},
    };
    const outcome = runForceMove(moveEvent(), ports, createCallTransitionTracker());
    return { outcome, dest, carry };
}

describe('a moderator move keeps the moved member’s screen share (owner report 2026-11-18)', () => {
    it('REPRODUCTION: without a carry, the move stops the share and nothing reaches the new call', () => {
        const source = new FakeRoom('call-a', true);
        const capture = new FakeTrack('screen');
        source.publish('screen_share', capture);
        const { outcome, dest } = simulateMove({ carry: false, source, options: SHARE });
        expect(outcome).toBe('entered');
        expect(capture.readyState).toBe('ended');
        expect(dest.published.has('screen_share')).toBe(false); // the bug: the share silently ended
    });

    it('with the carry, the capture outlives the old room and is published in the new one', () => {
        const source = new FakeRoom('call-a', true);
        const capture = new FakeTrack('screen');
        source.publish('screen_share', capture);
        const { outcome, dest, carry } = simulateMove({ carry: true, source, options: SHARE });
        expect(outcome).toBe('entered');
        expect(capture.readyState).toBe('ended');                 // the old room's own track is gone...
        const republished = dest.published.get('screen_share');
        expect(republished?.label).toBe('screen#clone');           // ...its clone is live in the destination
        expect(republished?.readyState).toBe('live');
        expect(carry.pending()).toBeNull();                        // single use
    });

    it('the camera comes along too', () => {
        const source = new FakeRoom('call-a', true);
        source.publish('camera', new FakeTrack('camera-a'));
        const { dest } = simulateMove({ carry: true, source, options: null });
        expect(dest.published.has('camera')).toBe(true);
    });

    it('a destination that is not encrypted never gets the share: the clone is stopped', () => {
        const source = new FakeRoom('call-a', true);
        const capture = new FakeTrack('screen');
        source.publish('screen_share', capture);
        const { dest } = simulateMove({ carry: true, source, options: SHARE, destE2ee: false });
        expect(dest.published.has('screen_share')).toBe(false);
        expect(capture.clones[0].readyState).toBe('ended');
    });

    it('a VIEWER being moved (publishing nothing of their own) carries nothing and still enters the new call', () => {
        const source = new FakeRoom('call-a', true);
        source.publish('microphone', new FakeTrack('mic'));
        const { outcome, dest, carry } = simulateMove({ carry: true, source, options: null });
        expect(outcome).toBe('entered');
        expect(carry.pending()).toBeNull();
        expect(dest.published.size).toBe(0);
    });

    it('self mute / deafen still carry exactly as before (the media carry does not touch them)', () => {
        selfCallIntent.set({ muted: true, deafened: false });
        const source = new FakeRoom('call-a', true);
        source.publish('screen_share', new FakeTrack('screen'));
        simulateMove({ carry: true, source, options: SHARE });
        expect(resolveCarriedIntent({ inCall: true, starting: false, connected: true, joinIntent: { muted: false, deafened: false }, stored: selfCallIntent.get() }))
            .toEqual({ muted: true, deafened: false });
        selfCallIntent.clear();
    });

    it('a superseded move carries nothing', () => {
        const carry = createCallMediaCarry({ setTimer: () => 0, clearTimer: () => {} });
        const capture = new FakeTrack('screen');
        const source = new FakeRoom('call-a', true);
        source.publish('screen_share', capture);
        carry.register(snapshotOf(source, SHARE));
        const carryMedia = vi.fn((e: ForceMoveEventData) => { carry.capture(e.call_id, e.call_name); });
        const outcome = runForceMove(moveEvent(), {
            activeCallId: () => 'call-a', isInSourceCall: () => true, beginJoin: () => 1, settleJoin: () => false,
            carryMedia, enter: () => {}, announce: () => {},
        }, createCallTransitionTracker());
        expect(outcome).toBe('superseded');
        expect(carryMedia).not.toHaveBeenCalled();
        expect(capture.clones).toHaveLength(0);
    });
});

describe('createCallMediaCarry', () => {
    const live = (): LiveMediaSnapshot => ({ share: { options: SHARE, capture: asTrack(new FakeTrack('s')) }, camera: true });

    it('is bound to the destination call and single-use', () => {
        const c = createCallMediaCarry({ setTimer: () => 0, clearTimer: () => {} });
        c.register(live);
        expect(c.capture('call-b', 'B')).toBe(true);
        expect(c.take('call-x')).toBeNull();
        expect(c.take(null)).toBeNull();
        const got = c.take('call-b');
        expect(got?.toCallName).toBe('B');
        expect(got?.camera).toBe(true);
        expect(c.take('call-b')).toBeNull();
    });

    it('nothing registered, or nothing live: nothing carried', () => {
        const c = createCallMediaCarry({ setTimer: () => 0, clearTimer: () => {} });
        expect(c.capture('call-b', 'B')).toBe(false);
        c.register(() => ({ share: null, camera: false }));
        expect(c.capture('call-b', 'B')).toBe(false);
        expect(c.pending()).toBeNull();
    });

    it('a snapshot that throws carries nothing (the move itself goes on)', () => {
        const c = createCallMediaCarry({ setTimer: () => 0, clearTimer: () => {} });
        c.register(() => { throw new Error('boom'); });
        expect(c.capture('call-b', 'B')).toBe(false);
    });

    it('a carry nobody collects is released when it expires, its capture STOPPED', () => {
        let fire: (() => void) | null = null;
        let t = 0;
        const c = createCallMediaCarry({ now: () => t, setTimer: (fn, ms) => { expect(ms).toBe(CARRY_TTL_MS); fire = fn; return 1; }, clearTimer: () => {} });
        const capture = new FakeTrack('s');
        c.register(() => ({ share: { options: SHARE, capture: asTrack(capture) }, camera: false }));
        c.capture('call-b', 'B');
        t = CARRY_TTL_MS;
        fire!();
        expect(capture.readyState).toBe('ended');
        expect(c.take('call-b')).toBeNull();
    });

    it('expiry tells the user (share and camera each), a deliberate discard does not', () => {
        let fire: (() => void) | null = null;
        const c = createCallMediaCarry({ setTimer: fn => { fire = fn; return 1; }, clearTimer: () => {} });
        const seen: string[] = [];
        c.onExpire(m => seen.push(`${m.toCallName}:${m.share ? 'share' : ''}:${m.camera ? 'camera' : ''}`));
        c.register(() => ({ share: { options: SHARE, capture: asTrack(new FakeTrack('s')) }, camera: true }));
        c.capture('call-b', 'B');
        c.discard();
        expect(seen).toEqual([]);
        c.capture('call-b', 'B');
        fire!();
        expect(seen).toEqual(['B:share:camera']);
    });

    it('an expired carry is not handed out even if the timer has not run yet', () => {
        let t = 0;
        const capture = new FakeTrack('s');
        const c = createCallMediaCarry({ now: () => t, setTimer: () => 1, clearTimer: () => {} });
        c.register(() => ({ share: { options: SHARE, capture: asTrack(capture) }, camera: false }));
        c.capture('call-b', 'B');
        t = CARRY_TTL_MS + 1;
        expect(c.take('call-b')).toBeNull();
        expect(capture.readyState).toBe('ended');
    });

    it('discard (the user left, the move failed) stops the carried capture; a new capture replaces an old one', () => {
        const c = createCallMediaCarry({ setTimer: () => 1, clearTimer: () => {} });
        const first = new FakeTrack('a');
        const second = new FakeTrack('b');
        let next = first;
        c.register(() => ({ share: { options: SHARE, capture: asTrack(next) }, camera: false }));
        c.capture('call-b', 'B');
        next = second;
        c.capture('call-c', 'C');
        expect(first.readyState).toBe('ended');
        c.discard();
        expect(second.readyState).toBe('ended');
        expect(c.pending()).toBeNull();
    });

    it('unregister only drops its own snapshotter (a remounted UI registered a newer one)', () => {
        const c = createCallMediaCarry({ setTimer: () => 1, clearTimer: () => {} });
        const offOld = c.register(() => ({ share: null, camera: false }));
        c.register(() => ({ share: null, camera: true }));
        offOld();
        expect(c.capture('call-b', 'B')).toBe(true);
    });

    it('the noted share is only returned for the same publication', () => {
        const c = createCallMediaCarry();
        c.noteShare(SHARE, 'TR_1');
        expect(c.notedShareFor('TR_1')).toEqual(SHARE);
        expect(c.notedShareFor('TR_2')).toBeNull();
        expect(c.notedShareFor(null)).toBeNull();
        c.noteShare(null, 'TR_1');
        expect(c.notedShareFor('TR_1')).toBeNull();
    });
});

describe('decideCarriedMedia', () => {
    const ok = { e2eeActive: true, channelAllows: true, moderatorDisabled: false, grantAllows: true };
    it.each([
        [ok, { action: 'publish' }],
        [{ ...ok, e2eeActive: false }, { action: 'stop', reason: 'encryption' }],
        [{ ...ok, channelAllows: false }, { action: 'stop', reason: 'permission' }],
        [{ ...ok, moderatorDisabled: true }, { action: 'stop', reason: 'moderator' }],
        [{ ...ok, grantAllows: false }, { action: 'stop', reason: 'grant' }],
        // encryption outranks everything: never "publish" in the clear, whatever else holds
        [{ e2eeActive: false, channelAllows: false, moderatorDisabled: true, grantAllows: false }, { action: 'stop', reason: 'encryption' }],
        [{ ...ok, channelAllows: false, moderatorDisabled: true }, { action: 'stop', reason: 'permission' }],
    ])('%j → %j', (input, want) => {
        expect(decideCarriedMedia(input)).toEqual(want);
    });
});

describe('carryStoppedToast', () => {
    it('names the destination and the reason, never "kicked"', () => {
        const t = carryStoppedToast('share', 'permission', 'Raid night');
        expect(t).toEqual({ kind: 'warning', title: 'Screen share stopped', message: "You were moved to Raid night, where you don't have permission to share your screen." });
        expect(carryStoppedToast('camera', 'moderator', 'B').message).toBe('You were moved to B. A moderator has turned off your camera.');
        expect(carryStoppedToast('share', 'grant', 'B').message).toBe("You were moved to B, where you can't share your screen.");
        expect(carryStoppedToast('share', 'failed', '  ').message).toBe("Your screen share couldn't restart in the new call. Share again to continue.");
        expect(carryStoppedToast('camera', 'encryption', 'B').title).toBe('Camera turned off');
        for (const r of ['permission', 'moderator', 'grant', 'encryption', 'failed'] as const) {
            expect(carryStoppedToast('share', r, 'B').message).not.toMatch(/kick|remov/i);
        }
    });
});

describe('canPublishSource', () => {
    it('reads the SFU grant; unknown means allowed', () => {
        expect(canPublishSource(null, PROTO_SOURCE_SCREEN_SHARE)).toBe(true);
        expect(canPublishSource({ permissions: undefined }, PROTO_SOURCE_CAMERA)).toBe(true);
        expect(canPublishSource({ permissions: { canPublish: false } }, PROTO_SOURCE_CAMERA)).toBe(false);
        expect(canPublishSource({ permissions: { canPublishSources: [] } }, PROTO_SOURCE_SCREEN_SHARE)).toBe(true);
        // free tier: audio only (microphone = 2)
        expect(canPublishSource({ permissions: { canPublishSources: [2] } }, PROTO_SOURCE_SCREEN_SHARE)).toBe(false);
        expect(canPublishSource({ permissions: { canPublishSources: [2] } }, PROTO_SOURCE_CAMERA)).toBe(false);
        expect(canPublishSource({ permissions: { canPublishSources: [1, 2, 3, 4] } }, PROTO_SOURCE_SCREEN_SHARE)).toBe(true);
    });
});
