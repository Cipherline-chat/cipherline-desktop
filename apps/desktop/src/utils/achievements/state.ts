/**
 * Achievement progress state: what this ACCOUNT has done, kept on the devices.
 *
 * The state is a small CRDT so it can follow the user between their own
 * devices through the E2EE `achievements` own-device slot (a whole snapshot,
 * the GIF-library pattern) without a server ever seeing a counter:
 *
 *   devices[deviceId]   the counters THAT device has accumulated. A device only
 *                       ever writes its OWN entry, and its counters only grow.
 *   days / servers / verified   grow-only sets (union).
 *   bestStreak          grow-only max.
 *   unlocked            id -> 'YYYY-MM', grow-only (earliest month wins).
 *   prefs.mostPlayed    last-writer-wins by `at`; a tie resolves to OFF, the
 *                       privacy-preserving side of a coin flip.
 *
 * MERGE: per-device entries are merged counter-by-counter with MAX (a device's
 * own replicas only differ by how far they got, so the larger is the newer),
 * and the account TOTAL is the SUM over devices. That is commutative,
 * associative and idempotent, so any order of pulls converges, two devices
 * never double count each other, and a reinstall (new device id) simply adds
 * one more entry instead of overwriting history. Single-valued records
 * (longest call, biggest call) are MAX across devices.
 *
 * Pure: no storage, no clock, no network. tracker.ts owns those.
 */

export const ACHIEVEMENTS_STATE_VERSION = 1;

export const DAY_MS = 86_400_000;
/** Day-set horizon: enough for the 365-day streak with slack. */
export const MAX_DAYS_KEPT = 400;
const MAX_SET = 500;
const MAX_GAMES_PER_DEVICE = 100;
const MAX_DEVICES = 32;
const MAX_MS = 1e12; // ~31 years: a sanity ceiling on any accumulated duration
const MAX_COUNT = 1e9;

export interface DeviceCounters {
    /** Time connected to a call or voice channel. */
    voiceMs: number;
    /** Subset of voiceMs spent as the only person in the call. */
    aloneMs: number;
    /** Subset of voiceMs between 02:00 and 05:00 local time. */
    lateNightMs: number;
    /** Messages the server accepted from this device (not self-notes). */
    messages: number;
    longestCallMs: number;
    /** Most people seen in any call. */
    peakCallPeople: number;
    /** Most people seen in a call this device STARTED. */
    hostedPeak: number;
    /** Game detection time by game name. */
    gameMs: Record<string, number>;
}

export interface AchievementsState {
    v: number;
    devices: Record<string, DeviceCounters>;
    /** Local calendar days ('YYYY-MM-DD') with a message or call time. */
    days: string[];
    bestStreak: number;
    /** Server ids messaged in. Stays in the E2EE slot; the server never gets it. */
    servers: string[];
    /** User ids whose safety number was verified. Same: local + E2EE slot only. */
    verified: string[];
    unlocked: Record<string, string>;
    prefs: { mostPlayed: boolean; at: number };
}

export const emptyCounters = (): DeviceCounters => ({
    voiceMs: 0, aloneMs: 0, lateNightMs: 0, messages: 0, longestCallMs: 0, peakCallPeople: 0, hostedPeak: 0, gameMs: {},
});

export const emptyState = (): AchievementsState => ({
    v: ACHIEVEMENTS_STATE_VERSION, devices: {}, days: [], bestStreak: 0, servers: [], verified: [], unlocked: {},
    prefs: { mostPlayed: false, at: 0 },
});

