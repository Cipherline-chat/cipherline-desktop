/**
 * composerFun — the pure half of the composer's small interactions
 * (docs/personality.md → "Composer touches (2026-10-20)").
 *
 * Everything here is DOM-free and clock-injected so it is testable in vitest's
 * node environment. ChatPane owns the wiring; the components in
 * components/composer/ own the visuals.
 *
 * Privacy (doctrine rule 8): every trigger is STRUCTURAL — the mention TYPES
 * the send path already parses, a member COUNT, a length, emptiness, the clock,
 * a click cadence. Nothing in this module ever receives message text.
 */

// ── @everyone / @here confirmation ──────────────────────────────────────────

/** A server must have MORE than this many members before @everyone / @here
 *  asks first, and before the send lands with an impact. */
export const EVERYONE_CONFIRM_THRESHOLD = 100;

export type MentionKind = 'everyone' | 'here' | 'user' | 'role';

/** Which mass mention a message carries (everyone beats here), or null. */
export function massMentionOf(mentions: ReadonlyArray<{ type: MentionKind | string }>): 'everyone' | 'here' | null {
    if (mentions.some(m => m.type === 'everyone')) return 'everyone';
    if (mentions.some(m => m.type === 'here')) return 'here';
    return null;
}

/** Is this a "big room" — strictly more than EVERYONE_CONFIRM_THRESHOLD members? */
export function isBigRoom(memberCount: number | null | undefined): boolean {
    return typeof memberCount === 'number' && Number.isFinite(memberCount) && memberCount > EVERYONE_CONFIRM_THRESHOLD;
}

export interface EveryoneConfirmInput {
    /** Mention entries parsed from the wire text (the same parse the send uses). */
    mentions: ReadonlyArray<{ type: MentionKind | string }>;
    /** Total server members (the live roster), or null when it isn't loaded. */
    memberCount: number | null | undefined;
    /** Only server channels have @everyone semantics. */
    isServerChannel: boolean;
    /** MENTION_EVERYONE. When false the send path refuses on its own — the
     *  dialog must never stand in front of that refusal. */
    canMention: boolean;
    /** An edit never re-notifies anyone. */
    isEdit: boolean;
    /** The user already said yes for this exact send. */
    alreadyConfirmed: boolean;
}

/** Should this send stop and ask "Mention everyone?" first. */
export function needsEveryoneConfirm(i: EveryoneConfirmInput): boolean {
    if (i.alreadyConfirmed || i.isEdit || !i.isServerChannel || !i.canMention) return false;
    if (!massMentionOf(i.mentions)) return false;
    return isBigRoom(i.memberCount);
}

