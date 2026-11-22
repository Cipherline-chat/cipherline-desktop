/**
 * "The share runs at 56 fps because that is all the CAPTURE delivers" - and
 * nothing told the user.
 *
 * Owner reports 884b6045 (window share of BeamNG, WGC) and 438f97a1 (screen
 * share, DXGI), 1.0.24-staging.178: asked for 90 fps on a 200 Hz display, the
 * hardware encoder was healthy (enc_fps 84-88, `limit=none`) but the capturer
 * handed it 53-58 frames a second the whole time the game was in front, so
 * viewers got "60 or less". Nothing in the encoder, the codec or the network
 * can add frames the capture never delivered (a windowed game's presented
 * frames, DWM composition, a frame cap or V-Sync inside the game). The share
 * stayed silent about it; the owner found out from viewers.
 *
 * This says it, once per share and only when the evidence is unambiguous:
 *   - the share asks for >= 60 fps;
 *   - a program covers the shared screen (a game in front) and Cipherline is
 *     NOT focused (a static desktop or Cipherline's own window delivers 1-13
 *     fps by design - nothing to report);
 *   - the capture delivers a steady MIDDLE rate: at least MIN_FPS (a collapse
 *     to 1-10 fps is the fullscreen-game problem, which has its own hint) and
 *     at most 80 % of the target;
 *   - the encoder keeps up with that capture (>= 90 % of it) and the sender is
 *     not limited by CPU or bandwidth - so the capture IS the limit;
 *   - on CAPTURE_BOUND_SAMPLES consecutive samples whose rates sit within
 *     SPREAD_FPS of each other (~30 s at the 10 s sampler).
 *
 * Report b3128344 (0.1.2): a full-screen DXGI share of a 3440x1440@165 Hz display, 60 fps picked, Cipherline FOCUSED and
 * nothing covering the screen - capture 18-27 fps (app log `share_tx_ring why: src`), encoder and sender keeping pace, no
 * limitation, bandwidth to spare. DXGI emits a frame only when the screen CHANGES, so the content itself (a ~24-30 fps video
 * or page) set the rate, and the game-in-front rule above stayed silent for two reasons (focused, nothing covering) and a
 * third (the rate dipped under 24). The CONTENT variant below covers that: same "capture is the limit" evidence, but no
 * game-in-front / not-focused requirement, a lower floor (CONTENT_MIN_FPS, still above a static desktop's 1-13 fps), and
 * the words say the screen isn't changing faster, not "your game". Sustained over CONTENT_SAMPLES samples (>= 10 s each),
 * once per share.
 * Numbers in, a verdict out: the caller shows the notice and logs nothing new
 * (the numbers are already in share_fps).
 */

export const CAPTURE_BOUND_SAMPLES = 3;
export const CAPTURE_BOUND_MIN_FPS = 24;
export const CAPTURE_BOUND_SPREAD_FPS = 12;
export const CAPTURE_BOUND_MAX_RATIO = 0.8;
export const CAPTURE_BOUND_ENCODER_RATIO = 0.9;
/** The content variant: floor above a static desktop (1-13 fps by design), and consecutive 10 s samples required. */
export const CAPTURE_CONTENT_MIN_FPS = 15;
export const CAPTURE_CONTENT_SAMPLES = 2;

export interface CaptureBoundSample {
    targetFps: number;
    srcFps?: number;
    encFps?: number;
    /** qualityLimitationReason ('' when absent). */
    limit?: string;
    /** A program covers the shared screen / window. */
    fgCover: boolean | '' | undefined;
    /** Cipherline's own window has focus. */
    focused: boolean;
    /**
     * The shared picture is ultra-wide (Surround / Eyefinity, 7680x1440 and the like): every
     * frame is 3x the pixels of a 1440p one to read back and scale, so the capture is the limit
     * even with no game in front (report 6b3ddab6: a flat 30 fps on a 180 Hz 7680x1440 display,
     * Cipherline focused or not). A wide surface therefore needs neither the game-in-front nor
     * the not-focused condition - the steady-middle-rate and encoder-keeps-up ones still apply.
     */
    wide?: boolean;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Does this single sample say "the capture is the limit"? */
export function isCaptureBound(s: CaptureBoundSample): boolean {
    if (!(s.targetFps >= 60)) return false;
    if (!s.wide && (s.focused || s.fgCover !== true)) return false;
    if (s.limit === 'cpu' || s.limit === 'bandwidth') return false;
    if (!fin(s.srcFps) || !fin(s.encFps)) return false;
    if (s.srcFps < CAPTURE_BOUND_MIN_FPS || s.srcFps > CAPTURE_BOUND_MAX_RATIO * s.targetFps) return false;
    return s.encFps >= CAPTURE_BOUND_ENCODER_RATIO * s.srcFps;
}

/**
 * Does this sample say "the CONTENT sets the rate" (report b3128344)? Like isCaptureBound but with no game-in-front /
 * not-focused condition: a share that asks for >= 60 fps, a capture delivering a middle rate (>= CAPTURE_CONTENT_MIN_FPS,
 * <= 80 % of the target), the encoder keeping up with it, and no CPU / bandwidth limit.
 */
export function isContentLimited(s: CaptureBoundSample): boolean {
    if (!(s.targetFps >= 60)) return false;
    if (s.limit === 'cpu' || s.limit === 'bandwidth') return false;
    if (!fin(s.srcFps) || !fin(s.encFps)) return false;
    if (s.srcFps < CAPTURE_CONTENT_MIN_FPS || s.srcFps > CAPTURE_BOUND_MAX_RATIO * s.targetFps) return false;
    return s.encFps >= CAPTURE_BOUND_ENCODER_RATIO * s.srcFps;
}

/** One per share. Feed every share_fps sample; returns the rate to tell the user about, once. */
export class CaptureBoundWatch {
    private run: number[] = [];
    private contentRun: number[] = [];
    private told = false;

