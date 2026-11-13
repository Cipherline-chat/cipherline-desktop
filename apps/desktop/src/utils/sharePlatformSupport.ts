/**
 * What a screen share can and cannot do on THIS platform, as small pure
 * decisions the share code asks instead of branching on `platform` inline.
 *
 * Written for Linux (2026-11-02). Every answer here is the Windows / macOS
 * behaviour when `viaPortal` is false and the platform is not Linux, which the
 * tests pin.
 *
 * ── The portal (Wayland)
 *
 * On a native Wayland session the capture is a conversation with the desktop's
 * own xdg-desktop-portal ScreenCast chooser, and the chooser opens ONCE PER
 * `ScreenCast.Start`. MEASURED with the shipping Electron 43.8.1 on sway, GNOME
 * and KDE (apps/desktop/harness/linux-share-matrix, `ScreenCast.Start` counted
 * from dbus-monitor; read its README):
 *   - a listing (desktopCapturer.getSources, any types, any combination) is a
 *     Start, and the capture that follows is another: the listing's selection
 *     is NOT held for it (so "list, then capture" is two choosers);
 *   - a capture answered with a made-up id, no listing, is exactly one Start;
 *   - a second capture answered with the SAME id as a running one attaches to
 *     it with no Start at all (so every capture needs a new id, or the user's
 *     second answer is never asked for);
 *   - every changed constraint on a live capture (applyConstraints) is another
 *     Start: 30 -> 60 -> 90 fps cost two extra Starts - a dialog each ONLY on a capture
 *     answered with a made-up id. A capture answered with a LISTED id carries Chromium's
 *     restore token and the backend re-opens it silently (GNOME: 0 dialogs per Start,
 *     counted from the backend's own log; electron/portal-pick.ts).
 * So on the portal:
 *   - nothing lists: the picker takes quality and audio, "Choose what to share…"
 *     starts the capture and the capture's own chooser is the one
 *     (electron/portal-source.ts, src/utils/portalSource.ts);
 *   - the capture is opened at the quality the person PICKED (portalCaptureRequest), not at the
 *     monitor's maximum with the encoder throwing frames away. A live fps / size change then
 *     either re-opens the capture (a desktop whose portal restores a listed source with no
 *     dialog: GNOME, measured) or, where that is not known, lives on the RTP sender unless it
 *     needs more than the capture was asked for (portalCapturePlan.ts);
 *   - a probe capture ("does this new source open?") would be a second chooser
 *     for one change of source: skipped (shouldProbeNewSource);
 *   - the chooser is a person, not a handshake: the 10 s that is generous for
 *     main to answer is not for someone reading a dialog (captureHandshakeMs);
 *   - a dialog the user closed is an answer, not a failure to retry
 *     (cancelStopsSwap): retrying re-opens it and, worse, would first tear the
 *     running share down;
 *   - a restart the app does by itself (encoder stall, codec drift, a hardware
 *     encoder rule, audio on or off) must not capture again with nobody there to
 *     answer (canReuseLiveCapture): the live capture is cloned instead, and the
 *     consent its audio rides on is renewed in main (capture-consent.continueLive);
 *   - a change of source is one more capture, asked for while the running share
 *     is left alone (shouldAcquireBeforeTeardown).
 */
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';
import { sameShareLayout } from './shareLiveRetune';
import { captureBoxFor, portalCaptureFps, type ScreenShareCodec } from './screenShare';

/** How long a capture handshake that needs only main's cooperation may take. */
export const SHARE_HANDSHAKE_MS = 10_000;
/** …and one that may be waiting on a person answering the desktop's chooser. */
export const PORTAL_HANDSHAKE_MS = 120_000;

export function captureHandshakeMs(viaPortal: boolean): number {
    return viaPortal ? PORTAL_HANDSHAKE_MS : SHARE_HANDSHAKE_MS;
}

/**
 * Through the portal getDisplayMedia RESOLVES at once, before the desktop has been asked anything: the
 * capture's own portal session - the chooser - starts when the first sink attaches (measured, Electron
 * 43.8.1: a resolved capture, no frames, no Start, until something reads it). So "the capture is here"
 * means nothing until its FIRST FRAME is: that is the moment the user has answered. Everything that
 * acts on a fresh portal capture (publish it, swap it in, tear the old share down for it) waits for it
 * - for as long as a person may take (PORTAL_HANDSHAKE_MS) - and a capture that never gets one (the
 * dialog closed: the track ends with no frames, measured; or nobody answered) is a CANCEL, not a share
 * that is "not capturing anything" (shareHealth's capture-stall notice would blame a game in fullscreen).
 */