// ── keys & dates ────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Local-time calendar day key. */
export function dayKey(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 'YYYY-MM' (UTC) — the unlock month granularity. */
export function monthKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** Whole days since the epoch for a day key (timezone-free arithmetic). */
export function dayNumber(key: string): number {
    const [y, m, d] = key.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Longest run of consecutive days in a set of day keys. */
export function longestStreak(days: readonly string[]): number {
    const nums = Array.from(new Set(days.filter(d => DAY_RE.test(d)).map(dayNumber))).sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    let prev = Number.NEGATIVE_INFINITY;
    for (const n of nums) {
        run = n === prev + 1 ? run + 1 : 1;
        prev = n;
        if (run > best) best = run;
    }
    return best;
}

// ── sanitising (anything read from storage or from another device) ──────────

const num = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : 0;

function cleanCounters(v: unknown): DeviceCounters {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const gm: Record<string, number> = {};
    if (o.gameMs && typeof o.gameMs === 'object' && !Array.isArray(o.gameMs)) {
        const entries = Object.entries(o.gameMs as Record<string, unknown>)
            .filter(([k]) => k.length > 0 && k.length <= 64)
            .map(([k, x]) => [k, num(x, MAX_MS)] as const)
            .filter(([, x]) => x > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_GAMES_PER_DEVICE);
        for (const [k, x] of entries) gm[k] = x;
    }
    return {
        voiceMs: num(o.voiceMs, MAX_MS), aloneMs: num(o.aloneMs, MAX_MS), lateNightMs: num(o.lateNightMs, MAX_MS),
        messages: num(o.messages, MAX_COUNT), longestCallMs: num(o.longestCallMs, MAX_MS),
        peakCallPeople: num(o.peakCallPeople, 100_000), hostedPeak: num(o.hostedPeak, 100_000), gameMs: gm,
    };
}

const cleanSet = (v: unknown, re: RegExp, cap = MAX_SET): string[] =>
    Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && re.test(x)))).sort().slice(0, cap) : [];

/** Defensive: junk becomes "nothing yet", never a throw. */
export function sanitizeState(raw: unknown, knownIds?: ReadonlySet<string>): AchievementsState {
    const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const devices: Record<string, DeviceCounters> = {};
    if (o.devices && typeof o.devices === 'object' && !Array.isArray(o.devices)) {
        for (const [id, c] of Object.entries(o.devices as Record<string, unknown>).slice(0, MAX_DEVICES)) {
            if (SAFE_ID_RE.test(id)) devices[id] = cleanCounters(c);
        }
    }
    const unlocked: Record<string, string> = {};
    if (o.unlocked && typeof o.unlocked === 'object' && !Array.isArray(o.unlocked)) {
        for (const [id, m] of Object.entries(o.unlocked as Record<string, unknown>)) {
            if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && typeof m === 'string' && MONTH_RE.test(m) && (!knownIds || knownIds.has(id))) unlocked[id] = m;
        }
    }
    const p = (o.prefs && typeof o.prefs === 'object' ? o.prefs : {}) as Record<string, unknown>;
    return {
        v: ACHIEVEMENTS_STATE_VERSION,
        devices,
        days: cleanSet(o.days, DAY_RE, MAX_DAYS_KEPT * 2).slice(-MAX_DAYS_KEPT),
        bestStreak: num(o.bestStreak, 100_000),
        servers: cleanSet(o.servers, SAFE_ID_RE),
        verified: cleanSet(o.verified, SAFE_ID_RE),
        unlocked,
        prefs: { mostPlayed: p.mostPlayed === true, at: num(p.at, 1e15) },
    };
}

export function parseState(raw: string | null, knownIds?: ReadonlySet<string>): AchievementsState {
    if (!raw) return emptyState();
    try { return sanitizeState(JSON.parse(raw), knownIds); } catch { return emptyState(); }
}

// ── merge ───────────────────────────────────────────────────────────────────

function mergeCounters(a: DeviceCounters, b: DeviceCounters): DeviceCounters {
    const gameMs: Record<string, number> = { ...a.gameMs };
    for (const [k, v] of Object.entries(b.gameMs)) gameMs[k] = Math.max(gameMs[k] ?? 0, v);
    return {
        voiceMs: Math.max(a.voiceMs, b.voiceMs), aloneMs: Math.max(a.aloneMs, b.aloneMs),
        lateNightMs: Math.max(a.lateNightMs, b.lateNightMs), messages: Math.max(a.messages, b.messages),
        longestCallMs: Math.max(a.longestCallMs, b.longestCallMs), peakCallPeople: Math.max(a.peakCallPeople, b.peakCallPeople),
        hostedPeak: Math.max(a.hostedPeak, b.hostedPeak), gameMs,
    };
}

const unionSorted = (a: readonly string[], b: readonly string[]) => Array.from(new Set([...a, ...b])).sort();

