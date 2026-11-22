/**
 * Alone in a call: stop SENDING media until somebody joins (owner, 2026-11-20: "if someone sits in a call for a long
 * time by themselves, it shouldn't use bandwidth").
 *
 * The mic publishes Opus at up to 64 kbps with DTX off (CallPane.tsx roomOptions) and the voice gate only attenuates,
 * so a person alone in a call still uploads a steady stream to the SFU that nobody receives. Once EVERY live source
 * (the Room's own remoteParticipants, the participants hook, server voice presence - utils/aloneLeave.ts) has said
 * "nobody else is here" for ALONE_PAUSE_AFTER_MS, the audio senders are switched off with
 * `RTCRtpSender.setParameters({ encodings: [{ active: false }] })`.
 *
 * Why the encoding's `active` flag and not livekit-client's `pauseUpstream()`:
 *   - pauseUpstream() also tells the SFU the track is MUTED (LocalParticipant.onTrackUpstreamPaused), so a person who
 *     joins would briefly see us as muted until the unmute signal lands, and it goes through replaceTrack(null): any
 *     later replaceTrack on that sender (the voice processor's setProcessor, a device restart) puts the track back on
 *     the wire while livekit still thinks it is paused.
 *   - `active: false` is a property of the SENDER: the local MediaStreamTrack, the voice processor, the mic meter, the
 *     mute button and every speaking indicator fed from the local analyser keep running exactly as before; replaceTrack
 *     does not reset it; no signalling message is sent, so nobody else's view of us changes. Resuming is one local
 *     setParameters call - no SDP, no SFU round trip (measured in harness/call-alone-upstream).
 *
 * Video is NOT touched here: with `dynacast: true` the SFU already tells the publisher to switch off every simulcast
 * layer nobody subscribes to, and with nobody else in the room that is every layer (measured: see the worklog).
 *
 * Resume is fail-open: any sign of another person (a ParticipantConnected, a presence join, a source that disagrees),
 * any doubt (the room or a source unreadable), a reconnect, a device switch or a new local publication puts the audio
 * back on the wire at once, and only another full ALONE_PAUSE_AFTER_MS of certainty pauses it again.
 *
 * E2EE: the frame cryptor is an encoded transform on the same sender; `active` only stops the encoder feeding it. The
 * key provider, the key index and call_key distribution are untouched, so the first frame after resume is encrypted
 * under the current key exactly as it would have been without the pause (harness: a joiner decrypts it).
 */
import { type AloneCounts, someoneElseHere } from './aloneLeave';

/** Continuous certainty of being alone before the audio stops going out. */
export const ALONE_PAUSE_AFTER_MS = 30_000;
/** While paused, the sources are re-read this often, in case an event that should have resumed was missed. */
export const ALONE_RECHECK_MS = 2_000;

export type UpstreamResumeReason = 'join' | 'uncertain' | 'reconnect' | 'device' | 'publish' | 'stop';

/**
 * Alone for certain: the live Room and the hook both say nobody else, and server presence (when this call has any)
 * agrees. `null` counts (a source that could not be read) are doubt, except presence, which DM / group calls never have.
 */
export function certainlyAlone(c: AloneCounts | null): boolean {
    if (!c) return false;
    if (c.live === null) return false;
    return !someoneElseHere(c);
}

export interface AloneUpstreamDeps {
    /** The live counts; null or a throw = cannot tell (keep sending). */
    probe: () => AloneCounts | null;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (h: unknown) => void;
    now: () => number;
    /** Stop sending. Resolves true if something is now paused, false if there was nothing to pause or it failed. */
    pause: () => Promise<boolean>;
    /** Start sending again. Must not throw past a failed sender (best effort per sender). */
    resume: () => Promise<void>;
    onPaused: () => void;
    onResumed: (reason: UpstreamResumeReason, pausedMs: number) => void;
}

/**
 * The decision logic, free of React, LiveKit and real timers.
 *
 *   check()           a source changed (hook count, presence): re-read and start / cancel the alone window, or resume.
 *   joined()          a participant connected: resume NOW, before reading anything (the joiner's first words).
 *   interrupt(r)      reconnect / device switch / new publication: resume, and start a fresh alone window.
 *   hold(on)          while reconnecting: never pause (resume if paused); `hold(false)` re-evaluates.
 *   dispose()         the call UI is going away: resume (fail open - the room may outlive this controller).
 */
export class AloneUpstream {
    private readonly d: AloneUpstreamDeps;
    private timer: unknown = null;
    private poll: unknown = null;
    private want = false;          // the target state: paused?
    private isPaused = false;      // what the senders actually are
    private pausedAt = 0;
    private held = false;
    private disposed = false;
    private ops: Promise<void> = Promise.resolve();

    constructor(deps: AloneUpstreamDeps) { this.d = deps; }

    get paused(): boolean { return this.isPaused; }
    /** For tests: the alone window is running. */
    get waiting(): boolean { return this.timer !== null; }

    private read(): AloneCounts | null {
        try { return this.d.probe(); } catch { return null; }
    }

    private cancelTimer() {
        if (this.timer !== null) { this.d.cancel(this.timer); this.timer = null; }
    }

    private stopPoll() {
        if (this.poll !== null) { this.d.cancel(this.poll); this.poll = null; }
    }

