/**
 * The new audio engine's learned per-microphone gain, remembered between calls so the next call starts settled (a cold
 * start takes ~2 s before the first words are at level). One number per capture deviceId, in dB, in secureLocalStore
 * (encrypted at rest). Device-specific, so it is NOT in backups (services/backupRegistry.ts). A number, never content.
 *
 * Keyed by the capture deviceId (stable per origin for one endpoint), not by label: a label can carry a person's name
 * and the processor only needs "the same microphone as last time".
 */
import secureLocalStore from './secureLocalStore';

export const MIC_DEVICE_GAIN_KEY = 'cipherline_mic_device_gain';
/** Remembered microphones; the least recently saved go first. */
export const MAX_MIC_GAINS = 40;
/** Plausible learned gains; anything else in storage is ignored. */
const LIMIT_DB = 60;

interface Entry { db: number; at: number }
type Store = Record<string, Entry>;

function read(): Store {
    try {
        const raw = secureLocalStore.getItem(MIC_DEVICE_GAIN_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as { v?: unknown; gains?: unknown };
        if (parsed?.v !== 1 || typeof parsed.gains !== 'object' || parsed.gains === null) return {};
        const out: Store = {};
        for (const [id, e] of Object.entries(parsed.gains as Record<string, unknown>)) {
            const db = (e as Entry | null)?.db, at = (e as Entry | null)?.at;
            if (typeof db === 'number' && Number.isFinite(db) && Math.abs(db) <= LIMIT_DB) out[id] = { db, at: typeof at === 'number' ? at : 0 };
        }
        return out;
    } catch { return {}; }
}

/** The remembered gain for this microphone, or null when there is none. */
export function loadMicDeviceGain(deviceId: string | null | undefined): number | null {
    if (!deviceId) return null;
    return read()[deviceId]?.db ?? null;
}

/** Remember the gain for this microphone (ignored when the deviceId is unknown or the number is not plausible). */
export function saveMicDeviceGain(deviceId: string | null | undefined, db: number, now: number = Date.now()): void {
    if (!deviceId || !Number.isFinite(db) || Math.abs(db) > LIMIT_DB) return;
    try {
        const store = read();
        store[deviceId] = { db: Math.round(db * 10) / 10, at: now };
        const ids = Object.keys(store);
        if (ids.length > MAX_MIC_GAINS) {
            ids.sort((a, b) => store[a].at - store[b].at);
            for (const id of ids.slice(0, ids.length - MAX_MIC_GAINS)) delete store[id];
        }
        secureLocalStore.setItem(MIC_DEVICE_GAIN_KEY, JSON.stringify({ v: 1, gains: store }));
    } catch { /* a locked store: the gain just is not remembered */ }
}