export const PORTAL_FIRST_FRAME_WAIT = { timeoutMs: PORTAL_HANDSHAKE_MS } as const;

/** The error for a portal capture whose chooser ended without a source: a NotAllowedError, i.e. "cancelled" on Linux (cancelStopsSwap, describeShareStartError). */
export function portalChooserClosedError(): Error {
    return Object.assign(new Error('The desktop’s screen chooser was closed without a choice'), { name: 'NotAllowedError' });
}

/** A change of source opens the new one once, first, to prove it - except through the portal (see above). */
export function shouldProbeNewSource(viaPortal: boolean): boolean {
    return !viaPortal;
}

/**
 * The hot swap's capture was refused with NotAllowedError. Through the portal that
 * is the user closing the chooser: stop, leave the running share as it is. Elsewhere
 * it keeps the existing behaviour (fall back to the republish path, which fails the
 * same way and reports it).
 */
export function cancelStopsSwap(viaPortal: boolean, err: unknown): boolean {
    return viaPortal && (err as { name?: unknown } | null)?.name === 'NotAllowedError';
}

export interface ReuseCaptureInput {
    viaPortal: boolean;
    /** A fresh publication is being made (new sender, new encoder). */
    fresh: boolean;
    /** A share is live right now. */
    live: boolean;
    cur: ScreenShareOptions | null;
    next: ScreenShareOptions;
    /** The live share's capture track is still running. */
    trackLive: boolean;
    /** The share is drawn through our own crop / HDR pipeline (its track is generated, not captured). */
    ownPipeline: boolean;
}

/**
 * Can this fresh republish re-use the capture that is already running, instead of
 * asking the OS for another? Only through the portal (elsewhere a second capture is
 * free and stays exactly as it was), and only for the SAME source and layout.
 *
 * Audio does not matter: through the portal (Linux) the share's audio is the native
 * PipeWire capture, a separate publication that is not part of the capture request
 * (electron/share-platform.ts chromiumLoopbackAudioMode: Chromium never carries Linux
 * system audio), so turning it on or off, or changing the app it comes from, never needs
 * a new capture. What a reused capture must not skip is the CONSENT its audio rides on:
 * the caller renews it through main (captureGrant.continueCaptureGrant), which continues
 * the live source's own consent and nothing else - a new source is a new capture and a
 * new consent. Nothing here widens what is captured: the clone is the very source the
 * user already chose.
 */
export function canReuseLiveCapture(i: ReuseCaptureInput): boolean {
    if (!i.viaPortal || !i.fresh || !i.live || !i.cur || !i.trackLive || i.ownPipeline) return false;
    if (i.cur.sourceId !== i.next.sourceId) return false;
    if (i.cur.layout?.kind === 'slice' || i.next.layout?.kind === 'slice') return false;
    return sameShareLayout(i.cur.layout, i.next.layout);
}

export interface AcquireFirstInput {
    viaPortal: boolean;
    /** A share is live right now. */
    live: boolean;
    cur: ScreenShareOptions | null;
    next: ScreenShareOptions;
    /**
     * The live share is the NATIVE (hardware) one and may start again natively. Its replacement opens its own portal capture through the
     * helper, so a Chromium capture acquired first would be a second chooser AND would hand the republish a capture to reuse, which skips
     * the native start and silently drops the share to software VP8 (reports af77b854 / eb4a0d66, 2026-11-11).
     */
    nativeLive?: boolean;
}

/**
 * A change of SOURCE that is going to be a fresh publication (a hardware encoder never
 * takes a hot swap, see shareLiveRetune.sourceSwapNeedsFresh): through the portal, ask the
 * desktop for the new capture FIRST, while the running share and its viewers are left
 * alone. The republish tears the old share down and viewers hold their place for 6 s
 * (utils/shareHold.ts) - a person reading the chooser takes longer than that, and a
 * chooser they close would have cost them the share they had. Acquired first, the dialog
 * costs nobody anything, a cancel changes nothing, and the hold only has to cover the real
 * teardown and publish. Everywhere else the capture is as quick as it ever was and stays
 * where it is (inside the republish).
 */
export function shouldAcquireBeforeTeardown(i: AcquireFirstInput): boolean {
    return i.viaPortal && i.live && !i.nativeLive && !!i.cur && i.cur.sourceId !== i.next.sourceId;
}