    private startPoll() {
        this.stopPoll();
        this.poll = this.d.schedule(() => {
            this.poll = null;
            if (this.disposed || !this.isPaused) return;
            this.check();
            if (this.isPaused && this.want) this.startPoll();
        }, ALONE_RECHECK_MS);
    }

    private enqueue(op: () => Promise<void>) {
        this.ops = this.ops.then(op, op).catch(() => { /* an op never breaks the chain */ });
    }

    check(): void {
        if (this.disposed) return;
        const c = this.read();
        if (this.held || !certainlyAlone(c)) {
            this.cancelTimer();
            if (this.want || this.isPaused) this.requestResume(c && someoneElseHere(c) ? 'join' : 'uncertain');
            return;
        }
        if (!this.want && this.timer === null) {
            this.timer = this.d.schedule(() => {
                this.timer = null;
                if (this.disposed) return;
                if (!this.held && certainlyAlone(this.read())) this.requestPause();
                else this.check();
            }, ALONE_PAUSE_AFTER_MS);
        }
    }

    joined(): void {
        if (this.disposed) return;
        this.cancelTimer();
        if (this.want || this.isPaused) this.requestResume('join');
        this.check();
    }

    interrupt(reason: Exclude<UpstreamResumeReason, 'join' | 'uncertain' | 'stop'>): void {
        if (this.disposed) return;
        this.cancelTimer();
        if (this.want || this.isPaused) this.requestResume(reason);
        this.check();
    }

    hold(on: boolean): void {
        if (this.disposed) return;
        this.held = on;
        if (on) this.interrupt('reconnect');
        else this.check();
    }

    dispose(): void {
        if (this.disposed) return;
        this.cancelTimer();
        this.stopPoll();
        if (this.want || this.isPaused) this.requestResume('stop');
        this.disposed = true;
    }

    private requestPause() {
        this.want = true;
        this.enqueue(async () => {
            if (!this.want || this.disposed || this.isPaused) return;
            let ok = false;
            try { ok = await this.d.pause(); } catch { ok = false; }
            if (!ok) { this.want = false; this.check(); return; }
            this.isPaused = true;
            this.pausedAt = this.d.now();
            this.d.onPaused();
            // A resume requested while the senders were being switched off is queued right behind this op.
            if (this.want) this.startPoll();
        });
    }

    private requestResume(reason: UpstreamResumeReason) {
        this.want = false;
        this.stopPoll();
        this.enqueue(async () => {
            if (this.want || !this.isPaused) return;
            try { await this.d.resume(); } catch { /* best effort: resume() is per-sender already */ }
            this.isPaused = false;
            this.d.onResumed(reason, Math.max(0, this.d.now() - this.pausedAt));
        });
    }
}

// ── Senders ─────────────────────────────────────────────────────────────────

/** The part of an RTCRtpSender this needs (a fake in tests). */
export interface ActiveSenderLike {
    getParameters(): RTCRtpSendParameters;
    setParameters(p: RTCRtpSendParameters): Promise<void>;
}

/**
 * Set every encoding of every sender to `active`. Returns how many senders it changed. On a failure while switching
 * OFF, the senders already switched off are switched back on and the error is rethrown (never half-paused); while
 * switching ON it carries on with the rest and rethrows the first error at the end.
 */
export async function setSendersActive(senders: readonly ActiveSenderLike[], active: boolean): Promise<number> {
    const done: ActiveSenderLike[] = [];
    let firstErr: unknown = null;
    for (const s of senders) {
        try {
            const p = s.getParameters();
            if (!p.encodings || p.encodings.length === 0) continue;
            let diff = false;
            for (const e of p.encodings) {
                if ((e.active !== false) !== active) { e.active = active; diff = true; }
            }
            if (!diff) continue;
            await s.setParameters(p);
            done.push(s);
        } catch (err) {
            if (!active) {
                await setSendersActive(done, true).catch(() => { /* best effort */ });
                throw err;
            }
            firstErr ??= err;
        }
    }
    if (firstErr) throw firstErr;
    return done.length;
}

/** The part of a LiveKit Room this needs. */
export interface UpstreamRoomLike {
    localParticipant: {
        audioTrackPublications: Map<string, { track?: { sender?: ActiveSenderLike } | undefined }>;
    };
}

/** Every published local AUDIO sender (mic and screen-share audio). */
export function audioSenders(room: UpstreamRoomLike): ActiveSenderLike[] {
    const out: ActiveSenderLike[] = [];
    room.localParticipant.audioTrackPublications.forEach(pub => {
        const s = pub.track?.sender;
        if (s) out.push(s);
    });
    return out;
}

export async function pauseAudioUpstream(room: UpstreamRoomLike): Promise<boolean> {
    const senders = audioSenders(room);
    if (senders.length === 0) return false;
    await setSendersActive(senders, false);
    // Paused only if every sender really is off now. A sender that could not be switched off (no encodings) means
    // "not paused": switch the rest back on rather than leave the call half-paused with nobody tracking it.
    const off = (s: ActiveSenderLike) => {
        try { const enc = s.getParameters().encodings ?? []; return enc.length > 0 && enc.every(e => e.active === false); } catch { return false; }
    };
    if (senders.every(off)) return true;
    await setSendersActive(senders, true).catch(() => { /* best effort */ });
    return false;
}

export async function resumeAudioUpstream(room: UpstreamRoomLike): Promise<void> {
    await setSendersActive(audioSenders(room), true);
}
