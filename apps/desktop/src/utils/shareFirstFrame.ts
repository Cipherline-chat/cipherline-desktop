/**
 * The size a screen capture REALLY delivers, as opposed to the size its track
 * reports before the first frame has arrived.
 *
 * ── The report (owner, 2026-10-31) ─────────────────────────────────────────
 * Whole-screen shares at "Source" on a 2560x1440 display (scale 1.25, 200 Hz,
 * NVIDIA hardware encoder) killed the renderer (renderer:gone exit=-1073741819,
 * 0xC0000005) 0.2-0.8 s after share_start - five times - and every one of them
 * logged `share_clamp cap_res=3840x2160`: the CAPTURE BOX handed to
 * getDisplayMedia (captureBoxFor clamps the 8K 'source' box to 3840x2160 for
 * the hardware codecs). The shares that survived read cap_res 2560x1440 (the
 * display's real size) or 1920x1080 (a box smaller than the display).
 * Capture never upscales, so no frame is ever 3840x2160: `getSettings()` was
 * reporting the constraint BOX until the first real frame arrived.
 *
 * ── Why that matters (livekit-client 2.18.8) ───────────────────────────────
 * publishTrack() calls track.waitForDimensions(), which returns the moment
 * getSettings() has a width and a height - the box. From that false size it
 * computes the AddTrackRequest width/height and layers, and
 * computeVideoEncodings -> encodingsFromPresets sets the lower layer's
 * scaleResolutionDownBy = min(w,h) / 720: 2160/720 = 3 instead of the real
 * 1440/720 = 2, i.e. a 853x480 (odd width) lighter copy of a hardware encode
 * instead of 1280x720. Our own applyScreenShareSenderParams then re-derives
 * the sender's scales from the same getSettings() (shareLowEncoding,
 * planEncode). replaceTrack() does it again through refreshSenderEncodings().
 * Every one of those is the encoder being configured from a size the capture
 * is not delivering, and then re-configured when the real frames show up.
 *
 * (Whether that, and nothing else, is what takes the renderer down cannot be
 * shown on the Linux dev box: the 0xC0000005 is a Windows hardware-encoder
 * path. What the code establishes is the false size and where it is used.)
 *
 * ── What this module does ──────────────────────────────────────────────────
 *   waitForFirstFrameSize   a hidden <video> on the track; its videoWidth x
 *                           videoHeight is the first real frame. Bounded: on a
 *                           timeout (a static WGC screen can produce nothing
 *                           for a while) the caller carries on exactly as it
 *                           did before - a share is never held up by this.
 *   pinTrackSettingsSize    for the span of publishTrack/replaceTrack, make
 *                           getSettings() on that one track say the real
 *                           size, so LiveKit's own dimension reads are true.
 *   publishScreenShareSettled  createScreenTracks -> wait -> pin -> publish ->
 *                           unpin: setScreenShareEnabled(true) with a wait
 *                           between "capture exists" and "capture is published".
 *
 * Pure of React; DOM objects are injected so it is unit-tested with fakes.
 */
import { Track } from 'livekit-client';
import type { LocalParticipant, LocalTrack, ScreenShareCaptureOptions, TrackPublishOptions } from 'livekit-client';

export interface PixelSize { width: number; height: number }

/** How long a share waits for its first real frame before carrying on as before. */
export const FIRST_FRAME_TIMEOUT_MS = 1500;
const POLL_MS = 25;

const sizeOf = (w: unknown, h: unknown): PixelSize | null =>
    typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
        ? { width: Math.round(w), height: Math.round(h) } : null;

/** "WxH" for a call event ('' when unknown). */
export const fmtSize = (s: PixelSize | null | undefined): string => (s ? `${s.width}x${s.height}` : '');

/** The subset of HTMLVideoElement the wait uses. */
export interface FrameProbeElement {
    srcObject: unknown;
    muted: boolean;
    videoWidth: number;
    videoHeight: number;
    play?: () => Promise<void> | void;
    pause?: () => void;
    addEventListener?: (type: string, fn: () => void) => void;
    removeEventListener?: (type: string, fn: () => void) => void;
}

