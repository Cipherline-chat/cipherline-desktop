/**
 * "There's a lot of background noise. Switch to Strong noise suppression?"
 *
 * Owner 2026-11-13: detect a high noise floor and offer Strong. Everything here is local: the voice gate
 * worklet reports, once a second, the quietest moment of the signal it sees (a minimum, so speech cannot
 * lift it); this watcher decides from those numbers alone. No audio leaves the device, none is stored, and
 * the only thing persisted is when the prompt may next appear.
 *
 * Rules (pure, tested in noiseFloorPrompt.test.ts):
 *   - only while Light or Off is selected (never when already Strong);
 *   - the quietest moment of at least HIGH_SECONDS of the last WINDOW_SECONDS must be above FLOOR_DB
 *     (-50 dBFS: a quiet room with a decent mic sits at -65 or lower after Light);
 *   - at most once per call, and not again for SNOOZE_MS after it was shown.
 */
import secureLocalStore from './secureLocalStore';
import type { VoiceSettings } from '../hooks/useVoiceSettings';

export const NOISE_FLOOR_PROMPT_DB = -50;
export const NOISE_FLOOR_WINDOW_S = 25;
export const NOISE_FLOOR_HIGH_S = 24;
export const NOISE_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** Per device (the store is per device and account); excluded from backups, see backupRegistry.ts. */
export const NOISE_PROMPT_KEY = 'cipherline_ns_noise_prompt';

/** Light or Off: the modes the prompt may suggest Strong for. */
export function noisePromptApplies(s: Pick<VoiceSettings, 'noiseSuppression' | 'noiseSuppressionMode'>): boolean {
    return !s.noiseSuppression || s.noiseSuppressionMode !== 'strong';
}

export class NoiseFloorWatcher {
    private readings: boolean[] = [];
    private fired = false;

    /** One reading per second (null = no input / silence). True exactly once per call, when the prompt should show. */
    observe(minDb: number | null, applies: boolean): boolean {
        if (this.fired) return false;
        if (!applies) { this.readings = []; return false; }
        this.readings.push(typeof minDb === 'number' && Number.isFinite(minDb) && minDb > NOISE_FLOOR_PROMPT_DB);
        if (this.readings.length > NOISE_FLOOR_WINDOW_S) this.readings.shift();
        if (this.readings.length < NOISE_FLOOR_WINDOW_S) return false;
        if (this.readings.filter(Boolean).length < NOISE_FLOOR_HIGH_S) return false;
        this.fired = true;
        return true;
    }
}

interface KvLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** Is the prompt allowed now (not snoozed)? A missing or unreadable stamp means yes. */
export function noisePromptAllowed(now: number, store: KvLike = secureLocalStore): boolean {
    try {
        const until = Number(store.getItem(NOISE_PROMPT_KEY));
        return !(Number.isFinite(until) && until > now);
    } catch { return true; }
}

/** Stamp "do not ask again until": the toast has one button, so dismissing it is "Not now" and the
 *  snooze starts when it is shown (Switch also stamps it; Strong is then on, so it cannot return). */
export function snoozeNoisePrompt(now: number, store: KvLike = secureLocalStore): void {
    try { store.setItem(NOISE_PROMPT_KEY, String(now + NOISE_PROMPT_SNOOZE_MS)); } catch { /* best effort */ }
}
