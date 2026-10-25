/**
 * clientControl — the renderer side of the server's kill switch and live
 * version floor (apps/api/src/client-controls/).
 *
 * The server is the gate: a shut-down environment answers 503
 * `{ code: 'APP_SUSPENDED', … }` on every non-exempt route and closes sockets
 * with 4503; a client below the floor gets 426 / 4426. Nothing here is
 * load-bearing — it only turns those signals into the blocking screens and
 * finds out when they lift.
 *
 * Signals are window CustomEvents (the same pattern as the long-standing
 * `cipherline:upgrade-required`), so the axios interceptor, the WebSocket hook
 * and the gate component stay decoupled:
 *
 *   APP_SUSPENDED_EVENT  — detail: SuspendedNotice | undefined. Fired by the
 *                          HTTP interceptor (503 APP_SUSPENDED), by
 *                          useRealtime (`app:suspended` event / close 4503) and
 *                          by the gate's own status checks.
 *   APP_RESUMED_EVENT    — fired by the gate once /v1/client-status says the
 *                          shutdown lifted. useRealtime redials on it.
 *   UPGRADE_REQUIRED_EVENT — the existing event; detail { minVersion }.
 *
 * This module imports no axios (useRealtime imports these constants, and its
 * test stubs `window` too thinly for axios's platform detection); the network
 * call lives in clientStatusFetch.ts.
 */

export const APP_SUSPENDED_EVENT = 'cipherline:app-suspended';
export const APP_RESUMED_EVENT = 'cipherline:app-resumed';
export const UPGRADE_REQUIRED_EVENT = 'cipherline:upgrade-required';
export const APP_SUSPENDED_CODE = 'APP_SUSPENDED';
/** WS close code the gateway uses for the kill switch. */
export const WS_CLOSE_APP_SUSPENDED = 4503;

/** What the blocking screen shows. Server-authored text, rendered as TEXT only. */
export interface SuspendedNotice {
    title: string;
    message: string;
    /** ISO "expected back" time, or null. Informational. */
    until: string | null;
    /** ISO time the shutdown started, or null. */
    since: string | null;
}

export interface ClientStatus {
    shutdown: SuspendedNotice | null;
    minVersionDesktop: string;
    updateUrl: string;
    retryAfterS: number;
    /** Closed-beta automatic diagnostics switched on server-side (`beta_diagnostics`). Absent/anything else → false. */
    betaDiagnostics: boolean;
}

const FALLBACK_TITLE = 'Cipherline is temporarily unavailable';
const FALLBACK_MESSAGE = 'We’ve paused the app for a moment. This screen will clear by itself as soon as we’re back.';
export const DEFAULT_UPDATE_URL = 'https://cipherline.chat/download';
const MAX_TITLE = 80;
const MAX_MESSAGE = 600;

/**
 * The download page the blocking "update required" screen opens. The server
 * may point it at a different page, but only on our own site: a value from
 * the network that the user is told to trust for a new installer must not be
 * able to send them anywhere else (a compromised or impersonated API would
 * otherwise get a one-click "download the update" link to any https host).
 * Anything else falls back to the default.
 */
export function pinUpdateUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 2048) return DEFAULT_UPDATE_URL;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' || u.hostname !== 'cipherline.chat' || u.port || u.username || u.password) {
            return DEFAULT_UPDATE_URL;
        }
        return u.href;
    } catch {
        return DEFAULT_UPDATE_URL;
    }
}

function str(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
}

function iso(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Normalise any server-supplied notice; never throws, always returns readable copy. */
export function toNotice(raw: unknown): SuspendedNotice {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        title: str(r.title, MAX_TITLE) ?? FALLBACK_TITLE,
        message: str(r.message, MAX_MESSAGE) ?? FALLBACK_MESSAGE,
        until: iso(r.until),
        since: iso(r.since),
    };
}

