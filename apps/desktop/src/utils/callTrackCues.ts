/**
 * callTrackCues — pure decision logic for the camera_on / camera_off in-call
 * sound cues. Deliberately LiveKit-free (no `Track`/`Room` imports) so it can
 * be unit tested without a Room fixture; the call site in CallPane.tsx does
 * the LiveKit-specific plumbing (event registration, `Track.Source` checks,
 * the readiness gate) and hands this function only the plain facts.
 *
 * ── Why camera has no "unpublished" case, unlike screenshare ────────────────
 *
 * Screenshare start/stop is a genuine publish/unpublish cycle (LiveKit's
 * `setTrackEnabled` unpublishes a screenshare on stop — "screenshare cannot be
 * muted, unpublish instead"). Camera is different: `setCameraEnabled(false)`
 * calls `track.mute()`, never `unpublishTrack()` — the publication survives
 * for the life of the call, and only its mute state flips. The one time a
 * camera publication genuinely gets unpublished is participant departure
 * teardown (`Room.handleParticipantDisconnected` unpublishes every remaining
 * track before emitting `ParticipantDisconnected`), which already earns its
 * own `leave` cue via the participant-count effect. Treating that unpublish
 * as a second `camera_off` cue would double up on every departure while
 * someone's camera happened to be on — so `'unpublished'` is deliberately not
 * a case this function maps to anything. Contrast with screenshare's
 * onTrackUnpublished handler, which needs (and has) a short delay + cancel-on-
 * disconnect dance for exactly this reason; camera avoids needing that
 * mechanism by not reacting to unpublish at all.
 */
export type CameraTrackEvent = 'published' | 'muted' | 'unmuted';

/**
 * Decide which cue (if any) a camera track-state event should play.
 *
 * `ready` is the caller's gate against two storms this function does not
 * itself have the information to detect:
 *  - join storm: LiveKit reports every already-published remote track as part
 *    of initial room sync, which looks identical to a live "just published"
 *    event from here. The caller suppresses the first ~500ms after mount.
 *  - reconnect replay: a full LiveKit reconnect tears down and re-adds remote
 *    participants, which can re-fire "published" for tracks that were already
 *    on before the disconnect. The caller re-arms the same gate around
 *    Reconnecting/Reconnected.
 */
export function cameraCueForEvent(event: CameraTrackEvent, ready: boolean, facts?: PublishFacts): 'camera_on' | 'camera_off' | null {
    if (!ready) return null;
    switch (event) {
        case 'published':
            // A publication that replaces one of the same source is OUR
            // republish (codec switch, H.265 negotiation, hardware-encoder
            // fallback, layering change) — the camera was already on. One
            // that arrives muted is not "on" yet: its unmute will cue.
            if (facts && (isRepublish(facts, CAMERA_REPUBLISH_WINDOW_MS) || facts.muted)) return null;
            return 'camera_on';
        case 'unmuted':
            return 'camera_on';
        case 'muted':
            return 'camera_off';
        default:
            return null;
    }
}

// ── Republish vs genuine start ──────────────────────────────────────────────
//
// The app republishes a LIVE camera or screen share without the user touching
// anything: the H.265 negotiation (SidebarConference) and the "Allow H.265"
// setting, the hardware-encoder fallback and stall watchdog
// (cameraPublish.fallBackFromHardwareCamera / recoverStalledCamera), the 1:1
// layering change (republishCamera), the share codec swap (shareRepublish).
// Each is a new publication of the same source — and before this, every one
// of them played camera_on / screenshare_on for EVERYONE in the call (the
// "camera turn-on sound replaying while the laggy webcam was loading" report).
// Two shapes, both recognisable from what every listener can see:
//   - make-before-break (republishCamera, swapShareCodec): the new publication
//     appears while the old one of the same source is still on the
//     participant → `otherSameSource`;
//   - break-before-make (the camera fallback's last resort: unpublish, then
//     startCamera): the same source was unpublished moments ago →
//     `msSinceUnpublished` inside the window. A camera is never unpublished
//     by the user (turning it off is a mute — see the header), so any recent
//     camera unpublish followed by a publish is a republish.
// Subscribing, re-subscribing, pausing/resuming (remoteVideoDemand), quality
// layers and focus changes never publish anything, so they never cue at all.

/** What a listener knows about a publish/unpublish of one source on one participant. */
export interface PublishFacts {
    /** Another publication of the same source is still on the participant. */
    otherSameSource: boolean;
    /** ms since this participant last unpublished this source, or null if never. */
    msSinceUnpublished: number | null;
    /** The new publication arrived muted (camera only). */
    muted?: boolean;
}

/** A camera unpublish this recent, followed by a publish, is a republish. */
export const CAMERA_REPUBLISH_WINDOW_MS = 5_000;
/**
 * Screen share: a user CAN stop and start again quickly, so only the
 * same-update case (unpublish and publish of a swap landing together, while
 * the stop cue is still pending — CallPane delays it 200 ms) counts.
 */
export const SHARE_REPUBLISH_WINDOW_MS = 250;

export function isRepublish(f: PublishFacts, windowMs: number): boolean {
    return f.otherSameSource || (f.msSinceUnpublished !== null && f.msSinceUnpublished >= 0 && f.msSinceUnpublished < windowMs);
}

/** screenshare_on for a share publication, or null (not ready / adjusting / republish). */
export function shareStartCue(ready: boolean, adjusting: boolean, facts: PublishFacts): 'screenshare_on' | null {
    if (!ready || adjusting) return null;
    return isRepublish(facts, SHARE_REPUBLISH_WINDOW_MS) ? null : 'screenshare_on';
}

