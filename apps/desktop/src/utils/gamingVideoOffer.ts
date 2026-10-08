/**
 * When the "Video froze while you were gaming — turn on Prioritize call video
 * while gaming?" offer may appear.
 *
 *   - Never while the mode is already on.
 *   - At most ONCE PER CALL, whatever the answer (or none).
 *   - "Not now" (or closing the card) → not again for SNOOZE_MS (a day).
 *   - "Don't ask again" → never again on this device.
 *   - "Turn on" turns the mode on, which ends the offers by itself.
 *
 * Persisted in secureLocalStore (encrypted at rest) under a device-global key:
 * it is about THIS machine's gaming load, like the mode itself (which lives in
 * main's startup-flags.json). Excluded from backups — see backupRegistry.ts.
 * Two fields, no content, no ids, nothing about the call.
 */
import secureLocalStore from './secureLocalStore';

export const GAMING_VIDEO_OFFER_KEY = 'cipherline_gaming_video_offer';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface GamingVideoOfferState {
    /** Epoch ms before which no offer is shown (after "Not now"). 0 = none. */
    snoozedUntil: number;
    /** "Don't ask again". */
    never: boolean;
}

export const DEFAULT_OFFER_STATE: Readonly<GamingVideoOfferState> = Object.freeze({ snoozedUntil: 0, never: false });

/** Narrow a stored value; anything malformed is the default (ask again). */
export function parseOfferState(raw: string | null | undefined): GamingVideoOfferState {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return { ...DEFAULT_OFFER_STATE };
    try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_OFFER_STATE };
        const snoozedUntil = typeof v.snoozedUntil === 'number' && Number.isFinite(v.snoozedUntil) && v.snoozedUntil > 0
            ? v.snoozedUntil : 0;
        return { snoozedUntil, never: v.never === true };
    } catch {
        return { ...DEFAULT_OFFER_STATE };
    }
}

export interface OfferGateInput {
    state: GamingVideoOfferState;
    now: number;
    /** The mode is already on (saved). */
    modeOn: boolean;
    /** This call has already shown the offer. */
    shownThisCall: boolean;
}

export function canOffer({ state, now, modeOn, shownThisCall }: OfferGateInput): boolean {
    if (modeOn || shownThisCall || state.never) return false;
    // A snooze far in the future (clock moved back, or a corrupted value) is
    // clamped to one SNOOZE_MS from now rather than honoured forever.
    if (state.snoozedUntil > now && state.snoozedUntil - now <= SNOOZE_MS) return false;
    return true;
}

export type OfferAnswer = 'turn-on' | 'not-now' | 'never';

/** The state after an answer. */
export function answerOffer(state: GamingVideoOfferState, answer: OfferAnswer, now: number): GamingVideoOfferState {
    switch (answer) {
        case 'not-now': return { ...state, snoozedUntil: now + SNOOZE_MS };
        case 'never': return { ...state, never: true };
        case 'turn-on': return { ...state, snoozedUntil: 0 };
    }
}

export function readOfferState(): GamingVideoOfferState {
    try { return parseOfferState(secureLocalStore.getItem(GAMING_VIDEO_OFFER_KEY)); } catch { return { ...DEFAULT_OFFER_STATE }; }
}

export function writeOfferState(state: GamingVideoOfferState): void {
    try {
        secureLocalStore.setItem(GAMING_VIDEO_OFFER_KEY, JSON.stringify({ snoozedUntil: state.snoozedUntil, never: state.never === true }));
    } catch { /* locked store: the offer may come back, which is harmless */ }
}

export interface OfferCopy {
    title: string;
    body: string;
    accept: string;
    decline: string;
    never: string;
}

/** `gameKnown`: the game detector has named a running game (Settings → Game activity). */
export function offerCopy(gameKnown: boolean): OfferCopy {
    return {
        title: gameKnown ? 'Video froze while you were gaming' : 'Video froze while Cipherline was in the background',
        body: 'Turn on “Prioritize call video while gaming”? It keeps cameras and screen shares moving, but may lower your game’s FPS a little.',
        accept: 'Turn on',
        decline: 'Not now',
        never: 'Don’t ask again',
    };
}