/** en-US grouping ("1,284") regardless of the OS locale, so the copy is stable. */
export function formatCount(n: number): string {
    return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

export function everyoneConfirmCopy(kind: 'everyone' | 'here', memberCount: number): { title: string; message: string; confirmLabel: string } {
    const n = formatCount(memberCount);
    return {
        title: 'Mention everyone?',
        message: kind === 'everyone'
            ? `This will notify ${n} members.`
            : `@here notifies every member who is online right now — up to ${n} people.`,
        confirmLabel: 'Send to everyone',
    };
}

// ── Impact landing ──────────────────────────────────────────────────────────

/**
 * Which ONE row lands with an impact. Armed by the send with the row key of
 * the own message it just appended (utils/messageEntrance.ts messageRowKey —
 * `c:<client_msg_id>`, which only this device's own rows carry), shown only
 * while that row is ENTERING (so never on a re-render after the entrance,
 * never on a history load), and spent when the entrance ends.
 */
export interface ImpactSlot {
    arm(rowKey: string): void;
    isImpacting(rowKey: string, entering: boolean): boolean;
    spend(rowKey: string): void;
    armed(): string | null;
}

export function createImpactSlot(): ImpactSlot {
    let key: string | null = null;
    return {
        arm(k) { key = k; },
        isImpacting(k, entering) { return entering && key !== null && k === key; },
        spend(k) { if (key === k) key = null; },
        armed: () => key,
    };
}

/** The row key an own send carries (mirror of messageEntrance.messageRowKey). */
export const ownRowKey = (clientMsgId: string): string => `c:${clientMsgId}`;

// ── Disabled-send spam ──────────────────────────────────────────────────────

/** Clicks on the greyed-out send button that must land inside WINDOW_MS. */
export const SPAM_FIRST_AT = 5;
export const SPAM_WINDOW_MS = 2000;
/** Further clicks (each within STREAK_GAP_MS of the last) per escalation step. */
export const SPAM_STEP = 4;
/** A pause longer than this ends the streak. */
export const SPAM_STREAK_GAP_MS = 1500;
/** After the last stage, the button ignores the joke for this long. */
export const SPAM_COOLDOWN_MS = 10_000;

export type SpamStage = 'wobble' | 'sulk' | 'keys';
const STAGES: readonly SpamStage[] = ['wobble', 'sulk', 'keys'];

export interface SendSpamTracker {
    /** Record one click at `now`; returns the stage that STARTS on this click, or null. */
    click(now: number): SpamStage | null;
    /** Forget everything (conversation switch, a real send). */
    reset(): void;
}

export function createSendSpamTracker(): SendSpamTracker {
    let times: number[] = [];
    let streak = 0;          // clicks in the current streak
    let stage = -1;          // index into STAGES reached in this streak
    let stageAt = 0;         // streak count when `stage` was reached
    let coolUntil = 0;
    const reset = () => { times = []; streak = 0; stage = -1; stageAt = 0; };
    return {
        click(now) {
            if (now < coolUntil) return null;
            const last = times[times.length - 1];
            if (last !== undefined && now - last > SPAM_STREAK_GAP_MS) reset();
            times.push(now);
            times = times.filter(t => now - t <= SPAM_WINDOW_MS);
            streak += 1;
            let next: number | null = null;
            if (stage < 0) {
                if (times.length >= SPAM_FIRST_AT) next = 0;
            } else if (stage < STAGES.length - 1 && streak - stageAt >= SPAM_STEP) {
                next = stage + 1;
            }
            if (next === null) return null;
            stage = next;
            stageAt = streak;
            if (stage === STAGES.length - 1) {
                coolUntil = now + SPAM_COOLDOWN_MS;
                const s = STAGES[stage];
                reset();
                return s;
            }
            return STAGES[stage];
        },
        reset,
    };
}

/** What the little bubble over the send button says, per stage (3 lines each, rotating). */
export const SEND_SPAM_LINES: Record<SpamStage, readonly string[]> = {
    wobble: ['Nothing to send.', 'Still empty.', 'Type first.'],
    sulk: ['Clicking harder won’t help.', 'It’s still empty.', 'The button is not the problem.'],
    keys: ['You have to write something first.', 'Empty envelope. Try words.', 'I’ll carry it once there’s something in it.'],
};

// ── ↑ with nothing to edit ──────────────────────────────────────────────────

export const ARROW_UP_NOTHING_LINES: readonly string[] = [
    'nothing of yours to edit yet',
    '↑ edits your last message, once there is one',
    'no recent message of yours here',
];

// ── Big paste ───────────────────────────────────────────────────────────────

/** A single text paste at least this long gets the chip (once per session). */
export const BIG_PASTE_CHARS = 2000;

export const BIG_PASTE_LINES: readonly string[] = [
    'That’s a lot of text.',
    'Big paste. Still encrypted, all of it.',
    'Hope they like reading.',
];

export function isBigPaste(pastedLength: number): boolean {
    return pastedLength >= BIG_PASTE_CHARS;
}

let bigPasteShown = false;
/** Once per app session (module lifetime — ChatPane remounts per conversation). */
export function claimBigPasteChip(pastedLength: number): boolean {
    if (bigPasteShown || !isBigPaste(pastedLength)) return false;
    bigPasteShown = true;
    return true;
}
/** Test hook. */
export function __resetBigPasteChip(): void { bigPasteShown = false; }

// ── Character limit ─────────────────────────────────────────────────────────

/** The remaining-characters counter shows from this fraction of the cap. */
export const COUNTER_FROM = 0.9;

export interface CounterState { remaining: number; full: boolean }

/** The near-limit counter, or null while the draft is comfortably short. */
export function charCounter(length: number, max: number): CounterState | null {
    if (max <= 0 || length < Math.floor(max * COUNTER_FROM)) return null;
    const remaining = Math.max(0, max - length);
    return { remaining, full: remaining === 0 };
}

// ── Clock-gated send touches ────────────────────────────────────────────────

/** A send in the first minute of an hour (hh:00:00 – hh:00:59, local). */
export function isOnTheHour(d: Date): boolean {
    return d.getMinutes() === 0;
}

export const ON_THE_HOUR_LINES: readonly string[] = [
    'Right on the hour.',
    'Sent at exactly :00.',
    'Top of the hour. Nice timing.',
];

/** Local calendar day stamp (y*10000 + m*100 + d). */
export function localDayStamp(d: Date): number {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Is `now` on a later local day than the last first-send (or is there none)? */
export function isFirstSendOfDay(lastMs: number | null | undefined, now: Date): boolean {
    if (typeof lastMs !== 'number' || !Number.isFinite(lastMs) || lastMs <= 0) return true;
    const last = new Date(lastMs);
    // A clock that moved backwards counts as "same day" — fail quiet.
    if (last.getTime() > now.getTime()) return false;
    return localDayStamp(now) !== localDayStamp(last);
}

export const FIRST_TODAY_MORNING_LINES: readonly string[] = [
    'Good morning.',
    'Morning. First one’s out.',
    'And the day begins.',
];

export const FIRST_TODAY_LINES: readonly string[] = [
    'First message today.',
    'That’s today’s first.',
    'Day’s first message, out.',
];

/** The pool for a first send at `d`: "Good morning" only before noon. */
export function firstTodayPool(d: Date): readonly string[] {
    const h = d.getHours();
    return h >= 5 && h < 12 ? FIRST_TODAY_MORNING_LINES : FIRST_TODAY_LINES;
}

/** Every line this module can show, for the doctrine checks in the test. */
export const COMPOSER_FUN_POOLS: Record<string, readonly string[]> = {
    SEND_SPAM_WOBBLE: SEND_SPAM_LINES.wobble,
    SEND_SPAM_SULK: SEND_SPAM_LINES.sulk,
    SEND_SPAM_KEYS: SEND_SPAM_LINES.keys,
    ARROW_UP_NOTHING_LINES,
    BIG_PASTE_LINES,
    ON_THE_HOUR_LINES,
    FIRST_TODAY_MORNING_LINES,
    FIRST_TODAY_LINES,
};