/** Commutative, associative, idempotent. See the header for why. */
export function mergeState(a: AchievementsState, b: AchievementsState): AchievementsState {
    const devices: Record<string, DeviceCounters> = {};
    for (const id of new Set([...Object.keys(a.devices), ...Object.keys(b.devices)])) {
        devices[id] = mergeCounters(a.devices[id] ?? emptyCounters(), b.devices[id] ?? emptyCounters());
    }
    const unlocked: Record<string, string> = { ...a.unlocked };
    for (const [id, m] of Object.entries(b.unlocked)) {
        if (!unlocked[id] || m < unlocked[id]) unlocked[id] = m;
    }
    // LWW by time; a tie keeps OFF.
    const prefs = a.prefs.at > b.prefs.at ? a.prefs
        : b.prefs.at > a.prefs.at ? b.prefs
        : { mostPlayed: a.prefs.mostPlayed && b.prefs.mostPlayed, at: a.prefs.at };
    return {
        v: ACHIEVEMENTS_STATE_VERSION,
        devices,
        days: unionSorted(a.days, b.days).slice(-MAX_DAYS_KEPT),
        bestStreak: Math.max(a.bestStreak, b.bestStreak),
        servers: unionSorted(a.servers, b.servers).slice(0, MAX_SET),
        verified: unionSorted(a.verified, b.verified).slice(0, MAX_SET),
        unlocked,
        prefs: { ...prefs },
    };
}

