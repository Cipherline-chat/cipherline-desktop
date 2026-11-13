/**
 * Network timing for the diagnostics report: how long the API calls this
 * session took, in aggregate, so "the servers feel slow" reports show WHICH
 * request was slow instead of nothing.
 *
 * PRIVACY (CLAUDE.md "No metadata leakage"). Nothing here can say who or what
 * a request was about:
 *   - the path is reduced to a PATTERN. Only a segment that looks like a fixed
 *     route word (`[a-z][a-z_-]{0,23}`) survives; every id, number, hash,
 *     mixed-case token, name with a digit or dot is `:id`. Segments that follow
 *     a user-supplied-slug route (invite codes, username lookups, search) are
 *     `:id` regardless. The query string and fragment are dropped, as is the
 *     host (a request to anything but the API is just `(external)`);
 *   - no headers, bodies, tokens, user names or message content are touched;
 *   - state is memory only (nothing is persisted), and capped: at most
 *     MAX_PATTERNS patterns, MAX_SAMPLES durations each, SLOWEST_N slow rows,
 *     MAX_WS_ROWS socket rows. The snapshot is a few KB.
 *
 * Timestamps are seconds since the page loaded, never wall-clock times.
 */

export const MAX_PATTERNS = 60;
export const MAX_SAMPLES = 200;
export const SLOWEST_N = 10;
export const MAX_WS_ROWS = 12;
/** Route words after which the next segment is caller-chosen text, not an id. */
const SLUG_PARENTS = new Set([
    'invite', 'invites', 'ref', 'join', 'search', 'username', 'usernames', 'by-username',
    'lookup', 'handle', 'handles', 'code', 'codes', 'name', 'names', 'tag', 'tags', 'q',
]);
const WORD = /^[a-z][a-z_-]{0,23}$/;
const MAX_SEGMENTS = 7;
const EXTERNAL = '(external)';
const OTHER = '(other)';

/**
 * `https://api.x/v1/servers/<uuid>/channels?a=b` → `servers/:id/channels`.
 * `apiHost` is the host of the API; any other absolute URL → `(external)`.
 */
export function endpointPattern(rawUrl: string, apiHost: string | null): string {
    let path = String(rawUrl ?? '');
    const abs = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i.exec(path);
    if (abs) {
        const host = abs[1].toLowerCase();
        if (!apiHost || host !== apiHost.toLowerCase()) return EXTERNAL;
        path = abs[2];
    }
    path = path.split('#')[0].split('?')[0];
    const segs = path.split('/').filter(Boolean);
    if (segs[0] && /^v\d{1,2}$/.test(segs[0])) segs.shift();
    const out: string[] = [];
    let prevSlugParent = false;
    for (const s of segs.slice(0, MAX_SEGMENTS)) {
        if (!prevSlugParent && WORD.test(s)) {
            out.push(s);
            prevSlugParent = SLUG_PARENTS.has(s);
        } else {
            out.push(':id');
            prevSlugParent = false;
        }
    }
    if (segs.length > MAX_SEGMENTS) out.push('…');
    return out.join('/') || '/';
}

function quantile(sorted: readonly number[], q: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
}

interface Bucket { n: number; err: number; maxMs: number; samples: number[]; }
const newBucket = (): Bucket => ({ n: 0, err: 0, maxMs: 0, samples: [] });

function addSample(b: Bucket, ms: number, failed: boolean): void {
    b.n++;
    if (failed) b.err++;
    if (ms > b.maxMs) b.maxMs = ms;
    // Reservoir: keeps a uniform sample once full, so p50/p95 stay honest on a long session.
    if (b.samples.length < MAX_SAMPLES) b.samples.push(ms);
    else {
        const j = Math.floor(Math.random() * b.n);
        if (j < MAX_SAMPLES) b.samples[j] = ms;
    }
}

function summarise(b: Bucket) {
    const s = [...b.samples].sort((a, c) => a - c);
    return { n: b.n, err: b.err, p50: Math.round(quantile(s, 0.5)), p95: Math.round(quantile(s, 0.95)), max: Math.round(b.maxMs) };
}

export type OpenKind = 'server_open' | 'channel_open_first' | 'channel_open_revisit';
export interface SlowRequest { t_s: number; ep: string; ms: number; status: string; }
export interface NetTimingSnapshot {
    requests_total: number;
    errors_total: number;
    /** Highest number of API requests in flight at once. */
    max_in_flight: number;
    endpoints: Array<{ ep: string; n: number; err: number; p50: number; p95: number; max: number }>;
    slowest: SlowRequest[];
    ws: Array<{ t_s: number; kind: 'connect' | 'reconnect'; ms: number }>;
    ws_connects: number;
    /** Click to first messages on screen (server / first channel visit / revisit). */
    opens: Array<{ kind: OpenKind; n: number; p50: number; p95: number; max: number }>;
}

