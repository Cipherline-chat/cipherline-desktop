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

export const HEVC_ATTR = 'cl.vdec';
export const HEVC_ATTR_VERSION = '1';
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

/** Capable / total, for the call log (counts only). */
export function hevcCapableCount(remotes: readonly RemoteCaps[]): { capable: number; total: number } {
    return { capable: remotes.filter(r => parseDecodeCaps(r.attr)?.h265).length, total: remotes.length };
}

export type HevcMode = 'h265' | 'base';

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

/** H.265 failed to start (or fell to software) this app session: never again until restart. */
let hevcFailed = false;
export function markHevcFailed(): void { hevcFailed = true; }
export function hasHevcFailed(): boolean { return hevcFailed; }
export function __resetHevcForTests(): void { hevcFailed = false; }
