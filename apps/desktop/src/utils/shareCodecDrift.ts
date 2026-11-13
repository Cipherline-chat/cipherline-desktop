/**
 * "The share is published as H.265, but the encoder is sending VP8": catch it,
 * because every viewer is getting NOTHING.
 *
 * ── What happened (2026-10-25, report e951243d, staging.176, RTX 50-series)
 *
 * A friend's 2560x1440 90 fps H.265 share ran on the hardware encoder for a
 * minute, then he changed source mid-share (the hot swap: replaceTrack on the
 * same sender). From that sample on the share's outbound-rtp said
 *
 *     codec VP8, encoder "SimulcastEncoderAdapter (libvpx, libvpx)", hw false
 *
 * while every share_codec event still said `codec: h265`. A later fresh
 * publish of the same screen came out as H.264 / OpenH264 from its first
 * frame. Meanwhile the viewer (the owner, report 83da3af8) received the
 * share's track at 0 kbps (`remote-video-9 ... bitrate_kbps: 0`) and the
 * fresh one never delivered a single packet (no codec, no frames): blank.
 *
 * Why: when a hardware encoder fails to (re)initialise, libwebrtc does not
 * stop - VideoStreamEncoder asks the send channel for an "encoder fallback",
 * which switches the SENDER to the next codec in the negotiated list without
 * any renegotiation. Reproduced in Chromium 155 (scratchpad drift.mjs): an
 * H.264 sender handed an 8192x4320 track it cannot open switches its
 * outbound-rtp codec to VP8 within ~3 s. Peer to peer that is harmless (the
 * receiver negotiated both); through an SFU it is fatal: LiveKit forwards a
 * track in the codec it was PUBLISHED with, so viewers subscribed to the H.265
 * track get nothing (and E2EE is still pinned to the published codec,
 * e2eeSenderCodec.ts). The start checks never saw it either - they ask "were
 * frames encoded?", and the fallback encoder encodes frames.
 *
 * ── What this module does
 *
 * Reads, from the share sender's own getStats(), which codec each ACTIVE
 * layer is really sending (outbound-rtp codecId -> codec mimeType), and
 * reports a drift once it has been seen on CONFIRM consecutive polls (a codec
 * id can be briefly missing at start). The caller (SidebarConference) marks
 * the published codec failed for the session and republishes the share, so
 * the codec decision picks something this machine can really encode and
 * viewers subscribe to what is actually sent.
 *
 * Nothing about people is read: codec names, an encoder implementation name
 * and a layer count.
 */

import { noteLinuxHwEncodeFailure } from './linuxHwEncode';

export type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void };

export interface SentCodecs {
    /** Distinct codecs ('h264', 'vp8', ...) the ACTIVE video layers report sending; empty = not known yet. */
    codecs: string[];
    /** Active video layers. */
    layers: number;
    /** encoderImplementation of the largest active layer, if reported. */
    encoder?: string;
}

/** 'video/H265' -> 'h265'; anything unparseable -> undefined. */
export function codecOfMime(mime: unknown): string | undefined {
    if (typeof mime !== 'string') return undefined;
    const slash = mime.indexOf('/');
    const c = (slash >= 0 ? mime.slice(slash + 1) : mime).trim().toLowerCase();
    return c ? c : undefined;
}

/** Which codec(s) the sender's active video layers are sending right now. */
export function readSentCodecs(report: StatsLike | null | undefined): SentCodecs {
    const mimes = new Map<string, string>();
    const outs: Record<string, unknown>[] = [];
    report?.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'codec' && typeof s.id === 'string' && typeof s.mimeType === 'string') mimes.set(s.id, s.mimeType);
        else if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video') && s.active !== false) outs.push(s);
    });
    const codecs = new Set<string>();
    let top: Record<string, unknown> | undefined;
    let topArea = -1;
    for (const o of outs) {
        const c = typeof o.codecId === 'string' ? codecOfMime(mimes.get(o.codecId)) : undefined;
        if (c) codecs.add(c);
        const area = (Number(o.frameWidth) || 0) * (Number(o.frameHeight) || 0);
        if (area > topArea) { topArea = area; top = o; }
    }
    const out: SentCodecs = { codecs: [...codecs], layers: outs.length };
    if (top && typeof top.encoderImplementation === 'string' && top.encoderImplementation) out.encoder = top.encoderImplementation;
    return out;
}

