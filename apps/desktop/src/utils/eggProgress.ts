/**
 * eggProgress — which easter eggs this account has FOUND, and the "Egg hunter"
 * badge tiers that count earns (shown on the profile; see ProfileBadgeRow).
 *
 * Distinct from the seen-ledger in easterEggs.ts: the ledger is device-local
 * rate-limit bookkeeping (count + last time, excluded from backups); this is
 * the account's set of DISTINCT finds — ids only — which syncs to the server
 * so other people can see the tier.
 *
 *   recordEggFound(id)  — call the moment an egg actually fires. Dedupes,
 *                         persists, dispatches `cipherline:egg-found` {id},
 *                         then debounce-syncs to the server. Every egg and
 *                         every full-screen moment (MomentHost records the
 *                         moment id when one plays) goes through this ONE
 *                         entry point, with an id from EGG_IDS.
 *
 * The id list never leaves the account's own row server-side; others only get
 * the derived tier (`GET` profile `badges`). Nothing but the ids you found is
 * sent, and only to `POST /v1/profile/eggs`.
 *
 * This module has NO network code on purpose: the host (EggProgressHost)
 * injects the sender, which keeps the egg machinery's "no network" privacy
 * test honest and makes the whole state machine testable in vitest's node
 * environment.
 *
 * `EGG_IDS` / `EGG_TIERS` are MIRRORED BY HAND in
 * `apps/api/src/profile-eggs/egg-registry.ts`; eggProgress.test.ts reads that
 * file and fails if they drift. Ids are stable and never reused.
 */
import { secureLocalStore } from './secureLocalStore';
import { EGG_LEDGER_KEY, birthdayYears, isHalloween, parseLedger, type EggStore } from './easterEggs';
import { isMomentId, ledgerId } from './moments';

// ── registry (mirror of apps/api/src/profile-eggs/egg-registry.ts) ───────────

export const EGG_IDS = [
    // The 2026-10 playful-touches pass
    'group-of-two',
    'konami',
    'alone-echo',
    'late-night',
    'dev-mode',
    'status-flap',
    'misnamed-keys',
    'abyss-search',
    // Older visual / owned-slot eggs
    'cuttlefish',
    'self-search',
    'plane-crash',
    'draft-erased',
    'paperclip-shrug',
    'send-spam',
    'on-the-hour',
    'rare-ringtone',
    'titlebar-lap',
    'shiny-keys',
    'keys-finale-offline',
    'keys-finale-call',
    'keys-finale-gaming',
    'keys-finale-dnd',
    'keys-finale-asleep',
    'keys-finale-camo',
    'keys-finale-box',
    'keys-finale-safe',
    'keys-finale-pile',
    'keys-finale-coffee',
    'keys-finale-lantern',
    'keys-finale-crown',
    'caps-inflate',
    'mute-dizzy',
    'first-friend',
    'ancient-chats',
    // Date-gated: counted once per holiday, ever (not once per year)
    'costume-halloween',
    'costume-new-year',
    'costume-birthday',
    // Full-screen moments (utils/moments.ts MOMENTS keys; MomentHost records
    // the moment id itself when one plays — it is not prefixed)
    'self-friend',
    'note-to-self',
    'echo-everyone',
    'self-ping',
    'wish',
    'empty-party',
    'volume-ceiling',
    'friends-100',
    'servers-10',
    'coffee',
    'new-year',
    'anniversary',
    'self-fan',
    'double-general',
    'revolving-door',
    'first-ban',
    'first-message',
    'first-call',
    'first-server',
    'call-100',
    'pi-day',
    'leap-day',
    'nye-call',
] as const;

export type EggId = (typeof EGG_IDS)[number];

export interface EggTier {
    /** 1..4 (0 = no badge yet). */
    tier: number;
    /** Distinct eggs needed. Counts, never "all" — adding eggs never demotes. */
    min: number;
    name: string;
}

/**
 * Sized for the original 37-egg registry (45 now; the thresholds stay put, see the API mirror for the reasoning): the top
 * tier is reachable without waiting on the calendar or a 100-friend list.
 */