export interface ReuseCropCaptureInput {
    viaPortal: boolean;
    live: boolean;
    cur: ScreenShareOptions | null;
    next: ScreenShareOptions;
    /** The share is drawn through the crop pipeline (and not the HDR one). */
    cropPipeline: boolean;
    hdrPipeline: boolean;
}

/**
 * A single screen of an ultra-wide display that produced nothing falls back to the whole
 * display of the SAME source. Through the portal that must not capture again with nobody
 * to answer the chooser: the crop pipeline's own capture is the whole display already
 * (the crop is applied to its frames), so it can be kept - but only if the capture itself
 * is delivering (the caller checks that against a real frame, never against the crop's
 * counters: the stall may be the capture's, and then a clone is just as dead and the
 * fresh capture the fallback exists for is the point). Audio is not part of the capture
 * here either (see canReuseLiveCapture).
 */
export function canReuseCropCapture(i: ReuseCropCaptureInput): boolean {
    if (!i.viaPortal || !i.live || !i.cur || !i.cropPipeline || i.hdrPipeline) return false;
    if (i.cur.sourceId !== i.next.sourceId) return false;
    return i.cur.layout?.kind === 'slice' && i.next.layout?.kind !== 'slice';
}

/**
 * Does a LIVE quality change (frame rate, resolution, a step-down) reach the CAPTURE?
 *
 * Off the portal it does, as it always did: the capturer is retargeted with
 * applyConstraints() and the sender is retuned after it. Through the portal it depends
 * on whether the new session is a dialog - portalCapturePlan.portalRetuneTouchesCapture
 * (it needs what the capture was last asked for). This is the portal-free half.
 */
export function retuneTouchesCapture(viaPortal: boolean): boolean {
    return !viaPortal;
}

/** The capture a share through the portal is opened with. */
export interface PortalCaptureRequest {
    /** The box the capture must fit in: the source's native size, held to what the codec can encode. */
    box: { width: number; height: number };
    /** The capture rate: the picked one (screenShare.portalCaptureFps). */
    frameRate: number;
}

/**
 * What to ask the portal's capture for: the SOURCE's own size (the 'source' box, held to what the codec can encode)
 * at the frame rate the person CHOSE.
 *
 * Not the picked size. A capture opened at a downscaled box is scaled inside the capturer, and that measured slower:
 * fresh 1080p@90 shares of a 3440x1440 screen were captured at 1920x804 and delivered 19-44 fps with
 * `no_capture`, where a source-size capture delivered 59-75 and a 1080p retune of it 60-73 (reports 87a453ae /
 * 6a325d4e). So the picked resolution is the ENCODER's (scaleResolutionDownBy, applyScreenShareSenderParams with the
 * user's box) and changing it never re-opens the capture (portalCapturePlan: a re-open stalls the capture, 0.9-1.2 s
 * measured idle on KDE, 10-20 s in the owner's reports).
 *
 * The frame rate stays the chosen one, not the monitor's maximum: a capture opened at full rate is paid for in full
 * (the compositor, the PipeWire copy and the pipeline) while the encoder throws most of it away. `ceiling` is the
 * capturer's own limit (electron/capture-flags.ts captureFpsCeiling: 60 on Wayland except KDE), `null` = none.
 */
export function portalCaptureRequest(
    choice: { resolution: ScreenShareOptions['resolution']; frameRate: ScreenShareOptions['frameRate'] },
    ceiling: number | null,
    codec: ScreenShareCodec = 'h264',
): PortalCaptureRequest {
    return {
        box: captureBoxFor('source', codec),
        frameRate: portalCaptureFps(choice.frameRate, ceiling),
    };
}

/**
 * The capturer's own frame-rate ceiling (main's display:get-refresh-rates `captureFpsCeiling`), or
 * null for none / unknown. Asked where a portal capture is requested before the share's diagnostics exist.
 */