    observe(s: CaptureBoundSample): { fps: number; cause: 'game' | 'content' } | null {
        if (this.told) return null;
        // Content variant first only when the game-in-front evidence is absent (that has its own, more specific words).
        if (!isCaptureBound(s)) {
            this.run = [];
            if (!isContentLimited(s)) { this.contentRun = []; return null; }
            this.contentRun.push(s.srcFps as number);
            if (this.contentRun.length > CAPTURE_CONTENT_SAMPLES) this.contentRun.shift();
            if (this.contentRun.length < CAPTURE_CONTENT_SAMPLES) return null;
            if (Math.max(...this.contentRun) - Math.min(...this.contentRun) > CAPTURE_BOUND_SPREAD_FPS) return null;
            this.told = true;
            return { fps: Math.round(this.contentRun.reduce((a, b) => a + b, 0) / this.contentRun.length), cause: 'content' };
        }
        this.contentRun = [];
        this.run.push(s.srcFps as number);
        if (this.run.length > CAPTURE_BOUND_SAMPLES) this.run.shift();
        if (this.run.length < CAPTURE_BOUND_SAMPLES) return null;
        if (Math.max(...this.run) - Math.min(...this.run) > CAPTURE_BOUND_SPREAD_FPS) return null;
        this.told = true;
        const mean = this.run.reduce((a, b) => a + b, 0) / this.run.length;
        return { fps: Math.round(mean), cause: 'game' };
    }
}

export type ShareKind = 'screen' | 'window' | 'unknown';

/** `screen:<n>:<m>` -> 'screen', `window:...` -> 'window'. */
export function shareKindOf(sourceId: string | undefined | null): ShareKind {
    if (typeof sourceId !== 'string') return 'unknown';
    if (sourceId.startsWith('screen:')) return 'screen';
    if (sourceId.startsWith('window:')) return 'window';
    return 'unknown';
}

/**
 * The words for the notice. A WINDOW share is always Windows.Graphics.Capture
 * (electron/capture-flags.ts: slower grabs than the DXGI screen capturer) -
 * and on the same PC the same game's SCREEN share delivered 88-89 fps
 * (reports 438f97a1 / 479af6c7) - so for a window the actionable advice is
 * "share the screen"; for a screen it is the game's own frame rate.
 */
export function captureBoundNotice(fps: number, targetFps: number, kind: ShareKind = 'unknown', wide = false, platform: string | undefined = 'windows', cause: 'game' | 'content' = 'game'): string {
    if (cause === 'content') {
        return `Sharing at ~${fps} fps — your ${kind === 'window' ? 'window' : 'screen'} isn’t changing faster than that, so there are no more frames to send. Motion on screen (video, scrolling, a game) sets the pace; it isn’t your connection.`;
    }
    const onWindows = platform === 'windows' || platform === undefined;
    const what = kind === 'window' ? 'window' : 'screen';
    const head = `Your ${what} is only producing about ${fps} new frames per second here, so viewers can’t get ${targetFps}. `;
    if (wide) {
        // Not the game's frame rate: a display this wide is several times the pixels of a normal one and
        // the capturer has to read back and scale every frame (the share of one screen of it still captures all of it).
        return head + 'A display this wide has several times the pixels of a normal one to capture every frame, and that is most likely the limit - not your game or connection. A smaller display or window captures faster.';
    }
    return kind === 'window'
        ? head + (onWindows
            ? 'Capturing a window is slower than capturing the whole screen on Windows - share the screen to go higher.'
            : 'Capturing a window can be slower than capturing the whole screen - share the screen to go higher.')
        : head + 'That is usually the game’s own frame rate (a frame cap, V-Sync or windowed mode), not Cipherline or your connection.';
}
