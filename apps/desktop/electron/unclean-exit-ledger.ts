/**
 * unclean-exit-ledger — local bookkeeping for unclean-exit prompts.
 *
 * One tiny JSON file in userData (`diag-unclean-ledger.json`, plain: only
 * timestamps, small integers and class names — no ids, names, paths or
 * content). It holds
 *   • how often each SUPPRESSED class (unclean-exit-classify.ts) was seen, as
 *     (time, class) pairs pruned to SUPPRESSED_KEEP_DAYS, so a later report can
 *     say `suppressed_unclean: {installer_replaced: 2, ...}` without ever having
 *     sent anything about those exits;
 *   • the prompt rate limit for REAL candidates: at most one prompt per 24 h,
 *     never twice for the same dead session, and two dismissals in a row mute
 *     unclean-exit prompting for 7 days. (Muted / limited records are still
 *     kept pending — a manual report can attach them — they are only marked
 *     seen so the boot prompt stays quiet.)
 *
 * Pure: fs is injected, never throws, and a bad clock never hides a crash
 * (a lastPromptAt / mutedUntil in the FUTURE is ignored, not honoured).
 * No `electron` import; must not import from src/ (rootDir trap).
 */
import {
    SUPPRESSED_CLASSES, classifyUncleanExit, sane,
    type ClassifyEnv, type DeadSession, type SuppressedClass, type UncleanReason,
} from './unclean-exit-classify';

export const UNCLEAN_LEDGER_FILE = 'diag-unclean-ledger.json';
export const PROMPT_MIN_GAP_MS = 24 * 3600_000;
export const MUTE_AFTER_DISMISSALS = 2;
export const MUTE_MS = 7 * 24 * 3600_000;
export const SUPPRESSED_KEEP_DAYS = 14;
export const SUPPRESSED_MAX_ENTRIES = 60;
export const PROMPTED_SESSIONS_MAX = 20;
const MAX_FILE_BYTES = 8 * 1024;
const DAY_MS = 24 * 3600_000;

export interface UncleanLedger {
    v: 1;
    /** Epoch ms of the last unclean-exit prompt we allowed. */
    lastPromptAt: number | null;
    /** Dead-session start times (epoch ms) already prompted for. */
    promptedSessions: number[];
    /** Dismissals since the last "Review". */
    dismissals: number;
    /** No unclean-exit prompts until here. */
    mutedUntil: number | null;
    suppressed: Array<{ at: number; cls: SuppressedClass }>;
}

export interface LedgerFs {
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, data: string, opts: { encoding: 'utf8'; mode: number }): void;
    renameSync(from: string, to: string): void;
}

export const emptyLedger = (): UncleanLedger => ({ v: 1, lastPromptAt: null, promptedSessions: [], dismissals: 0, mutedUntil: null, suppressed: [] });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15 ? v : null);

/** Shape-check an on-disk ledger; anything else becomes an empty one. Never throws. */
export function parseLedger(text: string | null): UncleanLedger {
    if (!text || text.length > MAX_FILE_BYTES) return emptyLedger();
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return emptyLedger(); }
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return emptyLedger();
    const sup: UncleanLedger['suppressed'] = [];
    for (const e of Array.isArray(raw.suppressed) ? raw.suppressed.slice(-SUPPRESSED_MAX_ENTRIES) : []) {
        const at = num((e as { at?: unknown })?.at);
        const cls = (e as { cls?: unknown })?.cls;
        if (at !== null && (SUPPRESSED_CLASSES as readonly unknown[]).includes(cls)) sup.push({ at, cls: cls as SuppressedClass });
    }
    const dismissals = typeof raw.dismissals === 'number' && Number.isInteger(raw.dismissals) && raw.dismissals >= 0 && raw.dismissals < 1000 ? raw.dismissals : 0;
    return {
        v: 1,
        lastPromptAt: num(raw.lastPromptAt),
        promptedSessions: (Array.isArray(raw.promptedSessions) ? raw.promptedSessions : []).map(num).filter((n): n is number => n !== null).slice(-PROMPTED_SESSIONS_MAX),
        dismissals,
        mutedUntil: num(raw.mutedUntil),
        suppressed: sup,
    };
}

export interface PromptDecision { prompt: boolean; why: 'ok' | 'muted' | 'same_session' | 'rate_limited' }

/**
 * May a REAL candidate for the dead session started at `sessionStartedAt`
 * (epoch ms, null = unknown) raise the boot prompt now? Pure.
 */