export interface WaitOptions {
    timeoutMs?: number;
    /** Test seam: the element to probe with. Default: a detached <video>. */
    createElement?: () => FrameProbeElement;
    /** Test seam: wrap the track in a stream. Default: new MediaStream([track]). */
    makeStream?: (track: MediaStreamTrack) => unknown;
}

export type FirstFrameHow = 'frame' | 'timeout' | 'ended' | 'unsupported';
export interface FirstFrame { size: PixelSize | null; ms: number; how: FirstFrameHow }

/**
 * Resolve with the size of the track's first real frame. Never rejects and
 * never waits past `timeoutMs`; `size` is null when no frame was seen (a
 * timeout, an ended track, or no DOM to probe with).
 *
 * The probe only READS: it attaches the track to a muted, detached element and
 * lets go again. It does not stop, clone or constrain the track.
 */
export function waitForFirstFrameSize(track: MediaStreamTrack, opts: WaitOptions = {}): Promise<FirstFrame> {
    const timeoutMs = opts.timeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = () => Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
    let el: FrameProbeElement | null = null;
    try {
        if (opts.createElement) el = opts.createElement();
        else if (typeof document !== 'undefined') el = document.createElement('video') as unknown as FrameProbeElement;
        if (!el) return Promise.resolve({ size: null, ms: 0, how: 'unsupported' });
        const stream = opts.makeStream ? opts.makeStream(track) : new MediaStream([track]);
        el.muted = true;
        el.srcObject = stream;
    } catch {
        return Promise.resolve({ size: null, ms: 0, how: 'unsupported' });
    }
    const probe: FrameProbeElement = el;
    return new Promise<FirstFrame>(resolve => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        const onMeta = () => check();
        const finish = (size: PixelSize | null, how: FirstFrameHow) => {
            if (done) return;
            done = true;
            if (timer !== undefined) clearTimeout(timer);
            if (poll !== undefined) clearInterval(poll);
            try { probe.removeEventListener?.('loadedmetadata', onMeta); probe.removeEventListener?.('resize', onMeta); } catch { /* gone */ }
            try { probe.pause?.(); } catch { /* gone */ }
            try { probe.srcObject = null; } catch { /* gone */ }
            resolve({ size, ms: elapsed(), how });
        };
        const check = () => {
            if (done) return;
            const s = sizeOf(probe.videoWidth, probe.videoHeight);
            if (s) { finish(s, 'frame'); return; }
            if (track.readyState === 'ended') finish(null, 'ended');
        };
        try { probe.addEventListener?.('loadedmetadata', onMeta); probe.addEventListener?.('resize', onMeta); } catch { /* polling covers it */ }
        try { void Promise.resolve(probe.play?.()).catch(() => { /* autoplay refusal: the metadata event still fires */ }); } catch { /* same */ }
        poll = setInterval(check, POLL_MS);
        timer = setTimeout(() => finish(null, 'timeout'), Math.max(0, timeoutMs));
        check();
    });
}

/**
 * Make `track.getSettings()` report `size` as its width and height until the
 * returned function is called. An own property on that one track object: the
 * prototype is untouched, other tracks are unaffected, and releasing deletes it
 * again. A track that cannot take the property is left alone (returns a no-op).
 */
export function pinTrackSettingsSize(track: MediaStreamTrack, size: PixelSize): () => void {
    const original = track.getSettings.bind(track);
    const ownBefore = Object.getOwnPropertyDescriptor(track, 'getSettings');
    try {
        Object.defineProperty(track, 'getSettings', {
            configurable: true,
            writable: true,
            value: () => ({ ...original(), width: size.width, height: size.height }),
        });
    } catch {
        return () => { /* nothing was changed */ };
    }
    return () => {
        try {
            // A real MediaStreamTrack keeps getSettings on its prototype: deleting
            // our own property restores it. Anything that had an own one gets it back.
            if (ownBefore) Object.defineProperty(track, 'getSettings', ownBefore);
            else delete (track as unknown as Record<string, unknown>).getSettings;
        } catch { /* gone */ }
    };
}

