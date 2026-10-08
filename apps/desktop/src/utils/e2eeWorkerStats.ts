/**
 * Page side of the E2EE worker's Annex-B canonicalizer (utils/e2eeAnnexB.ts):
 * turns its periodic counts into `e2ee_annexb` call events, so a diagnostics
 * report shows whether THIS machine's encoder writes 3-byte start codes (the
 * frames a pre-fix sender would have made undecryptable for everyone else).
 * Counts only — no identities, no content.
 */
import { logCallEvent } from './callEventLog';
import { ANNEXB_STATS_KIND, type AnnexBStats } from './e2eeAnnexB';

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