export interface NetTimingOptions {
    /** Host of the API (`api.cipherline.chat`); any other host is `(external)`. */
    apiHost: string | null;
    /** Monotonic ms clock. */
    now?: () => number;
}

export interface NetTimingRecorder {
    /** Call when a request leaves; returns a function to call once it settles. */
    begin(method: string, url: string): (status: number | null) => void;
    wsOpened(ms: number): void;
    open(kind: OpenKind, ms: number): void;
    snapshot(): NetTimingSnapshot;
    reset(): void;
}

function statusClass(status: number | null): string {
    if (status === null) return 'err';
    if (status >= 200 && status < 300) return '2xx';
    if (status >= 300 && status < 400) return '3xx';
    if (status >= 400 && status < 500) return status === 429 ? '429' : '4xx';
    return '5xx';
}

export function createNetTiming(opts: NetTimingOptions): NetTimingRecorder {
    const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    let buckets = new Map<string, Bucket>();
    let slowest: Array<SlowRequest & { _k: number }> = [];
    let ws: NetTimingSnapshot['ws'] = [];
    let wsCount = 0;
    let opens = new Map<OpenKind, Bucket>();
    let total = 0, errors = 0, inFlight = 0, maxInFlight = 0;

    return {
        begin(method, url) {
            const key = `${String(method || 'GET').toUpperCase().slice(0, 7)} ${endpointPattern(url, opts.apiHost)}`;
            const t0 = now();
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            let done = false;
            return (status) => {
                if (done) return;
                done = true;
                inFlight = Math.max(0, inFlight - 1);
                const ms = Math.max(0, now() - t0);
                const failed = status === null || status >= 400;
                total++;
                if (failed) errors++;
                let ep = key;
                if (!buckets.has(ep) && buckets.size >= MAX_PATTERNS) ep = OTHER;
                let b = buckets.get(ep);
                if (!b) { b = newBucket(); buckets.set(ep, b); }
                addSample(b, ms, failed);
                const row = { t_s: Math.round(t0 / 100) / 10, ep: key, ms: Math.round(ms), status: statusClass(status), _k: ms };
                if (slowest.length < SLOWEST_N) slowest.push(row);
                else {
                    let min = 0;
                    for (let i = 1; i < slowest.length; i++) if (slowest[i]._k < slowest[min]._k) min = i;
                    if (ms > slowest[min]._k) slowest[min] = row;
                }
            };
        },
        wsOpened(ms) {
            wsCount++;
            ws.push({ t_s: Math.round(now() / 100) / 10, kind: wsCount === 1 ? 'connect' : 'reconnect', ms: Math.round(ms) });
            if (ws.length > MAX_WS_ROWS) ws = [ws[0], ...ws.slice(-(MAX_WS_ROWS - 1))];
        },
        open(kind, ms) {
            let b = opens.get(kind);
            if (!b) { b = newBucket(); opens.set(kind, b); }
            addSample(b, Math.max(0, ms), false);
        },
        snapshot() {
            const endpoints = [...buckets.entries()]
                .map(([ep, b]) => ({ ep, ...summarise(b) }))
                // Slowest-to-matter first; a capped report drops the tail.
                .sort((a, b) => b.p95 * b.n - a.p95 * a.n)
                .map(r => ({ ep: r.ep, n: r.n, err: r.err, p50: r.p50, p95: r.p95, max: r.max }));
            return {
                requests_total: total,
                errors_total: errors,
                max_in_flight: maxInFlight,
                endpoints,
                slowest: [...slowest].sort((a, b) => b.ms - a.ms).map(({ _k, ...r }) => r),
                ws: [...ws],
                ws_connects: wsCount,
                opens: [...opens.entries()].map(([kind, b]) => {
                    const s = summarise(b);
                    return { kind, n: s.n, p50: s.p50, p95: s.p95, max: s.max };
                }),
            };
        },
        reset() {
            buckets = new Map(); slowest = []; ws = []; wsCount = 0; opens = new Map();
            total = 0; errors = 0; inFlight = 0; maxInFlight = 0;
        },
    };
}

// ── Process-wide recorder ────────────────────────────────────────────────────

let singleton: NetTimingRecorder | null = null;

/** Set once at boot (`httpBootstrap`) with the REST base URL. */
export function initNetTiming(apiBase: string): NetTimingRecorder {
    let host: string | null = null;
    try { host = new URL(apiBase).host; } catch { /* relative base: only same-host (relative) URLs match */ }
    singleton = createNetTiming({ apiHost: host });
    return singleton;
}

/** The process recorder, or a no-op-safe empty one before init. */
export function netTiming(): NetTimingRecorder {
    if (!singleton) singleton = createNetTiming({ apiHost: null });
    return singleton;
}
