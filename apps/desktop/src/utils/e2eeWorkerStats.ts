/**
 * Page side of the E2EE worker's Annex-B canonicalizer (utils/e2eeAnnexB.ts):
 * turns its periodic counts into `e2ee_annexb` call events, so a diagnostics
 * report shows whether THIS machine's encoder writes 3-byte start codes (the
 * frames a pre-fix sender would have made undecryptable for everyone else).
 * Counts only — no identities, no content.
 */
import { logCallEvent } from './callEventLog';
import { ANNEXB_STATS_KIND, type AnnexBStats } from './e2eeAnnexB';
import { audioLagStatsFromMessage } from './e2eeAudioLag';

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function annexBStatsFromMessage(data: unknown): AnnexBStats | null {
    const d = (data as { kind?: string; data?: Record<string, unknown> } | null);
    if (!d || d.kind !== ANNEXB_STATS_KIND || !d.data) return null;
    return {
        frames: n(d.data.frames), rewritten: n(d.data.rewritten), shortStartCode: n(d.data.shortStartCode),
        leadingData: n(d.data.leadingData), keyRewritten: n(d.data.keyRewritten), deltaRewritten: n(d.data.deltaRewritten),
    };
}

/** Listen on the call's E2EE worker. Uses addEventListener: LiveKit owns `onmessage`. */
export function attachAnnexBStatsLog(worker: Pick<Worker, 'addEventListener'>): void {
    worker.addEventListener('message', (ev: MessageEvent) => {
        const s = annexBStatsFromMessage(ev.data);
        if (!s) return;
        logCallEvent('e2ee_annexb', {
            frames: s.frames,
            rewritten: s.rewritten,
            short_sc: s.shortStartCode,
            leading: s.leadingData,
            key_rewritten: s.keyRewritten,
            delta_rewritten: s.deltaRewritten,
        });
    });
}

/**
 * A data-packet decrypt/encrypt failure inside the E2EE worker, if `data` is
 * one. livekit-client 2.18.8 posts `{ kind: 'error', data: { error, uuid,
 * participantIdentity } }` for a failed `decryptDataRequest` /
 * `encryptDataRequest`, rejects that packet's promise and emits NOTHING on the
 * Room (E2EEManager.onWorkerMessage: "Don't emit general error if it's handled
 * by future"); RTCEngine.handleDataPacket then throws inside an async data-
 * channel handler and the packet is gone. Every annotation stroke, grant and
 * request rides those packets, so this is the one place such a loss is
 * visible. Frame (media) errors carry no `uuid` and are reported elsewhere
 * (e2ee_decrypt_error). Returns the reason enum only — never the identity.
 */
export function dataPacketErrorFromMessage(data: unknown): ReturnType<typeof decryptErrorReason> | null {
    const d = data as { kind?: string; data?: { uuid?: unknown; error?: unknown } } | null;
    if (!d || d.kind !== 'error' || !d.data || typeof d.data.uuid !== 'string' || !d.data.uuid) return null;
    return decryptErrorReason(d.data.error);
}

/** Listen on the call's E2EE worker for data-packet failures (see above). */
export function attachDataPacketErrorLog(worker: Pick<Worker, 'addEventListener'>): void {
    worker.addEventListener('message', (ev: MessageEvent) => {
        const reason = dataPacketErrorFromMessage(ev.data);
        if (!reason) return;
        logCallEvent('e2ee_data_error', { reason });
    });
}

/**
 * The reason enum at the front of a LiveKit EncryptionError message
 * ("InvalidKey: Decryption failed: …", "MissingKey: missing key at index 0
 * for participant <identity>") — the enum only, never the rest, which can
 * carry an identity.
 */
export function decryptErrorReason(err: unknown): 'invalid_key' | 'missing_key' | 'internal' | 'other' {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (/^InvalidKey\b/.test(msg)) return 'invalid_key';
    if (/^MissingKey\b/.test(msg)) return 'missing_key';
    if (/^InternalError\b/.test(msg)) return 'internal';
    return 'other';
}

/**
 * The E2EE worker's audio-lag windows (utils/e2eeAudioLag.ts) -> `e2ee_audio_lag`
 * call events: direction, windows folded, frames, frames dropped to stay inside the cap,
 * the worst lag seen (ms) and re-bases. Counts only.
 *
 * The worker reports every 10 s that came within AUDIO_LAG_REPORT_MS (120 ms) of the cap, and
 * on the receive side that is ordinary network jitter (the lag includes arrival jitter; NetEq
 * absorbs it, and nothing is dropped below the 1 s cap): both 2026-11-10 loudness reports had
 * 41 and 51 of these (median ~205 ms, max ~515 ms, 0 dropped), half of each report, saying
 * nothing. So windows are folded per direction over AUDIO_LAG_FOLD_MS and an event is logged
 * only when the fold is worth reading: a frame was dropped, the clock was re-based, or the
 * worst lag reached AUDIO_LAG_NOTABLE_MS. Anything dropped is also still console.warn'd at once.
 */
export const AUDIO_LAG_FOLD_MS = 60_000;
export const AUDIO_LAG_NOTABLE_MS = 400;

export interface AudioLagFold { dir: string; windows: number; frames: number; dropped: number; maxMs: number; rebases: number }

export class AudioLagFolder {
    private acc = new Map<string, AudioLagFold & { since: number }>();
    /** Fold one worker window in; returns the event detail when a fold closes and is notable. */
    add(s: { dir: string; frames: number; dropped: number; maxMs: number; rebases: number }, now: number): AudioLagFold | null {
        let a = this.acc.get(s.dir);
        if (!a) { a = { dir: s.dir, windows: 0, frames: 0, dropped: 0, maxMs: 0, rebases: 0, since: now }; this.acc.set(s.dir, a); }
        a.windows++; a.frames += s.frames; a.dropped += s.dropped; a.rebases += s.rebases;
        if (s.maxMs > a.maxMs) a.maxMs = s.maxMs;
        // Anything that dropped or re-based is reported at once; a quiet fold waits for its minute.
        const urgent = s.dropped > 0 || s.rebases > 0;
        if (!urgent && now - a.since < AUDIO_LAG_FOLD_MS) return null;
        this.acc.delete(s.dir);
        const notable = a.dropped > 0 || a.rebases > 0 || a.maxMs >= AUDIO_LAG_NOTABLE_MS;
        return notable ? { dir: a.dir, windows: a.windows, frames: a.frames, dropped: a.dropped, maxMs: a.maxMs, rebases: a.rebases } : null;
    }
}

export function attachAudioLagLog(worker: Pick<Worker, 'addEventListener'>): void {
    const folder = new AudioLagFolder();
    worker.addEventListener('message', (ev: MessageEvent) => {
        const s = audioLagStatsFromMessage(ev.data);
        if (!s) return;
        const f = folder.add(s, Date.now());
        if (f) logCallEvent('e2ee_audio_lag', { dir: f.dir, windows: f.windows, frames: f.frames, dropped: f.dropped, max_ms: f.maxMs, rebases: f.rebases });
        if (s.dropped > 0) console.warn(`[E2EE] ${s.dir} audio fell ${s.maxMs} ms behind in the E2EE worker; dropped ${s.dropped} late frame(s) to catch up`);
    });
}