export interface SettledCapture {
    /** What the capture was ASKED for (the box). */
    asked?: PixelSize;
    /** What getSettings() said once the capture existed, before any waiting. */
    initial: PixelSize | null;
    /** The first real frame, or null if none arrived in time. */
    first: PixelSize | null;
    /** What getSettings() reports now (after the pin, i.e. what LiveKit sees). */
    reported: PixelSize | null;
    waitMs: number;
    how: FirstFrameHow;
    /** getSettings() was overridden for the publish (it disagreed with the frame). */
    pinned: boolean;
    /** Undo the pin. Idempotent. Call when the publish / replaceTrack is done. */
    release: () => void;
}

/**
 * Wait for the capture's first real frame and make the track tell the truth
 * about its size. `first === null` (timeout) pins nothing: today's behaviour.
 */
export async function settleCaptureSize(track: MediaStreamTrack, asked?: PixelSize, opts: WaitOptions = {}): Promise<SettledCapture> {
    const read = () => { try { const s = track.getSettings(); return sizeOf(s.width, s.height); } catch { return null; } };
    const initial = read();
    const f = await waitForFirstFrameSize(track, opts);
    let release = () => { /* nothing pinned */ };
    let pinned = false;
    if (f.size) {
        const now = read();
        if (!now || now.width !== f.size.width || now.height !== f.size.height) {
            release = pinTrackSettingsSize(track, f.size);
            pinned = true;
        }
    }
    let released = false;
    return {
        asked, initial, first: f.size, reported: read(), waitMs: f.ms, how: f.how, pinned,
        release: () => { if (released) return; released = true; release(); },
    };
}

/**
 * The details of a `share_clamp` event about the size handshake. Keys are
 * <= 31 chars, lowercase (callEventLog KEY_RE); values short strings / numbers.
 * `first_frame=` empty (dropped by the logger) when no frame was seen in time.
 */
export function settleEventDetails(s: SettledCapture): Record<string, string | number | boolean> {
    const d: Record<string, string | number | boolean> = {
        ask: fmtSize(s.asked),
        pub_res: fmtSize(s.initial),
        first_frame: fmtSize(s.first),
        settle: s.how === 'frame' ? (s.pinned ? 'pinned' : 'ok') : s.how,
        settle_ms: s.waitMs,
    };
    return d;
}

/** The subset of LocalParticipant the settled publish uses. */
export type SettledPublishParticipant = Pick<LocalParticipant, 'getTrackPublication' | 'createScreenTracks' | 'publishTrack' | 'setScreenShareEnabled'>;

export interface SettledPublishHooks {
    /** The capture exists and its first frame has been waited for; nothing is published yet. */
    onSettled?: (s: SettledCapture) => void;
    waitOptions?: WaitOptions;
}

/**
 * setScreenShareEnabled(true, capture, publish), with the wait this module is
 * about between "the capture exists" and "it is published": livekit-client
 * reads the track's size inside publishTrack, so by then it must be the real one.
 *
 * Everything else is what LiveKit's setTrackEnabled does for a screen share:
 * createScreenTracks (video, plus the Chromium loopback audio when asked for),
 * publishTrack for each with the same publish options, every track stopped if
 * the publish fails. An already-present screen-share publication keeps the
 * stock behaviour (it just unmutes) - nothing new is captured, nothing to wait for.
 * Returns the settle record (null for that stock path).
 */
export async function publishScreenShareSettled(
    lp: SettledPublishParticipant,
    capture: ScreenShareCaptureOptions,
    publish: TrackPublishOptions,
    hooks: SettledPublishHooks = {},
): Promise<SettledCapture | null> {
    if (lp.getTrackPublication(Track.Source.ScreenShare)) {
        await lp.setScreenShareEnabled(true, capture, publish);
        return null;
    }
    const tracks: LocalTrack[] = await lp.createScreenTracks({ ...capture });
    let settled: SettledCapture | null = null;
    try {
        const video = tracks.find(t => t.kind === Track.Kind.Video);
        const asked = capture.resolution && capture.resolution.width && capture.resolution.height
            ? { width: capture.resolution.width, height: capture.resolution.height } : undefined;
        if (video) {
            settled = await settleCaptureSize(video.mediaStreamTrack, asked, hooks.waitOptions);
            hooks.onSettled?.(settled);
        }
        await Promise.all(tracks.map(t => lp.publishTrack(t, publish)));
    } catch (err) {
        for (const t of tracks) { try { t.stop(); } catch { /* already gone */ } }
        throw err;
    } finally {
        settled?.release();
    }
    return settled;
}