/** Is this HTTP error response the kill switch (as opposed to any other 503 — a proxy, a deploy)? */
export function isSuspendedResponse(status: number | undefined, data: unknown): boolean {
    return status === 503 && !!data && typeof data === 'object'
        && (data as { code?: unknown }).code === APP_SUSPENDED_CODE;
}

/** Parse GET /v1/client-status. Returns null for anything that is not that shape. */
export function parseClientStatus(raw: unknown): ClientStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!('shutdown' in r) || typeof r.min_version_desktop !== 'string') return null;
    const updateUrl = pinUpdateUrl(r.update_url);
    const retry = typeof r.retry_after_s === 'number' && Number.isFinite(r.retry_after_s) ? r.retry_after_s : 30;
    return {
        shutdown: r.shutdown ? toNotice(r.shutdown) : null,
        minVersionDesktop: r.min_version_desktop,
        updateUrl,
        retryAfterS: Math.min(Math.max(retry, 10), 300),
        betaDiagnostics: r.beta_diagnostics === true,
    };
}

// ── Versions ────────────────────────────────────────────────────────────────

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence: -1 / 0 / 1, or null if either side is not semver.
 * Numeric core, then prerelease (a prerelease ranks BELOW its release; ids
 * compare numerically when both are numeric, else lexically; numeric < alpha;
 * a shorter id list ranks first when all shared ids are equal).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
    const ma = SEMVER.exec(a.trim());
    const mb = SEMVER.exec(b.trim());
    if (!ma || !mb) return null;
    for (let i = 1; i <= 3; i++) {
        const x = Number(ma[i]);
        const y = Number(mb[i]);
        if (x !== y) return x < y ? -1 : 1;
    }
    const pa = ma[4];
    const pb = mb[4];
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    const ia = pa.split('.');
    const ib = pb.split('.');
    for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
        if (i >= ia.length) return -1;
        if (i >= ib.length) return 1;
        const x = ia[i];
        const y = ib[i];
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            const d = Number(x) - Number(y);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (nx !== ny) {
            return nx ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/** Mirrors the server's isBelowFloor: floor '0.0.0' is off; an unparseable OWN version is below any real floor. */
export function isBelowFloor(version: string, floor: string): boolean {
    if (!floor || floor === '0.0.0') return false;
    const c = compareVersions(version, floor);
    if (c === null) return compareVersions(floor, floor) !== null; // own version junk → below; junk floor → ignore
    return c < 0;
}

// ── Polling cadence while shut down ─────────────────────────────────────────

/** 30 s → 45 s → 68 s → … capped at 2 min, with ±10% jitter so a fleet doesn't poll in lockstep. */
export function nextPollDelayMs(attempt: number, baseMs = 30_000, maxMs = 120_000, rand: () => number = Math.random): number {
    const raw = Math.min(baseMs * Math.pow(1.5, Math.max(0, attempt)), maxMs);
    const jitter = 1 + (rand() * 0.2 - 0.1);
    return Math.round(Math.min(raw * jitter, maxMs));
}

// ── Formatting for the screens ──────────────────────────────────────────────

/** "in 2 h 5 min" / "in 4 min" / "any moment now" for an expected-back time. */
export function formatEta(untilIso: string | null, now: number = Date.now()): string | null {
    if (!untilIso) return null;
    const t = Date.parse(untilIso);
    if (!Number.isFinite(t)) return null;
    const ms = t - now;
    if (ms <= 60_000) return 'any moment now';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `in ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h >= 48) return `in ${Math.round(h / 24)} days`;
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

/** Dispatch helpers — keep the event shapes in one place. */
export function dispatchSuspended(notice?: SuspendedNotice): void {
    window.dispatchEvent(new CustomEvent(APP_SUSPENDED_EVENT, { detail: notice }));
}
export function dispatchResumed(): void {
    window.dispatchEvent(new CustomEvent(APP_RESUMED_EVENT));
}
export function dispatchUpgradeRequired(minVersion?: string): void {
    window.dispatchEvent(new CustomEvent(UPGRADE_REQUIRED_EVENT, { detail: { minVersion } }));
}