export async function readCaptureCeiling(
    api: { getDisplayRefreshRates?: () => Promise<Array<{ captureFpsCeiling?: number | null }>> } | undefined =
        typeof window !== 'undefined' ? window.electronAPI : undefined,
): Promise<number | null> {
    try {
        const displays = await api?.getDisplayRefreshRates?.();
        const n = Math.max(0, ...(displays ?? []).map(d => d.captureFpsCeiling || 0));
        return n > 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * Why "Share system audio" is not available here, or null when it is.
 *
 * Linux used to refuse outright: Chromium's loopback there would include Cipherline's own
 * voices (no per-app exclusion), and the mute that avoids that never settles
 * (electron/share-platform.ts chromiumLoopbackAudioMode, measured). Audio on Linux now comes
 * from the native PipeWire addon instead (src-native/audio_capture_linux.cc), which listens to
 * every app EXCEPT our own process tree. So on Linux the answer is whatever the addon says:
 * `nativeAudioSupported` is main's `audio:is-capture-supported` (the library loads, the daemon
 * answers, an audio sink exists). Everywhere else audio is always on offer (native addon or
 * Chromium loopback), so the answer is null and the argument is ignored.
 */
export function shareAudioUnavailableReason(platform: string | undefined, nativeAudioSupported = false): string | null {
    if (platform !== 'linux') return null;
    return nativeAudioSupported
        ? null
        : 'Sharing audio on Linux needs PipeWire, which isn’t running on this computer.';
}

/**
 * The notice for a WINDOW share whose owning process could not be found, so its audio cannot be
 * picked out. On Linux that is the normal case for a Wayland (portal) window: the desktop hands
 * over pixels, not a process. Said honestly, with the way out.
 */
export function windowAudioUnresolvedNotice(platform: string | undefined): string {
    return platform === 'linux'
        ? 'This desktop doesn’t say which app a window belongs to, so no app was chosen for its audio. Use Change source to pick the app, or share the whole screen to include audio. Sharing without audio.'
        : 'Could not identify the window\'s process for audio capture. Sharing without audio.';
}

/**
 * Does this pick get the "Share audio from: [app]" chooser instead of a "Share system audio" box?
 * Only a WINDOW through the desktop's portal (Wayland), where the window comes with no owning process, so
 * its audio can only be named by the app that plays it (electron/app-audio.ts). `viaPortal` null (not
 * known yet) counts as the portal, like the rest of the Linux picker. X11 windows keep the automatic pid
 * route and whole screens keep "everything except Cipherline".
 */
export function windowAudioPicksApp(
    platform: string | undefined, viaPortal: boolean | null, isWindowSource: boolean,
): boolean {
    return platform === 'linux' && isWindowSource && viaPortal !== false;
}

/**
 * Said in the picker BEFORE the share, not after, when a portal window's audio cannot be offered at all:
 * a window picked through the desktop's portal (Wayland) comes with no owning process, so the only way to
 * its audio is to pick the app (windowAudioPicksApp). `canPickApp` says main can list apps; when it cannot
 * (an older main), the box is shown off with this reason instead of being ticked and silently doing
 * nothing. Null = no objection.
 */
export function windowAudioBlockedReason(
    platform: string | undefined, viaPortal: boolean | null, isWindowSource: boolean, canPickApp = false,
): string | null {
    if (!windowAudioPicksApp(platform, viaPortal, isWindowSource) || canPickApp) return null;
    return 'This desktop doesn’t say which app a window belongs to, so a window’s audio can’t be shared. Share the whole screen to include audio.';
}

interface CapturePathApi { platform?: string; getShareCapturePath?: () => Promise<{ viaPortal: boolean; restoreListed?: boolean }> }
let portalProbe: Promise<{ viaPortal: boolean; restoreListed: boolean }> | null = null;

function probeCapturePath(api: CapturePathApi | undefined): Promise<{ viaPortal: boolean; restoreListed: boolean }> {
    if (!api || api.platform !== 'linux' || typeof api.getShareCapturePath !== 'function') return Promise.resolve({ viaPortal: false, restoreListed: false });
    if (!portalProbe) {
        portalProbe = api.getShareCapturePath().then(
            r => ({ viaPortal: r?.viaPortal === true, restoreListed: r?.viaPortal === true && r?.restoreListed === true }),
            () => ({ viaPortal: false, restoreListed: false }),
        );
    }
    return portalProbe;
}

/**
 * Does a capture here go through the desktop's portal chooser? Asked of main once
 * per run (cached); false off Linux without asking, and false when main cannot say.
 */
export function captureViaPortal(api: CapturePathApi | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined): Promise<boolean> {
    return probeCapturePath(api).then(r => r.viaPortal);
}

/** Does that portal re-open a source the share listed with no dialog (capture-flags.ts portalRestoreMode)? Same probe, same cache. */
export function portalRestoreListed(api: CapturePathApi | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined): Promise<boolean> {
    return probeCapturePath(api).then(r => r.restoreListed);
}

export function resetCaptureViaPortalForTests(): void { portalProbe = null; }
