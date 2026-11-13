/**
 * H.265 (HEVC) only when EVERYONE in the room can decode it.
 *
 * Why negotiated: under E2EE livekit-client disables backup codecs
 * (LocalParticipant: "TODO remove this once e2ee is supported for backup
 * codecs") and the SFU never transcodes, so one participant who cannot decode
 * H.265 would see a black tile. The Android app (react-native-webrtc 144) has
 * no HEVC decoder at all; Chromium's HEVC is hardware-only on both ends.
 *
 * Mechanism:
 *   1. Every desktop client probes its own HEVC DECODE (RTCRtpReceiver
 *      capabilities list video/H265 — Chromium only lists it with a hardware
 *      decoder — AND MediaCapabilities.decodingInfo says supported) and
 *      advertises it in its LiveKit participant ATTRIBUTES under
 *      HEVC_ATTR = "cl.vdec", value "1:h265" or "1:" (format version 1, then
 *      the optional codecs it decodes). Codec capability only — nothing
 *      identifying. Clients that never set it (mobile, older desktop) count as
 *      NOT capable.
 *   2. A publisher uses H.265 for its camera (and a screen share started while
 *      everyone qualifies) only when its own HARDWARE encoder supports it
 *      (sender capabilities + encodingInfo powerEfficient), the post-start
 *      check confirms a hardware encoder produced frames, H.265 has not
 *      failed this session, and every remote participant advertises decode.
 *   3. HevcPolicy decides switches with hysteresis: someone who cannot decode
 *      joins → back to H.264/VP8 AT ONCE (after a 2 s grace for a desktop
 *      client's attribute to arrive); they leave → H.265 again only after
 *      everyone has qualified for 30 s, and at most one switch per 20 s.
 *      Switching reuses the make-before-break republish of the 1:1 layering
 *      change (cameraPublish.republishCamera).
 *
 * Bitrate: the camera ladder at 0.85× VP8 for H.265 vs 1.15× for H.264 —
 * ~26 % below the H.264 ladder (cameraQuality.CODEC_FACTOR).
 */

import { logCallEvent } from './callEventLog';

export const HEVC_ATTR = 'cl.vdec';
export const HEVC_ATTR_VERSION = '1';
/**
 * How long a peer may advertise nothing before it counts as unable to decode. In
 * the 21 days of reports to 2026-11-09, all 23 joins reached "everyone capable"
 * with a median of 0.6 s, p95 0.9 s, max 1.7 s, so raising this would only make
 * a phone, which never advertises, wait longer for a picture it can decode.
 */
export const HEVC_JOIN_GRACE_MS = 2_000;
export const HEVC_UP_MS = 30_000;
export const HEVC_MIN_GAP_MS = 20_000;

/** The attribute value a client advertises. */
export function formatDecodeCaps(caps: { h265: boolean }): string {
    return `${HEVC_ATTR_VERSION}:${caps.h265 ? 'h265' : ''}`;
}

/** Parse a peer's attribute; null = not advertised / unknown format (not capable). */
export function parseDecodeCaps(v: string | undefined | null): { h265: boolean } | null {
    if (typeof v !== 'string' || v.length > 64) return null;
    const m = /^(\d+):([a-z0-9,]*)$/.exec(v);
    if (!m || m[1] !== HEVC_ATTR_VERSION) return null;
    return { h265: m[2].split(',').includes('h265') };
}

export interface RemoteCaps {
    /** The peer's HEVC_ATTR value, if any. */
    attr?: string;
    /** ms since this participant joined (for the attribute grace). */
    joinedMsAgo: number;
}

export type RoomHevcState = 'all' | 'incapable' | 'pending' | 'alone';

/** Can everyone else in the room decode H.265? */
export function roomHevcState(remotes: readonly RemoteCaps[]): RoomHevcState {
    if (remotes.length === 0) return 'alone';
    let pending = false;
    for (const r of remotes) {
        const caps = parseDecodeCaps(r.attr);
        if (caps?.h265) continue;
        if (caps === null && r.joinedMsAgo < HEVC_JOIN_GRACE_MS) { pending = true; continue; }
        return 'incapable';
    }
    return pending ? 'pending' : 'all';
}