export function decidePrompt(l: UncleanLedger, sessionStartedAt: number | null, now: number): PromptDecision {
    // A timestamp in the future is clock skew, never a reason to stay silent.
    if (l.mutedUntil !== null && l.mutedUntil > now && l.mutedUntil <= now + MUTE_MS + DAY_MS) return { prompt: false, why: 'muted' };
    if (sessionStartedAt !== null && l.promptedSessions.includes(sessionStartedAt)) return { prompt: false, why: 'same_session' };
    if (l.lastPromptAt !== null && l.lastPromptAt <= now && now - l.lastPromptAt < PROMPT_MIN_GAP_MS) return { prompt: false, why: 'rate_limited' };
    return { prompt: true, why: 'ok' };
}

export function withPrompted(l: UncleanLedger, sessionStartedAt: number | null, now: number): UncleanLedger {
    return {
        ...l, lastPromptAt: now,
        promptedSessions: sessionStartedAt === null ? l.promptedSessions : [...l.promptedSessions, sessionStartedAt].slice(-PROMPTED_SESSIONS_MAX),
    };
}

/** The user chose "Not now": the second one in a row mutes for 7 days. */
export function withDismissed(l: UncleanLedger, now: number): UncleanLedger {
    const dismissals = l.dismissals + 1;
    return dismissals >= MUTE_AFTER_DISMISSALS ? { ...l, dismissals: 0, mutedUntil: now + MUTE_MS } : { ...l, dismissals };
}

/** The user chose "Review": they want these, so the streak resets. */
export function withReviewed(l: UncleanLedger): UncleanLedger {
    return l.dismissals === 0 ? l : { ...l, dismissals: 0 };
}

export function withSuppressed(l: UncleanLedger, cls: SuppressedClass, now: number): UncleanLedger {
    const keep = pruneSuppressed(l.suppressed, now);
    return { ...l, suppressed: [...keep, { at: now, cls }].slice(-SUPPRESSED_MAX_ENTRIES) };
}

function pruneSuppressed(s: UncleanLedger['suppressed'], now: number): UncleanLedger['suppressed'] {
    // Entries "from the future" (clock moved back) are kept rather than lost.
    return s.filter(e => e.at > now || now - e.at <= SUPPRESSED_KEEP_DAYS * DAY_MS);
}

/** `{installer_replaced: 2, os_restart: 1}` over the kept window; null when nothing was suppressed. */
export function suppressedCounts(l: UncleanLedger, now: number): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const e of pruneSuppressed(l.suppressed, now)) out[e.cls] = (out[e.cls] ?? 0) + 1;
    return Object.keys(out).length ? out : null;
}

// ── The whole decision for one unclean exit ──────────────────────────────────

export type UncleanVerdict =
    | { action: 'suppress'; cls: SuppressedClass; reason: UncleanReason }
    /** Keep the record; `seen: true` = do not raise the boot prompt for it. */
    | { action: 'keep'; seen: boolean; reason: UncleanReason; why: PromptDecision['why'] };

/**
 * Classify one unclean exit and update the ledger accordingly: a suppressed
 * class is COUNTED and dropped; a real candidate is kept and either prompts
 * (and uses up the 24 h slot) or is kept quietly (rate limit / mute / this
 * dead session already prompted).
 */
export function judgeUncleanExit(store: UncleanLedgerStore, dead: DeadSession, env: ClassifyEnv): UncleanVerdict {
    const c = classifyUncleanExit(dead, env);
    if (c.cls !== 'real_candidate') {
        store.update(l => withSuppressed(l, c.cls as SuppressedClass, env.now));
        return { action: 'suppress', cls: c.cls as SuppressedClass, reason: c.reason };
    }
    const sessionId = sane(dead.startedAt, env.now) ? dead.startedAt : null;
    let decision = { prompt: true, why: 'ok' } as PromptDecision;
    store.update(l => {
        decision = decidePrompt(l, sessionId, env.now);
        return decision.prompt ? withPrompted(l, sessionId, env.now) : l;
    });
    return { action: 'keep', seen: !decision.prompt, reason: c.reason, why: decision.why };
}

/** Load / mutate / save around one file. Every method swallows its errors. */
export class UncleanLedgerStore {
    /** `file` may be a getter: userData is not always resolvable at construction. */
    constructor(private readonly fs: LedgerFs, private readonly fileOf: string | (() => string), private readonly enabled: boolean) {}

    private get file(): string { return typeof this.fileOf === 'function' ? this.fileOf() : this.fileOf; }

    load(): UncleanLedger {
        if (!this.enabled) return emptyLedger();
        try { return parseLedger(this.fs.readFileSync(this.file, 'utf8')); } catch { return emptyLedger(); }
    }

    update(fn: (l: UncleanLedger) => UncleanLedger): UncleanLedger {
        const next = fn(this.load());
        if (!this.enabled) return next;
        try {
            const tmp = `${this.file}.tmp`;
            this.fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
            this.fs.renameSync(tmp, this.file);
        } catch { /* bookkeeping only */ }
        return next;
    }
}
