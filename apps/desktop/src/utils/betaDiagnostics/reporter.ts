/**
 * Beta diagnostics reporter — the closed-beta automatic failure reports,
 * device profile and call-quality summaries (shared contract v1).
 *
 * GATING. Nothing is sent — and nothing is even QUEUED for sending — unless
 * all three hold:
 *   1. the server said `beta_diagnostics: true` in GET /v1/client-status
 *      (ClientControlGate feeds that in, at boot and on every reconnect);
 *   2. the user's local "Share beta diagnostics" toggle is on (default ON);
 *   3. someone is signed in (the server links reports to the account).
 * Any of them going false drops whatever is queued on the spot.
 *
 * VOLUME. Batches flush every FLUSH_INTERVAL_MS or at FLUSH_AT events,
 * best-effort on quit. Identical events (same kind + fingerprint) within
 * DEDUPE_WINDOW_MS: the first goes out as it happened, the repeats are
 * folded into ONE follow-up event when the window closes, carrying
 * `detail.count` (how many repeats). At most HOURLY_CAP events per hour.
 *
 * OFFLINE. The queue is in memory only (never written to disk) and bounded
 * (MAX_QUEUE, oldest dropped). A failed send (offline, 5xx, 429) keeps the
 * batch for the next tick; a 4xx (the server refused the shape) drops it.
 *
 * NEVER THROWS. Every entry point is wrapped; diagnostics must not be able to
 * break the code that reports through them, nor block the UI (all sending is
 * async, hashing is WebCrypto).
 *
 * The transport (axios + auth headers) is injected by the host component so
 * this module imports no network code and is unit-testable as is.
 */
import {
    sanitizeDetail, fingerprintSource, normalizeFrames, scrubMessage, sha256Hex, newUuid, errorNameOf,
    MAX_DETAIL_KEYS,
} from './sanitize';
import {
    BETA_SCHEMA, BETA_EVENT_KINDS,
    type BetaCallSummaryBody, type BetaDetail, type BetaEvent, type BetaEventKind, type BetaEventsBody,
    type BetaCallRatingBody, type BetaPlatform, type BetaProfileBody, type RatingTag,
} from './types';

export const FLUSH_INTERVAL_MS = 60_000;
export const FLUSH_AT = 20;
export const MAX_BATCH = 50;
export const DEDUPE_WINDOW_MS = 10 * 60_000;
export const HOURLY_CAP = 200;
export const MAX_QUEUE = 200;
const HOUR_MS = 60 * 60_000;
const MAX_SUMMARIES_KEPT = 5;

export type BetaRoute = 'events' | 'profile' | 'call-summary';
/** ok: delivered (or deliberately dropped by the server); retry: keep it for the next tick. */
export type BetaSendResult = { ok: true } | { ok: false; retry: boolean };
export type BetaTransport = (route: BetaRoute, body: object) => Promise<BetaSendResult>;

/**
 * HTTP status → what to do with the batch. The routes answer 204 (also while
 * the server switch is off). A 4xx is a refused shape (or, for a rating, an
 * unknown call_summary_id) and would be refused again: drop it. 408 / 429 /
 * 5xx / no response: keep it for the next tick.
 */
export function classifyBetaSend(status: number | undefined): BetaSendResult {
    if (status !== undefined && status >= 200 && status < 300) return { ok: true };
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return { ok: false, retry: false };
    return { ok: false, retry: true };
}

export interface ReportOptions {
    detail?: Record<string, unknown>;
    /** The thrown value, for unhandled_error: name, scrubbed message, frames. */
    error?: unknown;
}

interface Pending {
    kind: BetaEventKind;
    atMs: number;
    fpSource: string;
    message?: string;
    detail?: BetaDetail;
}

interface DedupeWindow {
    firstAt: number;
    kind: BetaEventKind;
    fpSource: string;
    detail?: BetaDetail;
    repeats: number;
}

export interface BetaState {
    serverEnabled: boolean;
    localEnabled: boolean;
    signedIn: boolean;
    /** All three — reports are being collected and sent. */
    active: boolean;
}

const now = (): number => Date.now();