/**
 * Each remote's attribute plus how long THIS SESSION of it has been here, keeping
 * `firstSeen` to the sessions still present. Keyed by session (LiveKit's participant
 * sid), not identity: someone who rejoins, or comes back from a full reconnect, keeps
 * the identity and loses the attribute, and timing them from their first appearance
 * made a viewer who was merely on their way back count as unable to decode at once.
 */
export function remoteCapsAtTick(
    firstSeen: Map<string, number>,
    peers: readonly { sessionKey: string; attr?: string }[],
    now: number,
): RemoteCaps[] {
    const live = new Set<string>();
    const remotes = peers.map(p => {
        live.add(p.sessionKey);
        if (!firstSeen.has(p.sessionKey)) firstSeen.set(p.sessionKey, now);
        return { attr: p.attr, joinedMsAgo: now - (firstSeen.get(p.sessionKey) ?? now) };
    });
    for (const key of [...firstSeen.keys()]) if (!live.has(key)) firstSeen.delete(key);
    return remotes;
}

/** Capable / total, for the call log (counts only). */
export function hevcCapableCount(remotes: readonly RemoteCaps[]): { capable: number; total: number } {
    return { capable: remotes.filter(r => parseDecodeCaps(r.attr)?.h265).length, total: remotes.length };
}

export type HevcMode = 'h265' | 'base';

/**
 * Should the SCREEN SHARE be H.265 right now? The camera follows the policy's
 * mode (30 s of everyone qualifying, so it never flaps); a share does not need
 * that wait. Before this, a share started while the room had qualified for
 * under 30 s began on H.264 and was republished as H.265 the moment the timer
 * ran out - a second publish, a second bitrate ramp and a visible gap in the
 * first seconds (reports 923a0b23 / dd3e84e3: sent 11 fps / 568 kbps after
 * 10 s, then 5 -> 88 fps after the switch). A share that begins while every
 * remote participant can decode H.265 simply begins on it; anyone who cannot
 * (or being alone) still means the normal codec at once.
 */
export function shareWantsHevc(mode: HevcMode, state: RoomHevcState, allowed: boolean): boolean {
    if (!allowed || state === 'incapable' || state === 'alone') return false;
    return mode === 'h265' || state === 'all';
}

/**
 * Should a share that is ALREADY LIVE be H.265 right now? shareWantsHevc answers for
 * a share about to start, where "not sure yet" or "nobody here" rightly means the
 * normal codec. Applied to a live share the same answer is a republish. Reports
 * 566966f4 / c704ba3e: the only viewer left and rejoined 3.7 s later; the empty room
 * moved the share to H.264 (logged as "someone cannot decode H.265", though nobody
 * was there) and their return moved it straight back, holding their picture for 2.5 s.
 * The same question also moves it for anyone joining while the camera's 30 s timer
 * is running (mode 'base'): 'pending' -> false, and back once their attribute lands.
 *
 * Nobody is known to need a change while a join is unresolved or the room is empty,
 * so the share stays as it is. Only a real answer moves it.
 */
export function liveShareWantsHevc(isH265: boolean, state: RoomHevcState, allowed: boolean): boolean {
    if (!allowed || state === 'incapable') return false;
    if (state === 'all') return true;
    return isH265;
}

/** Why `allowed` is false in SidebarConference's loop ('' when it is true); logged as h265_caps.blocked. */
export type HevcBlocked = '' | 'setting_off' | 'no_hw_encode' | 'gpu_lost' | 'failed_earlier';

/**
 * The `reason` an h265_switch is logged with, from what actually caused it. Every move
 * off H.265 used to say "someone cannot decode H.265" unless H.265 had failed or the
 * GPU had reset, so the setting being switched off and an empty room both read as a
 * viewer who could not decode. In the 21 days of reports to 2026-11-09 that was every
 * one of them: 2 rows for an empty room, 2 for the setting, none for a real viewer.
 */