export const EGG_TIERS: readonly EggTier[] = [
    { tier: 1, min: 3, name: 'Tide Pooler' },
    { tier: 2, min: 8, name: 'Reef Explorer' },
    { tier: 3, min: 15, name: 'Deep Diver' },
    { tier: 4, min: 25, name: 'Abyss Legend' },
];

/** Badge colour NAME per tier (the API sends the same names; profileBadges resolves them to tokens). */
export const EGG_TIER_COLORS: Record<number, string> = { 1: 'cyan', 2: 'orange', 3: 'blue', 4: 'gold' };

export function eggTierFor(count: number): EggTier | null {
    let best: EggTier | null = null;
    for (const t of EGG_TIERS) if (count >= t.min) best = t;
    return best;
}

export function eggTierByNumber(tier: number): EggTier | null {
    return EGG_TIERS.find((t) => t.tier === tier) ?? null;
}

/**
 * Which holiday egg a day belongs to, if any. Counted once per HOLIDAY, ever --
 * the id carries no year, so Halloween 2026 and Halloween 2027 are one find.
 * Same calendar as `costumeFor` (local time).
 */
export function costumeEggFor(d: Date): EggId | null {
    if (isHalloween(d)) return 'costume-halloween';
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if ((m === 12 && day === 31) || (m === 1 && day === 1)) return 'costume-new-year';
    if (birthdayYears(d) > 0) return 'costume-birthday';
    return null;
}

/** `badge.icon` value the API sends for the Egg hunter badge: `egg-tier-N`. */
export function parseEggTierIcon(icon: string | null | undefined): number | null {
    const m = /^egg-tier-([1-9])$/.exec(icon ?? '');
    if (!m) return null;
    const n = Number(m[1]);
    return eggTierByNumber(n) ? n : null;
}

// ── persisted state ──────────────────────────────────────────────────────────

/** Per-account key. In the backup (a restore on a new machine keeps your finds). */
export const eggProgressKey = (userId: string) => `cipherline_egg_progress_${userId}`;

/**
 * LEGACY per-account key from the first, local-only tally that shipped with
 * the full-screen moments branch: a JSON array of ids, moments stored as
 * `moment:<id>`. Read-only now — on bind its registry eggs are folded into
 * `eggProgressKey` (deduped, so re-reading it every bind is a no-op) and the
 * key is otherwise ignored. Nothing writes it any more.
 */
export const legacyEggsFoundKey = (userId: string) => `cipherline_eggs_found_${userId}`;

const REGISTRY = new Set<string>(EGG_IDS);

/** The registry ids in a legacy blob (`moment:` prefix stripped). Defensive: junk is []. */
export function parseLegacyFound(raw: string | null): EggId[] {
    if (!raw) return [];
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(v)) return [];
    const out: EggId[] = [];
    for (const x of v) {
        if (typeof x !== 'string') continue;
        const id = x.startsWith('moment:') ? x.slice('moment:'.length) : x;
        if (REGISTRY.has(id) && !out.includes(id as EggId)) out.push(id as EggId);
    }
    return out;
}

/** Window event: an egg was found for the FIRST time on this account. */
export const EGG_FOUND_EVENT = 'cipherline:egg-found';
/** Window event: a sync earned a higher tier. detail: { tier, name, count } */
export const EGG_TIER_EVENT = 'cipherline:egg-tier-up';

/** Same shape the DTO enforces server-side. */
export const EGG_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Server accepts at most this many ids per request. */
export const MAX_EGG_IDS = 64;

export interface EggProgressState {
    /** Distinct ids found on this account (any device, as far as we know). */
    found: string[];
    /** Subset the server has acknowledged. */
    synced: string[];
    /** Highest tier the server last reported (0 = none). */
    tier: number;
    /** The server's count at its last reply. */
    serverCount: number;
}

const EMPTY: EggProgressState = { found: [], synced: [], tier: 0, serverCount: 0 };

const cleanIds = (v: unknown): string[] =>
    Array.isArray(v)
        ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && EGG_ID_RE.test(x)))).slice(0, MAX_EGG_IDS)
        : [];