/** Should a share UNpublish schedule the screenshare_off cue? Not when another share publication remains (the old half of a swap). */
export function shareStopCue(ready: boolean, adjusting: boolean, otherSameSourceRemains: boolean): boolean {
    return ready && !adjusting && !otherSameSourceRemains;
}

/** Per participant+source, when it was last unpublished. Plain data — owned by the cue effect. */
export class UnpublishMemory {
    private last = new Map<string, number>();
    note(key: string, now: number): void { this.last.set(key, now); }
    msSince(key: string, now: number): number | null {
        const t = this.last.get(key);
        return t === undefined ? null : now - t;
    }
    forget(key: string): void { this.last.delete(key); }
    clear(): void { this.last.clear(); }
}

// ── The cue controller CallPane's CallAudioEffects drives ───────────────────

export type TrackCue = 'camera_on' | 'camera_off' | 'screenshare_on' | 'screenshare_off';

/** The parts of a LiveKit publication / participant the controller reads. */
export interface CuePublication {
    source?: unknown;
    trackSid?: string;
    isMuted?: boolean;
}
export interface CueParticipant {
    identity: string;
    trackPublications?: { values(): Iterable<CuePublication> };
}

export interface TrackCueDeps {
    /** The join-storm / reconnect gate (CallPane's readyRef). */
    isReady(): boolean;
    /** The `ss-adjust` grace window for a sharer's Change Source / Adjust Quality. */
    isAdjusting(identity: string): boolean;
    play(cue: TrackCue): void;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    /** LiveKit's Track.Source values (passed in so this module stays LiveKit-free). */
    sources: { camera: unknown; screenShare: unknown };
}

/** Imperceptible for a cue, long enough to catch a following leave or a swap's publish. */
export const SHARE_STOP_DELAY_MS = 200;

/**
 * Which cue every camera / screen-share track event plays — for the actor
 * (Local* events) and for everyone else (remote events) alike. Owns the
 * pending share-stop timers and the recent-unpublish memory.
 */
export class TrackCueController {
    private readonly recent = new UnpublishMemory();
    private readonly pendingShareStop = new Map<string, unknown>();
    private readonly d: TrackCueDeps;

    constructor(deps: TrackCueDeps) { this.d = deps; }

    private key(identity: string, source: unknown) { return `${String(source)}\u0000${identity}`; }

    private otherSameSource(participant: CueParticipant, pub: CuePublication): boolean {
        for (const other of participant.trackPublications?.values() ?? []) {
            if (other !== pub && other.trackSid !== pub.trackSid && other.source === pub.source) return true;
        }
        return false;
    }

    private facts(pub: CuePublication, participant: CueParticipant): PublishFacts {
        return {
            otherSameSource: this.otherSameSource(participant, pub),
            msSinceUnpublished: this.recent.msSince(this.key(participant.identity, pub.source), this.d.now()),
            muted: !!pub.isMuted,
        };
    }

    trackPublished(pub: CuePublication, participant: CueParticipant): void {
        if (!this.d.isReady()) return;
        const { camera, screenShare } = this.d.sources;
        if (pub.source === screenShare) {
            // The old half of a swap may have scheduled a stop cue in the same
            // update: that was a republish — drop both.
            const pending = this.pendingShareStop.get(participant.identity);
            if (pending !== undefined) {
                this.d.clearTimer(pending);
                this.pendingShareStop.delete(participant.identity);
                return;
            }
            const cue = shareStartCue(true, this.d.isAdjusting(participant.identity), this.facts(pub, participant));
            if (cue) this.d.play(cue);
        } else if (pub.source === camera) {
            const cue = cameraCueForEvent('published', true, this.facts(pub, participant));
            if (cue) this.d.play(cue);
        }
    }

    trackUnpublished(pub: CuePublication, participant: CueParticipant): void {
        const { camera, screenShare } = this.d.sources;
        if (pub.source === camera || pub.source === screenShare) {
            this.recent.note(this.key(participant.identity, pub.source), this.d.now());
        }
        if (pub.source !== screenShare) return;
        if (!shareStopCue(this.d.isReady(), this.d.isAdjusting(participant.identity), this.otherSameSource(participant, pub))) return;
        const prev = this.pendingShareStop.get(participant.identity);
        if (prev !== undefined) this.d.clearTimer(prev);
        const timer = this.d.setTimer(() => {
            this.pendingShareStop.delete(participant.identity);
            this.d.play('screenshare_off');
        }, SHARE_STOP_DELAY_MS);
        this.pendingShareStop.set(participant.identity, timer);
    }

    trackMuted(pub: CuePublication): void {
        if (pub.source !== this.d.sources.camera) return;
        const cue = cameraCueForEvent('muted', this.d.isReady());
        if (cue) this.d.play(cue);
    }

    trackUnmuted(pub: CuePublication): void {
        if (pub.source !== this.d.sources.camera) return;
        const cue = cameraCueForEvent('unmuted', this.d.isReady());
        if (cue) this.d.play(cue);
    }

    participantDisconnected(participant: { identity: string }): void {
        // A leave is not a republish: someone who rejoins and turns their
        // camera on is cued normally.
        this.recent.forget(this.key(participant.identity, this.d.sources.camera));
        this.recent.forget(this.key(participant.identity, this.d.sources.screenShare));
        // The leave cue (participant count) replaces a pending share stop.
        const t = this.pendingShareStop.get(participant.identity);
        if (t !== undefined) {
            this.d.clearTimer(t);
            this.pendingShareStop.delete(participant.identity);
        }
    }

    dispose(): void {
        for (const t of this.pendingShareStop.values()) this.d.clearTimer(t);
        this.pendingShareStop.clear();
        this.recent.clear();
    }
}