/** The codec actually being sent when it is NOT the published one; null = no drift (or not known yet). */
export function driftedCodec(published: string | undefined, sent: SentCodecs): string | null {
    if (!published || sent.codecs.length === 0) return null;
    const other = sent.codecs.find(c => c !== published);
    return other ?? null;
}

export interface CodecDrift {
    published: string;
    sent: string;
    layers: number;
    encoder?: string;
}

export const DRIFT_POLL_MS = 2_000;
/** Consecutive polls that must agree before a drift is reported. */
export const DRIFT_CONFIRM = 2;

export interface CodecDriftWatchDeps {
    getStats(): Promise<StatsLike | null | undefined>;
    /** The codec the share (or camera) was PUBLISHED with (what the SFU forwards). */
    published: string;
    /**
     * True while the track is not being judged (camera muted, a deliberate
     * republish in flight): the poll goes on, but nothing counts toward a
     * drift and a streak in progress is forgotten. Absent = always judged.
     */
    paused?(): boolean;
    /** Called once per watch, when the drift is confirmed. */
    onDrift(d: CodecDrift): void;
    pollMs?: number;
    confirm?: number;
    sleep?(ms: number): Promise<void>;
}

/**
 * Polls the sender for the life of one publication; reports the first
 * confirmed drift and stops. dispose() ends it (share stopped / republished).
 */
export class ShareCodecDriftWatch {
    private disposed = false;
    private running: Promise<void> | null = null;
    private readonly deps: CodecDriftWatchDeps;

    constructor(deps: CodecDriftWatchDeps) { this.deps = deps; }

    start(): Promise<void> {
        if (!this.running) this.running = this.run();
        return this.running;
    }

    dispose(): void { this.disposed = true; }

    private async run(): Promise<void> {
        const sleep = this.deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
        const confirm = Math.max(1, this.deps.confirm ?? DRIFT_CONFIRM);
        let seen = 0;
        let last: string | null = null;
        while (!this.disposed) {
            let sent: SentCodecs;
            try { sent = readSentCodecs(await this.deps.getStats()); } catch { return; /* sender gone */ }
            if (this.disposed) return;
            if (this.deps.paused?.()) {
                seen = 0; last = null;
                await sleep(this.deps.pollMs ?? DRIFT_POLL_MS);
                continue;
            }
            const d = driftedCodec(this.deps.published, sent);
            if (d && d === last) seen++;
            else { seen = d ? 1 : 0; last = d; }
            if (d && seen >= confirm) {
                this.disposed = true;
                // Linux VA-API: a hardware encoder that failed to (re)open makes libwebrtc switch the sender's
                // codec (linuxHwEncode.ts decides whether the evidence says hardware).
                void noteLinuxHwEncodeFailure('drift', { codec: this.deps.published, encoder: sent.encoder });
                this.deps.onDrift({ published: this.deps.published, sent: d, layers: sent.layers, ...(sent.encoder ? { encoder: sent.encoder } : {}) });
                return;
            }
            await sleep(this.deps.pollMs ?? DRIFT_POLL_MS);
        }
    }
}

/** The same watch, under the name the camera uses (one implementation for both tracks). */
export { ShareCodecDriftWatch as CodecDriftWatch };

/** Once per share source per this long, at most: a codec that drifts again after a republish is not retried in a loop. */
export const DRIFT_REPUBLISH_COOLDOWN_MS = 60_000;

/** The user-facing notice for a drift recovery. */
export function codecDriftNotice(published: string): string {
    const name = published === 'h265' ? 'H.265' : published === 'h264' ? 'H.264' : published.toUpperCase();
    return `Your graphics card's ${name} encoder stopped working during the share, so viewers could not see it. Restarting the share with another encoder.`;
}

/** The (subtle) notice for a camera drift recovery. */
export function cameraCodecDriftNotice(): string {
    return 'Camera encoder stopped working — restarting your camera.';
}