/** Defensive parse: a corrupt or hand-edited blob is "nothing found yet", never a throw. */
export function parseProgress(raw: string | null): EggProgressState {
    if (!raw) return { ...EMPTY, found: [], synced: [] };
    try {
        const v = JSON.parse(raw) as Partial<EggProgressState> | null;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...EMPTY, found: [], synced: [] };
        const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
        return { found: cleanIds(v.found), synced: cleanIds(v.synced), tier: num(v.tier), serverCount: num(v.serverCount) };
    } catch {
        return { ...EMPTY, found: [], synced: [] };
    }
}

// ── the state machine ────────────────────────────────────────────────────────

export interface EggSyncResult { tier: number; tier_name: string | null; count: number }
/** Posts the ids; resolves the server's summary, or null on any failure. */
export type EggSender = (ids: string[]) => Promise<EggSyncResult | null>;

export interface EggProgressDeps {
    store: EggStore;
    emit: (name: string, detail: unknown) => void;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (h: unknown) => void;
}

/** Wait this long after the latest find before syncing (a burst is one request). */
export const SYNC_DEBOUNCE_MS = 2500;
/** Delay before trying again after a failed sync (then each next one; give up after the list). */
export const SYNC_RETRY_MS = [30_000, 90_000, 300_000] as const;
/** Delay before the boot sync of finds the server hasn't acknowledged yet. */
export const BOOT_SYNC_DELAY_MS = 4000;

export interface EggProgressController {
    /** Record a find. Safe before sign-in (buffered) and after (persisted). */
    record(id: string): void;
    /** Attach the signed-in account. Replaces any previous binding. */
    bind(userId: string, send: EggSender): void;
    /** Detach (sign-out). Clears timers; finds made while detached are buffered. */
    unbind(): void;
    /** Sync now (tests; also used by the debounce). Resolves when the attempt finishes. */
    flush(): Promise<void>;
    snapshot(): EggProgressState | null;
}

export function createEggProgress(deps: EggProgressDeps): EggProgressController {
    let uid: string | null = null;
    let send: EggSender | null = null;
    let timer: unknown = null;
    let retries = 0;
    let inflight: Promise<void> | null = null;
    /** Finds made before an account was bound (they belong to whoever signs in). */
    let buffered: string[] = [];
    /** In-memory copy of `found`, so a re-fired egg (caps lock, every keystroke) costs a Set lookup, not a store parse. */
    let known: Set<string> | null = null;

    const read = (): EggProgressState => {
        try { return uid ? parseProgress(deps.store.getItem(eggProgressKey(uid))) : { ...EMPTY, found: [], synced: [] }; } catch { return { ...EMPTY, found: [], synced: [] }; }
    };
    const write = (s: EggProgressState): void => {
        if (!uid) return;
        try { deps.store.setItem(eggProgressKey(uid), JSON.stringify(s)); } catch { /* a failed write only costs resync */ }
    };
    const unsynced = (s: EggProgressState) => s.found.filter((id) => !s.synced.includes(id));

    const schedule = (ms: number) => {
        if (timer !== null) deps.clearTimer(timer);
        timer = deps.setTimer(() => { timer = null; void flush(); }, ms);
    };

    const add = (id: string): boolean => {
        const s = read();
        if (s.found.includes(id) || s.found.length >= MAX_EGG_IDS) return false;
        write({ ...s, found: [...s.found, id] });
        known?.add(id);
        return true;
    };

    function record(id: string): void {
        if (typeof id !== 'string' || !EGG_ID_RE.test(id)) return;
        if (known?.has(id)) return;
        if (!uid) {
            if (!buffered.includes(id) && buffered.length < MAX_EGG_IDS) buffered.push(id);
            return;
        }
        if (!add(id)) return;
        deps.emit(EGG_FOUND_EVENT, { id });
        retries = 0;
        schedule(SYNC_DEBOUNCE_MS);
    }

    async function doFlush(): Promise<void> {
        if (!uid || !send) return;
        const s = read();
        const pending = unsynced(s);
        if (pending.length === 0) return;
        const sentTo = uid;
        let res: EggSyncResult | null = null;
        try { res = await send(s.found); } catch { res = null; }
        if (uid !== sentTo) return;                       // signed out / switched mid-flight
        if (!res) {
            if (retries < SYNC_RETRY_MS.length) schedule(SYNC_RETRY_MS[retries++]);
            return;
        }
        retries = 0;
        const cur = read();
        // Celebrate only growth THIS device explains: if the server's count
        // jumped by more than the ids we just sent (a second device, or the
        // very first sync on a new machine), the tier is old news — adopt it
        // silently so a fresh install never re-awards badges you already hold.
        const explained = res.count - cur.serverCount <= pending.length;
        const earned = res.tier > cur.tier && explained;
        write({ ...cur, synced: Array.from(new Set([...cur.synced, ...s.found])), tier: res.tier, serverCount: res.count });
        if (earned) {
            const t = eggTierByNumber(res.tier);
            if (t) deps.emit(EGG_TIER_EVENT, { tier: t.tier, name: t.name, count: res.count });
        }
        if (unsynced(read()).length > 0) schedule(SYNC_DEBOUNCE_MS);   // more arrived mid-flight
    }

    function flush(): Promise<void> {
        if (inflight) return inflight;
        inflight = doFlush().finally(() => { inflight = null; });
        return inflight;
    }

    function unbind(): void {
        if (timer !== null) deps.clearTimer(timer);
        timer = null; uid = null; send = null; retries = 0; known = null;
    }

    return {
        record,
        unbind,
        bind(userId, sender) {
            unbind();
            uid = userId;
            send = sender;
            known = new Set(read().found);
            const early = buffered;
            buffered = [];
            let legacy: string[] = [];
            try { legacy = parseLegacyFound(deps.store.getItem(legacyEggsFoundKey(userId))); } catch { /* locked store: nothing to migrate */ }
            let fresh = false;
            for (const id of [...early, ...legacy]) if (add(id)) { fresh = true; deps.emit(EGG_FOUND_EVENT, { id }); }
            if (fresh || unsynced(read()).length > 0) schedule(fresh ? SYNC_DEBOUNCE_MS : BOOT_SYNC_DELAY_MS);
        },
        flush,
        snapshot: () => (uid ? read() : null),
    };
}