export function hevcSwitchReason(toH265: boolean, blocked: HevcBlocked | string, state: RoomHevcState): string {
    if (toH265) return 'everyone can decode H.265';
    switch (blocked) {
        case 'gpu_lost': return 'graphics driver reset';
        case 'failed_earlier': return 'H.265 failed';
        case 'setting_off': return 'H.265 turned off in settings';
        case 'no_hw_encode': return 'no hardware H.265 encoder';
    }
    if (state === 'alone') return 'nobody else in the call';
    return 'someone cannot decode H.265';
}

export class HevcPolicy {
    private current: HevcMode;
    private allSince: number | null = null;
    private lastSwitch = -Infinity;

    constructor(current: HevcMode) { this.current = current; }

    get mode(): HevcMode { return this.current; }

    reset(mode: HevcMode): void { this.current = mode; }

    /**
     * `allowed` = the setting allows it, this machine HW-encodes H.265, and it
     * has not failed this session. Returns the mode to switch to now, or null.
     */
    observe(state: RoomHevcState, allowed: boolean, now: number): HevcMode | null {
        if (state === 'all') { if (this.allSince === null) this.allSince = now; } else if (state !== 'pending') this.allSince = null;
        if (this.current === 'h265') {
            // Down: immediately (someone would see black), no min gap.
            if (!allowed || state === 'incapable' || state === 'alone') return 'base';
            return null;
        }
        if (!allowed || state !== 'all' || this.allSince === null) return null;
        if (now - this.allSince < HEVC_UP_MS) return null;
        if (now - this.lastSwitch < HEVC_MIN_GAP_MS) return null;
        return 'h265';
    }

    applied(mode: HevcMode, now: number): void {
        this.current = mode;
        this.lastSwitch = now;
    }
}

// ── Probes ─────────────────────────────────────────────────────────────────

type CodecList = { codecs?: { mimeType: string }[] } | null | undefined;
const listsH265 = (l: CodecList) => !!l?.codecs?.some(c => /^video\/h265$/i.test(c.mimeType));

export interface HevcProbeDeps {
    senderCaps?: () => CodecList;
    receiverCaps?: () => CodecList;
    encodingInfo?: (c: unknown) => Promise<{ supported: boolean; powerEfficient: boolean }>;
    decodingInfo?: (c: unknown) => Promise<{ supported: boolean; powerEfficient: boolean }>;
}

const H265_CFG = { contentType: 'video/H265', width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 };

/** This machine can DECODE H.265 in WebRTC (hardware — Chromium has no software HEVC). */
export async function probeHevcDecode(deps: HevcProbeDeps = {}): Promise<boolean> {
    // A stream's decoder already died this session (markHevcDecodeFailed): the
    // capability lists still say yes, which is exactly what they said before it died.
    if (hasHevcDecodeFailed()) return false;
    try {
        const rc = deps.receiverCaps ?? (() => (typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : null));
        if (!listsH265(rc())) return false;
        const di = deps.decodingInfo ?? (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.decodingInfo
            ? (c: unknown) => navigator.mediaCapabilities.decodingInfo(c as MediaDecodingConfiguration) : undefined);
        if (!di) return true; // capabilities already imply a hardware decoder
        const r = await di({ type: 'webrtc', video: H265_CFG });
        return !!r.supported;
    } catch {
        return false;
    }
}

/** This machine can ENCODE H.265 in hardware. */
export async function probeHevcEncode(deps: HevcProbeDeps = {}): Promise<boolean> {
    try {
        const sc = deps.senderCaps ?? (() => (typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null));
        if (!listsH265(sc())) return false;
        const ei = deps.encodingInfo ?? (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.encodingInfo
            ? (c: unknown) => navigator.mediaCapabilities.encodingInfo(c as MediaEncodingConfiguration) : undefined);
        if (!ei) return false;
        const r = await ei({ type: 'webrtc', video: H265_CFG });
        return !!(r.supported && r.powerEfficient);
    } catch {
        return false;
    }
}