export const sameState = (a: AchievementsState, b: AchievementsState): boolean => {
    // Merge is idempotent and canonical (sorted sets, key-wise maps), so equal
    // states serialise identically once keys are ordered.
    const norm = (s: AchievementsState) => JSON.stringify(s, (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
            : v);
    return norm(a) === norm(b);
};

export const isEmptyState = (s: AchievementsState): boolean =>
    Object.keys(s.devices).length === 0 && s.days.length === 0 && s.servers.length === 0
    && s.verified.length === 0 && Object.keys(s.unlocked).length === 0 && s.prefs.at === 0;

// ── totals (what the rules read) ────────────────────────────────────────────

export interface Totals {
    voiceHours: number;
    aloneHours: number;
    lateNightHours: number;
    longestCallHours: number;
    peakCallPeople: number;
    hostedPeak: number;
    messages: number;
    bestStreak: number;
    verified: number;
    servers: number;
    eggs: number;
    accountAgeDays: number;
    bestGameHours: number;
    /** Games with at least an hour of play. */
    gamesPlayed: number;
    /** Devices that have recorded any activity. */
    activeDevices: number;
}

export interface TotalsContext {
    /** Distinct easter eggs found (utils/eggProgress.ts). */
    eggCount: number;
    /** Account creation, epoch ms; null when unknown. */
    accountCreatedMs: number | null;
    now: number;
}

const H = 3_600_000;

export function computeTotals(s: AchievementsState, ctx: TotalsContext): Totals {
    let voice = 0, alone = 0, late = 0, msgs = 0, longest = 0, peak = 0, hosted = 0, active = 0;
    const games: Record<string, number> = {};
    for (const c of Object.values(s.devices)) {
        voice += c.voiceMs; alone += c.aloneMs; late += c.lateNightMs; msgs += c.messages;
        longest = Math.max(longest, c.longestCallMs);
        peak = Math.max(peak, c.peakCallPeople);
        hosted = Math.max(hosted, c.hostedPeak);
        for (const [g, ms] of Object.entries(c.gameMs)) games[g] = (games[g] ?? 0) + ms;
        if (c.voiceMs > 0 || c.messages > 0 || Object.keys(c.gameMs).length > 0) active++;
    }
    const gm = Object.values(games);
    return {
        voiceHours: voice / H, aloneHours: alone / H, lateNightHours: late / H, longestCallHours: longest / H,
        peakCallPeople: peak, hostedPeak: hosted, messages: msgs,
        bestStreak: Math.max(s.bestStreak, longestStreak(s.days)),
        verified: s.verified.length, servers: s.servers.length, eggs: ctx.eggCount,
        accountAgeDays: ctx.accountCreatedMs ? Math.max(0, (ctx.now - ctx.accountCreatedMs) / DAY_MS) : 0,
        bestGameHours: gm.length ? Math.max(...gm) / H : 0,
        gamesPlayed: gm.filter(ms => ms >= H).length,
        activeDevices: active,
    };
}

// ── mutations (pure; return a new state, touching only `deviceId`'s entry) ──

const withDevice = (s: AchievementsState, id: string, f: (c: DeviceCounters) => DeviceCounters): AchievementsState =>
    ({ ...s, devices: { ...s.devices, [id]: f(s.devices[id] ?? emptyCounters()) } });

/** Mark a local calendar day active, then trim and fold the streak into `bestStreak`. */
export function markDay(s: AchievementsState, day: string): AchievementsState {
    if (!DAY_RE.test(day)) return s;
    const has = s.days.includes(day);
    const days = has ? s.days : [...s.days, day].sort().slice(-MAX_DAYS_KEPT);
    return { ...s, days, bestStreak: Math.max(s.bestStreak, longestStreak(days)) };
}

export function addMessage(s: AchievementsState, deviceId: string, serverId: string | null, day: string): AchievementsState {
    let next = withDevice(s, deviceId, c => ({ ...c, messages: Math.min(c.messages + 1, MAX_COUNT) }));
    if (serverId && SAFE_ID_RE.test(serverId) && !next.servers.includes(serverId) && next.servers.length < MAX_SET) {
        next = { ...next, servers: [...next.servers, serverId].sort() };
    }
    return markDay(next, day);
}

export interface CallTick {
    dtMs: number;
    /** People in the call, including you. */
    people: number;
    isHost: boolean;
    /** Milliseconds this call has lasted so far (including dtMs). */
    sessionMs: number;
    /** Local hour 0-23. */
    hour: number;
    day: string;
}

export function addCallTime(s: AchievementsState, deviceId: string, t: CallTick): AchievementsState {
    const dt = Math.max(0, Math.floor(t.dtMs));
    const next = withDevice(s, deviceId, c => ({
        ...c,
        voiceMs: Math.min(c.voiceMs + dt, MAX_MS),
        aloneMs: t.people <= 1 ? Math.min(c.aloneMs + dt, MAX_MS) : c.aloneMs,
        lateNightMs: t.hour >= 2 && t.hour < 5 ? Math.min(c.lateNightMs + dt, MAX_MS) : c.lateNightMs,
        longestCallMs: Math.max(c.longestCallMs, Math.min(t.sessionMs, MAX_MS)),
        peakCallPeople: Math.max(c.peakCallPeople, t.people),
        hostedPeak: t.isHost ? Math.max(c.hostedPeak, t.people) : c.hostedPeak,
    }));
    return markDay(next, t.day);
}

/** A call-size observation outside a time tick (someone joined between ticks). */
export function notePeople(s: AchievementsState, deviceId: string, people: number, isHost: boolean): AchievementsState {
    return withDevice(s, deviceId, c => ({
        ...c,
        peakCallPeople: Math.max(c.peakCallPeople, people),
        hostedPeak: isHost ? Math.max(c.hostedPeak, people) : c.hostedPeak,
    }));
}

export function addGameTime(s: AchievementsState, deviceId: string, game: string, dtMs: number): AchievementsState {
    if (!game || game.length > 64 || dtMs <= 0) return s;
    return withDevice(s, deviceId, c => {
        const gameMs = { ...c.gameMs, [game]: Math.min((c.gameMs[game] ?? 0) + Math.floor(dtMs), MAX_MS) };
        const keys = Object.keys(gameMs);
        if (keys.length > MAX_GAMES_PER_DEVICE) {
            const smallest = keys.reduce((m, k) => (gameMs[k] < gameMs[m] ? k : m));
            delete gameMs[smallest];
        }
        return { ...c, gameMs };
    });
}

export function addVerified(s: AchievementsState, peerId: string): AchievementsState {
    if (!SAFE_ID_RE.test(peerId) || s.verified.includes(peerId) || s.verified.length >= MAX_SET) return s;
    return { ...s, verified: [...s.verified, peerId].sort() };
}

export function setMostPlayedPref(s: AchievementsState, on: boolean, now: number): AchievementsState {
    return { ...s, prefs: { mostPlayed: on, at: Math.max(now, s.prefs.at + 1) } };
}

/** Record newly satisfied ids (never removes, never rewrites an existing month). */
export function unlockIds(s: AchievementsState, ids: readonly string[], month: string): AchievementsState {
    const fresh = ids.filter(id => !s.unlocked[id]);
    if (fresh.length === 0) return s;
    const unlocked = { ...s.unlocked };
    for (const id of fresh) unlocked[id] = month;
    return { ...s, unlocked };
}