// ── the app singleton ────────────────────────────────────────────────────────

const store: EggStore = {
    getItem: (k) => secureLocalStore.getItem(k),
    setItem: (k, v) => secureLocalStore.setItem(k, v),
};

const controller = createEggProgress({
    store,
    emit: (name, detail) => {
        try {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new CustomEvent(name, { detail }));
            }
        } catch { /* cosmetic; never break the egg */ }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/**
 * An easter egg just fired — remember it for the Egg hunter badge.
 *
 * Call at the moment the egg's payoff actually happens (not when its trigger
 * is merely armed), with a stable id from EGG_IDS. Idempotent: finding the
 * same egg again does nothing. Never throws.
 */
export function recordEggFound(id: string): void {
    try { controller.record(id); } catch { /* cosmetic; never break the egg */ }
}

/**
 * Eggs that fired BEFORE this feature shipped are in the device-local seen
 * ledger under the same ids (konami, alone-echo, group-of-two, status-flap,
 * dev-mode), and full-screen moments under `moment:<id>` (utils/moments.ts
 * ledgerId). Credit them once an account is bound so existing testers don't
 * start from zero. Pure addition: `record` dedupes.
 */
export function creditLedgerFinds(st: EggStore = store, rec: (id: string) => void = recordEggFound): void {
    let ledger: ReturnType<typeof parseLedger>;
    try { ledger = parseLedger(st.getItem(EGG_LEDGER_KEY)); } catch { return; }
    const seen = (key: string) => (ledger[key]?.count ?? 0) > 0;
    for (const id of EGG_IDS) {
        if (seen(id) || (isMomentId(id) && seen(ledgerId(id)))) rec(id);
    }
}

export const bindEggAccount = (userId: string, send: EggSender): void => controller.bind(userId, send);
export const unbindEggAccount = (): void => controller.unbind();
export const flushEggSync = (): Promise<void> => controller.flush();
/** The ids found on the bound account ([] when signed out). Read-only view. */
export const eggsFound = (): string[] => controller.snapshot()?.found ?? [];
