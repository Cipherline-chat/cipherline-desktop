/**
 * "Show what you're listening to?": the rules behind the one-time question.
 * components/integrations/ListeningAskHost.tsx is the runtime and the card.
 *
 * Asked once per account on this computer, ever. The record is written BEFORE
 * the card appears, so a crash cannot ask twice, and whatever happens next
 * (Enable, No thanks, or nothing) it is never asked again. The switch itself
 * stays in Settings > Activity & Style; Enable flips exactly that setting.
 *
 * Who is asked: only someone whose stored setting has never been set. Null means
 * never set, '0' means they turned it off themselves (an answer), '1' means on
 * (listeningPrefs.ts). This reads the raw stored value because the parsed prefs
 * cannot tell null from '0'.
 *
 * Nothing about what is playing comes through here. The bridge answers one
 * boolean (electron/music-detect.ts), which is why there is no track to log, send
 * or show, and the card never names one.
 *
 * A cold account namespace reads null for everything, including "never asked"
 * and "never set", so every read goes through isAccountReady first: not ready
 * means no answer, no prompt and no write.
 */
import secureLocalStore from '../secureLocalStore';
import { isTyping, isUserActive } from '../firstWeekNudges';
import { resetListeningPrefsCache } from './listeningPrefs';

/** How often to look while the person is here. Each look is one short-lived process on Windows: see music-detect.ts. */
export const LISTENING_ASK_CHECK_MS = 5 * 60_000;
/** Nothing is read for this long after the account's records load: boot is the busiest moment. */
export const LISTENING_ASK_GRACE_MS = 2 * 60_000;
/** A card nobody touched leaves on its own, and that counts as the answer. */
export const LISTENING_ASK_AUTO_HIDE_MS = 45_000;

export const LISTENING_ASK_COPY = {
    title: 'Show what you’re listening to?',
    body: 'Friends will see the song and artist.',
    note: 'You can change this anytime in Settings.',
    enable: 'Enable',
    decline: 'No thanks',
    enabled: 'Friends can now see what you’re listening to. Change it in Settings → Activity & Style.',
} as const;

export type ListeningAskGate = 'no_account' | 'store_cold' | 'asked' | 'setting_on' | 'setting_off' | 'eligible';

/** May this account be asked, going by what is stored? Reads only; a cold store answers nothing about the account. */
export function listeningAskGate(uid: string | null | undefined): ListeningAskGate {
    if (!uid) return 'no_account';
    if (!secureLocalStore.isAccountReady(uid)) return 'store_cold';
    if (secureLocalStore.getItem(`cipherline_listening_asked_${uid}`) !== null) return 'asked';
    const share = secureLocalStore.getItem(`cipherline_listening_share_${uid}`);
    if (share === null) return 'eligible';
    return share === '1' ? 'setting_on' : 'setting_off';
}

/**
 * Record "asked", and wait until it is on disk so the card comes after it. A
 * failed flush still shows the card: the value is in the store and goes out with
 * the next write. Refuses a cold store, which it could not file correctly.
 */
export async function markListeningAsked(uid: string): Promise<boolean> {
    if (!secureLocalStore.isAccountReady(uid)) return false;
    secureLocalStore.setItem(`cipherline_listening_asked_${uid}`, '1');
    try { await secureLocalStore.flushNow(); } catch { /* see above */ }
    return true;
}

type Bridge = { isMusicPlaying?: () => Promise<unknown>; platform?: string };
const bridge = (): Bridge | null =>
    (typeof window !== 'undefined' ? ((window as unknown as { electronAPI?: Bridge }).electronAPI ?? null) : null);

/**
 * Does this build and platform have the check? macOS does not: reading playback
 * state there needs an Apple Event, which pops the system's Automation dialog
 * before the person has agreed to anything (music-detect.ts). Without this nothing
 * is armed, so the question is never offered.
 */
export const canDetectMusic = (): boolean => {
    const b = bridge();
    return typeof b?.isMusicPlaying === 'function' && (b.platform === 'windows' || b.platform === 'linux');
};

/** One look. Only a literal true counts; any failure is "no". */
export async function isMusicPlaying(): Promise<boolean> {
    try { return (await bridge()?.isMusicPlaying?.()) === true; } catch { return false; }
}

export interface CalmInput {
    now: number;
    focused: boolean;
    visible: boolean;
    lastInputAt: number;
    lastKeyAt: number;
    /** Loading, locked, or in / answering a call. Also withdraws a card that is up. */
    busy: boolean;
    /** Onboarding, Settings, a first-run prompt or celebration. */
    uiBusy: boolean;
    dnd: boolean;
    /** A video or call tile is fullscreen. */
    fullscreen: boolean;
    /** A modal dialog or another corner card is up. */
    covered: boolean;
}

/** Is the person here and between things? The same "here" and "not mid-sentence" the first-week nudges use. */
export function isCalmMoment(c: CalmInput): boolean {
    const activity = { focused: c.focused, visible: c.visible, lastInputAt: c.lastInputAt, lastKeyAt: c.lastKeyAt };
    return isUserActive(activity, c.now) && !isTyping(activity, c.now) && !c.busy && !c.uiBusy && !c.dnd && !c.fullscreen && !c.covered;
}

/** Dev only (see ListeningAskHost): as if this account had never been asked or touched the switch. */
export function resetListeningAskForTesting(uid: string): void {
    secureLocalStore.removeItem(`cipherline_listening_asked_${uid}`);
    secureLocalStore.removeItem(`cipherline_listening_share_${uid}`);
    resetListeningPrefsCache();
}