function platformGuess(): BetaPlatform {
    try {
        const p = (globalThis as { window?: { electronAPI?: { platform?: string } } }).window?.electronAPI?.platform;
        if (p === 'windows') return 'win32';
        if (p === 'mac') return 'darwin';
        if (p === 'linux') return 'linux';
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        return /Windows/i.test(ua) ? 'win32' : /Mac OS/i.test(ua) ? 'darwin' : 'linux';
    } catch {
        return 'linux';
    }
}

export class BetaReporter {
    readonly sessionId: string;
    private appVersion: string;
    private platform: BetaPlatform;
    private transport: BetaTransport | null = null;
    private serverEnabled = false;
    private localEnabled = true;
    private signedIn = false;
    private queue: Pending[] = [];
    private windows = new Map<string, DedupeWindow>();
    private sentTimes: number[] = [];
    private pendingProfile: BetaProfileBody | null = null;
    private profileSent = false;
    private pendingSummaries: Array<BetaCallSummaryBody | BetaCallRatingBody> = [];
    private summaries: BetaCallSummaryBody[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing: Promise<void> | null = null;
    private listeners = new Set<() => void>();
    private stateCache: BetaState;
    private readonly clock: () => number;

    constructor(o: { appVersion?: string; platform?: BetaPlatform; sessionId?: string; clock?: () => number } = {}) {
        this.sessionId = o.sessionId ?? newUuid();
        this.appVersion = o.appVersion ?? '0.0.0';
        this.platform = o.platform ?? platformGuess();
        this.clock = o.clock ?? now;
        this.stateCache = this.computeState();
    }

    // ── configuration ────────────────────────────────────────────────────

    configure(o: { appVersion?: string; platform?: BetaPlatform; transport?: BetaTransport | null }): void {
        if (o.appVersion) this.appVersion = o.appVersion;
        if (o.platform) this.platform = o.platform;
        if (o.transport !== undefined) this.transport = o.transport;
    }

    setServerEnabled(on: boolean): void { this.setGate({ serverEnabled: !!on }); }
    setLocalEnabled(on: boolean): void { this.setGate({ localEnabled: !!on }); }
    setSignedIn(on: boolean): void { this.setGate({ signedIn: !!on }); }

    private setGate(p: Partial<Pick<BetaState, 'serverEnabled' | 'localEnabled' | 'signedIn'>>): void {
        try {
            if (p.serverEnabled !== undefined) this.serverEnabled = p.serverEnabled;
            if (p.localEnabled !== undefined) this.localEnabled = p.localEnabled;
            if (p.signedIn !== undefined) this.signedIn = p.signedIn;
            const prev = this.stateCache;
            this.stateCache = this.computeState();
            if (!this.stateCache.active) this.dropEverything();
            this.syncTimer();
            if (prev.active !== this.stateCache.active || prev.serverEnabled !== this.stateCache.serverEnabled
                || prev.localEnabled !== this.stateCache.localEnabled || prev.signedIn !== this.stateCache.signedIn) {
                for (const l of [...this.listeners]) { try { l(); } catch { /* isolate */ } }
            }
        } catch { /* never throws */ }
    }

    private computeState(): BetaState {
        return {
            serverEnabled: this.serverEnabled,
            localEnabled: this.localEnabled,
            signedIn: this.signedIn,
            active: this.serverEnabled && this.localEnabled && this.signedIn,
        };
    }

    getState(): BetaState { return this.stateCache; }
    isActive(): boolean { return this.stateCache.active; }

    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    private dropEverything(): void {
        this.queue = [];
        this.windows.clear();
        this.pendingProfile = null;
        this.pendingSummaries = [];
        this.summaries = [];
    }

    private syncTimer(): void {
        if (this.stateCache.active && !this.timer) {
            this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
            (this.timer as { unref?: () => void }).unref?.();
        } else if (!this.stateCache.active && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // ── events ───────────────────────────────────────────────────────────

    private underCap(at: number): boolean {
        const cutoff = at - HOUR_MS;
        while (this.sentTimes.length && this.sentTimes[0] <= cutoff) this.sentTimes.shift();
        return this.sentTimes.length < HOURLY_CAP;
    }

    private enqueue(p: Pending): void {
        if (!this.underCap(p.atMs)) return;
        this.sentTimes.push(p.atMs);
        this.queue.push(p);
        if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }

    report(kind: BetaEventKind, opts: ReportOptions = {}): void {
        try {
            if (!this.stateCache.active) return;
            if (!(BETA_EVENT_KINDS as readonly string[]).includes(kind)) return;
            const at = this.clock();
            this.sweepWindows(at);
            // One key slot is kept for the follow-up's `count`.
            let detail = sanitizeDetail(opts.detail);
            if (detail && Object.keys(detail).length > MAX_DETAIL_KEYS - 1) {
                detail = Object.fromEntries(Object.entries(detail).slice(0, MAX_DETAIL_KEYS - 1));
            }
            let message: string | undefined;
            let frames: string[] = [];
            let errorName: string | undefined;
            if (opts.error !== undefined) {
                const e = opts.error as { message?: unknown; stack?: unknown } | null;
                errorName = errorNameOf(opts.error);
                const raw = e && typeof e === 'object' && 'message' in e ? e.message : opts.error;
                // Free text only ever travels with unhandled_error (contract);
                // every other kind is described by its enum detail alone.
                if (kind === 'unhandled_error') message = scrubMessage(raw) || undefined;
                frames = normalizeFrames(e && typeof e === 'object' ? e.stack : undefined);
                if (errorName || frames.length) {
                    detail = { ...(detail ?? {}) };
                    if (errorName) detail.name = errorName;
                    if (frames[0]) {
                        const [fn, file] = frames[0].split('@');
                        if (/^[A-Za-z0-9_.:-]{1,64}$/.test(file)) detail.frame = file;
                        if (/^[A-Za-z0-9_.:-]{1,64}$/.test(fn)) detail.fn = fn;
                    }
                    detail = sanitizeDetail(detail);
                }
            }
            const fpSource = fingerprintSource(kind, { frames, errorName, detail });
            const w = this.windows.get(fpSource);
            if (w && at - w.firstAt < DEDUPE_WINDOW_MS) {
                w.repeats += typeof detail?.count === 'number' ? detail.count : 1;
                return;
            }
            this.windows.set(fpSource, { firstAt: at, kind, fpSource, detail, repeats: 0 });
            this.enqueue({ kind, atMs: at, fpSource, message, detail });
            if (this.queue.length >= FLUSH_AT) void this.flush();
        } catch { /* never throws */ }
    }

    /** Close expired dedupe windows: their repeats become one `count` event. */
    private sweepWindows(at: number): void {
        for (const [key, w] of this.windows) {
            if (at - w.firstAt < DEDUPE_WINDOW_MS) continue;
            this.windows.delete(key);
            if (w.repeats > 0) {
                this.enqueue({ kind: w.kind, atMs: at, fpSource: w.fpSource, detail: { ...(w.detail ?? {}), count: w.repeats } });
            }
        }
    }

    // ── profile / call summaries ─────────────────────────────────────────

    /** Queue the device profile; sent once per app session (again only if it changed). */
    sendProfile(profile: Omit<BetaProfileBody, 'schema' | 'session_id' | 'app_version' | 'platform'>): void {
        try {
            if (!this.stateCache.active) return;
            const body: BetaProfileBody = { schema: BETA_SCHEMA, session_id: this.sessionId, app_version: this.appVersion, platform: this.platform, ...profile };
            if (this.profileSent && this.lastProfileJson === JSON.stringify(body)) return;
            this.pendingProfile = body;
            void this.flush();
        } catch { /* never throws */ }
    }
    private lastProfileJson = '';

    /** Queue a call summary (call end). Returns its id, for a later rating; null when inactive. */
    sendCallSummary(summary: Omit<BetaCallSummaryBody, 'schema' | 'session_id' | 'app_version' | 'platform' | 'call_summary_id'>): string | null {
        try {
            if (!this.stateCache.active) return null;
            const body: BetaCallSummaryBody = {
                schema: BETA_SCHEMA, call_summary_id: newUuid(), session_id: this.sessionId,
                app_version: this.appVersion, platform: this.platform, ...summary,
            };
            this.summaries.push(body);
            if (this.summaries.length > MAX_SUMMARIES_KEPT) this.summaries.shift();
            this.pendingSummaries.push(body);
            void this.flush();
            return body.call_summary_id;
        } catch {
            return null;
        }
    }

    /**
     * The 1-tap rating, to the same route under the same call_summary_id. If
     * the summary itself has not gone out yet, the rating rides inside it;
     * otherwise a rating-only body is sent (the server attaches it to the
     * stored summary and never overwrites metrics — an unknown id is a
     * non-fatal 400, dropped like any refused shape).
     */
    rateCall(callSummaryId: string, rating: 1 | 2 | 3 | 4 | 5, tags: readonly RatingTag[] = []): boolean {
        try {
            if (!this.stateCache.active) return false;
            const s = this.summaries.find(x => x.call_summary_id === callSummaryId);
            if (!s || !(rating >= 1 && rating <= 5)) return false;
            const extra = { rating, ...(tags.length ? { rating_tags: [...new Set(tags)] } : {}) };
            const pending = this.pendingSummaries.findIndex(x => x.call_summary_id === callSummaryId && 'call_type' in x);
            if (pending >= 0) {
                this.pendingSummaries[pending] = { ...(this.pendingSummaries[pending] as BetaCallSummaryBody), ...extra };
            } else {
                this.pendingSummaries = this.pendingSummaries.filter(x => x.call_summary_id !== callSummaryId);
                this.pendingSummaries.push({
                    schema: BETA_SCHEMA, call_summary_id: callSummaryId, session_id: s.session_id,
                    app_version: s.app_version, platform: s.platform, ...extra,
                });
            }
            void this.flush();
            return true;
        } catch {
            return false;
        }
    }

    // ── sending ──────────────────────────────────────────────────────────

    /** Send what is queued. Concurrent calls share one run. Never rejects. */
    flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        this.flushing = this.doFlush().catch(() => { /* never rejects */ }).finally(() => { this.flushing = null; });
        return this.flushing;
    }

    private async doFlush(): Promise<void> {
        if (!this.stateCache.active || !this.transport) return;
        this.sweepWindows(this.clock());
        const send = this.transport;

        if (this.pendingProfile) {
            const body = this.pendingProfile;
            const r = await send('profile', body);
            if (r.ok || !r.retry) {
                if (this.pendingProfile === body) this.pendingProfile = null;
                if (r.ok) { this.profileSent = true; this.lastProfileJson = JSON.stringify(body); }
            }
        }

        while (this.pendingSummaries.length && this.stateCache.active) {
            const body = this.pendingSummaries[0];
            const r = await send('call-summary', body);
            if (!r.ok && r.retry) break;
            this.pendingSummaries = this.pendingSummaries.filter(x => x !== body);
        }

        while (this.queue.length && this.stateCache.active) {
            const batch = this.queue.slice(0, MAX_BATCH);
            const events: BetaEvent[] = [];
            for (const p of batch) {
                const ev: BetaEvent = { kind: p.kind, at: new Date(p.atMs).toISOString() };
                try { ev.fingerprint = await sha256Hex(p.fpSource); } catch { /* no WebCrypto: omit */ }
                if (p.message) ev.message = p.message;
                if (p.detail) ev.detail = p.detail;
                events.push(ev);
            }
            const body: BetaEventsBody = {
                schema: BETA_SCHEMA, session_id: this.sessionId, app_version: this.appVersion, platform: this.platform, events,
            };
            const r = await send('events', body);
            if (!r.ok && r.retry) break;
            // Delivered or refused: these are done (a refused shape would only be refused again).
            this.queue = this.queue.filter(p => !batch.includes(p));
        }
    }

    // ── tests ────────────────────────────────────────────────────────────

    /** Test hook: what is queued right now (no hashing). */
    peekQueue(): ReadonlyArray<{ kind: BetaEventKind; detail?: BetaDetail; message?: string }> {
        return this.queue.map(p => ({ kind: p.kind, ...(p.detail ? { detail: p.detail } : {}), ...(p.message ? { message: p.message } : {}) }));
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.listeners.clear();
        this.dropEverything();
    }
}

/** The app-wide reporter. */
export const betaReporter = new BetaReporter();

/**
 * Report one event. The ONE call sites use — safe anywhere: never throws,
 * does nothing unless beta diagnostics is active.
 */
export function reportBeta(kind: BetaEventKind, detail?: Record<string, unknown>, error?: unknown): void {
    betaReporter.report(kind, { detail, ...(error !== undefined ? { error } : {}) });
}

/** Is collection on right now? Detectors use it to skip work entirely when off. */
export function isBetaActive(): boolean {
    return betaReporter.isActive();
}