/**
 * H.265 failed to start (or fell to software): off for HEVC_RETRY_MS, then it
 * may be negotiated again (the next share / camera publish; the room policy
 * re-evaluates within a second). It used to be "until restart": one failed
 * encoder re-open (reports c344523e / 45a5e136: a resolution retune left the
 * sender on VP8) kept the share AND the camera off H.265 for the whole app
 * session. A fresh failure re-arms the window; the GPU-lost latch below is
 * unchanged. `now` is injectable so the window is testable without timers.
 */
export const HEVC_RETRY_MS = 12 * 60_000;
let hevcFailedAt: number | null = null;
export function markHevcFailed(now: number = Date.now()): void { hevcFailedAt = now; }
export function hasHevcFailed(now: number = Date.now()): boolean {
    if (hevcFailedAt === null) return false;
    if (now - hevcFailedAt < HEVC_RETRY_MS) return true;
    const afterS = Math.floor((now - hevcFailedAt) / 1000);
    hevcFailedAt = null;
    logCallEvent('h265_retry', { after_s: afterS });
    return false;
}

// ── A stream's H.265 decoder died (utils/rxDecoderLost.ts) ──────────────────
//
// Chromium has no software HEVC, so when the hardware decoder errors mid-stream
// the receiver falls to a decoder that outputs nothing ("NullVideoDecoder
// (fallback from: ExternalDecoder (D3D11VideoDecoder))"): packets keep
// arriving, every frame is dropped, the tile is blank for good, and nothing
// asks the sender for anything else. Withdrawing OUR decode capability is the
// one lever every peer already honours: their HevcPolicy sees "someone cannot
// decode H.265" and republishes as H.264 / VP8 within a poll tick. The window is
// the same as a failed encode: long enough that the same stream is not re-sent
// in H.265 straight away, short enough that one bad stream does not cost the
// whole session its H.265 (the camera and later shares decoded fine on the
// same machine in the reports this came from).
let hevcDecodeFailedAt: number | null = null;
export function markHevcDecodeFailed(now: number = Date.now()): void { hevcDecodeFailedAt = now; }
export function hasHevcDecodeFailed(now: number = Date.now()): boolean {
    if (hevcDecodeFailedAt === null) return false;
    if (now - hevcDecodeFailedAt < HEVC_RETRY_MS) return true;
    hevcDecodeFailedAt = null;
    return false;
}

// ── After a GPU process restart (utils/gpuRecovery.ts) ─────────────────────
//
// Chromium's WebRTC has NO software H.265 — not to decode, not to encode —
// while H.264 / VP8 / VP9 fall back to software when the hardware path dies.
// A GPU process restart (driver reset, lost D3D device) is exactly when the
// hardware path is in doubt, and the probes cannot be trusted to say so: in
// the prod incident of 2026-10-11 the capability lists came straight back
// after the restart (h265_caps self_encode:true on the rejoin) while the
// call's video never loaded again. So a GPU restart takes H.265 out of this
// app session in BOTH directions — we stop advertising decode (every peer's
// HevcPolicy then drops to H.264/VP8 at once, "someone cannot decode H.265")
// and stop encoding it ourselves — through the same all-capable negotiation
// as any other incapable participant. An app restart (a fresh GPU process
// from scratch) is the only thing that brings it back.
let hevcGpuLost = false;
export function markHevcGpuLost(): void { hevcGpuLost = true; }
export function hasHevcGpuLost(): boolean { return hevcGpuLost; }

/**
 * The H.265 capabilities this client may actually USE / advertise, given what
 * the probes say now. Pure, so the post-GPU-restart rule is testable.
 */
export function effectiveHevcCaps(
    probed: { decode: boolean; encode: boolean },
    state: { gpuLost: boolean; failed: boolean } = { gpuLost: hevcGpuLost, failed: hasHevcFailed() },
): { decode: boolean; encode: boolean } {
    if (state.gpuLost) return { decode: false, encode: false };
    return { decode: probed.decode, encode: probed.encode && !state.failed };
}

export function __resetHevcForTests(): void { hevcFailedAt = null; hevcGpuLost = false; hevcDecodeFailedAt = null; }
