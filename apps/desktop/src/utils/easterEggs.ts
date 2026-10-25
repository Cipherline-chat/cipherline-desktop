/**
 * easterEggs — the shared, DOM-free machinery behind the playful touches
 * (docs/personality.md). Pure on purpose: vitest here is `environment: node`,
 * so everything an egg DECIDES lives in this file where it can be tested, and
 * the components only render the verdict.
 *
 * What lives here:
 *   - the "seen" ledger — which eggs fired, how often, when — so a one-shot
 *     stays one-shot and a chatty one stays rate-limited,
 *   - the calendar (Halloween, New Year, Cipherline's birthday) and the clock
 *     (3–5 am), both evaluated in the user's LOCAL time,
 *   - the small recognisers: the Konami sequence, "N things inside a window".
 *
 * There is no off switch. The playful touches are part of using the app, not
 * a feature to opt out of (owner, 2026-10-20: "I don't want any of it
 * togglable"). What is NOT optional is the restraint: every egg keeps its
 * rate limit / cooldown (the ledger below) and its prefers-reduced-motion
 * fallback, because accessibility is not a toggle either.
 *
 * Privacy contract (doctrine rule 8): nothing here, or anywhere that calls it,
 * ever reads message content. Triggers are UI actions, timing and the user's
 * own settings-search text. Nothing is sent anywhere — the ledger is a local
 * JSON blob in secureLocalStore and is not part of a backup.
 */

// ── storage ──────────────────────────────────────────────────────────────────

/** JSON `{ [eggId]: { count, last } }`. Device-local bookkeeping; excluded
 *  from backups (a restore onto a new machine can happily re-tease you). */
export const EGG_LEDGER_KEY = 'cipherline_egg_seen';

/** The slice of secureLocalStore the eggs need (and what tests fake). */
export interface EggStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface LedgerEntry { count: number; last: number }
export type Ledger = Record<string, LedgerEntry>;

/** Defensive parse: a corrupt or hand-edited blob is an empty ledger, never a throw. */
export function parseLedger(raw: string | null): Ledger {
    if (!raw) return {};
    try {
        const v: unknown = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out: Ledger = {};
        for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
            const c = (e as LedgerEntry | null)?.count;
            const l = (e as LedgerEntry | null)?.last;
            if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && typeof l === 'number' && Number.isFinite(l)) {
                out[id] = { count: c, last: l };
            }
        }
        return out;
    } catch { return {}; }
}

export interface EggPolicy {
    /** Stop for good after this many firings. Omit = unlimited. */
    maxTimes?: number;
    /** Minimum gap between firings. Omit = none. */
    cooldownMs?: number;
}

/** Is this egg allowed to fire right now? Pure; does not record anything. */
export function eggDue(ledger: Ledger, id: string, now: number, policy: EggPolicy = {}): boolean {
    const e = ledger[id];
    if (!e) return true;
    if (policy.maxTimes !== undefined && e.count >= policy.maxTimes) return false;
    // `last` in the future (clock moved back) counts as "just now" — fail quiet.
    if (policy.cooldownMs !== undefined && now - e.last < policy.cooldownMs) return false;
    return true;
}

export function recordEgg(ledger: Ledger, id: string, now: number): Ledger {
    return { ...ledger, [id]: { count: (ledger[id]?.count ?? 0) + 1, last: now } };
}

/**
 * The one entry point eggs use: policy satisfied → record the firing and
 * return true; otherwise false, and nothing is written.
 */
export function claimEgg(store: EggStore, id: string, now: number, policy: EggPolicy = {}): boolean {
    let ledger: Ledger;
    try { ledger = parseLedger(store.getItem(EGG_LEDGER_KEY)); } catch { return false; }
    if (!eggDue(ledger, id, now, policy)) return false;
    try { store.setItem(EGG_LEDGER_KEY, JSON.stringify(recordEgg(ledger, id, now))); } catch { /* still fire: a failed write only costs rate-limiting */ }
    return true;
}

/** Peek without claiming: how many times has this egg fired? */
export function eggCount(store: EggStore, id: string): number {
    try { return parseLedger(store.getItem(EGG_LEDGER_KEY))[id]?.count ?? 0; } catch { return 0; }
}

/** Record a firing without a policy check (for eggs that decide elsewhere). */
export function noteEgg(store: EggStore, id: string, now: number): void {
    try { store.setItem(EGG_LEDGER_KEY, JSON.stringify(recordEgg(parseLedger(store.getItem(EGG_LEDGER_KEY)), id, now))); } catch { /* non-fatal */ }
}

// ── the calendar ─────────────────────────────────────────────────────────────

/** Cipherline's birthday: the first commit, 30 April 2026. */
export const BIRTHDAY = { month: 4, day: 30, year: 2026 } as const;

export type Costume = 'witch' | 'party';

/** How a costume is announced in Keys' accessible name. */
export const COSTUME_LABEL: Record<Costume, string> = {
    witch: 'in a witch hat',
    party: 'in a party hat',
};

/**
 * What Keys wears today, if anything. Local time. Halloween is the day itself
 * (Oct 31); New Year covers the eve and the day; the birthday is only a
 * "birthday" from its first anniversary on (the day it launched isn't one).
 */
export function costumeFor(d: Date): Costume | null {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m === 10 && day === 31) return 'witch';
    if ((m === 12 && day === 31) || (m === 1 && day === 1)) return 'party';
    if (birthdayYears(d) > 0) return 'party';
    return null;
}

/** Years since launch if today is the birthday, else 0. */
export function birthdayYears(d: Date): number {
    if (d.getMonth() + 1 !== BIRTHDAY.month || d.getDate() !== BIRTHDAY.day) return 0;
    return Math.max(0, d.getFullYear() - BIRTHDAY.year);
}

/** A small stable number from a string (query text etc.) so the same input
 *  keeps the same joke while a different one rotates to the next. */
export function hashSeed(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h;
}

/** Local calendar day number, for "same line all night, a different one tomorrow". */
export function dayNumber(d: Date): number {
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

export function isHalloween(d: Date): boolean {
    return d.getMonth() + 1 === 10 && d.getDate() === 31;
}

/** 03:00–04:59 local. The hour the composer asks if you shouldn't be asleep. */
export function isLateNight(d: Date): boolean {
    const h = d.getHours();
    return h >= 3 && h < 5;
}

// ── recognisers ──────────────────────────────────────────────────────────────

export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'] as const;

/**
 * Advance the Konami recogniser by one key. Returns the new progress; a full
 * match returns KONAMI.length (the caller fires and resets to 0). A wrong key
 * restarts, except that a wrong key that is itself the first Up counts as
 * progress 1 (so Up Up Up Down Down… still works the way people mash it).
 */
export function konamiStep(progress: number, key: string): number {
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (k === KONAMI[progress]) return progress + 1;
    return k === KONAMI[0] ? 1 : 0;
}

/**
 * Is a keystroke headed for a text field? Global key eggs (Konami) must never
 * read what someone is typing into the composer, so they ignore every key
 * aimed at an editable target. Structural, so it works on any element-like.
 */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = (t.tagName ?? '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Keep only the timestamps inside the trailing window, then add `now`. */
export function pushWithin(times: readonly number[], now: number, windowMs: number): number[] {
    return [...times.filter(t => now - t < windowMs && now >= t), now];
}
