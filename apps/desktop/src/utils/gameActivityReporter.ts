/**
 * Reports THIS connection's game to the server over the socket
 * (`presence:game`) — the half of "Playing X" that makes it expire on its own.
 *
 * The server (apps/api/src/gateway/presence.logic.ts resolvePublishedGame)
 * shows a user's game only while a present desktop connection is reporting it
 * AND has refreshed it within GAME_REPORT_TTL_MS (150 s). So this:
 *
 *   • sends the current game (or null) on every (re)connect — a new
 *     connection starts out unreported, and an unreported desktop connection
 *     makes the server fall back to the old per-user column, which is exactly
 *     what used to leave a stale game up;
 *   • sends it again on every change;
 *   • re-sends it every GAME_REPORT_REFRESH_MS while a game is running.
 *
 * It never has to say "stopped" for the game to go away: a crashed, asleep,
 * disconnected or signed-out desktop simply stops refreshing (or its
 * connection goes), and the server takes the game down.
 *
 * The REST PATCH (`game_name`) keeps being sent too, for servers that predate
 * `presence:game` — they ignore the unknown socket event.
 *
 * Rich Presence detail lines (`presence:game_detail`, utils/richPresence.ts)
 * ride along: sent after the game they belong to, re-sent on every
 * (re)connect, and COALESCED to at most one frame per DETAIL_MIN_INTERVAL_MS
 * (a game may rewrite its score line every second; friends do not need every
 * frame, and the server spaces its fan-out anyway). The last value always
 * goes out. A game change drops the detail (the server does the same).
 *
 * Pure of React; timers are injectable for tests.
 */
import { sameWireDetail, type WireGameDetail } from './richPresence';

/** Mirrors GAME_REPORT_REFRESH_MS in apps/api/src/gateway/presence.logic.ts. */
export const GAME_REPORT_REFRESH_MS = 60_000;

/** At most one `presence:game_detail` per this long (the last value always lands). */
export const DETAIL_MIN_INTERVAL_MS = 15_000;

export interface GameReporterTimers {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout?(fn: () => void, ms: number): unknown;
    clearTimeout?(handle: unknown): void;
    now?(): number;
}

const defaultTimers: GameReporterTimers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
};

export class GameActivityReporter {
    private game: string | null = null;
    private refresh: unknown = null;
    private readonly send: (game: string | null) => void;
    private readonly timers: GameReporterTimers;
    private readonly sendDetail: ((d: WireGameDetail | null) => void) | null;
    private detail: WireGameDetail | null = null;
    /** What the CURRENT connection was last told (undefined = nothing yet). */
    private sentDetail: WireGameDetail | null | undefined = undefined;
    private detailSentAt = -Infinity;
    private detailTimer: unknown = null;

    /** `send` delivers one `presence:game` frame on the current socket, if
     *  one is open (a no-op otherwise — the next connect re-sends).
     *  `sendDetail` likewise for `presence:game_detail`. */
    constructor(send: (game: string | null) => void, timers: GameReporterTimers = defaultTimers, sendDetail?: (d: WireGameDetail | null) => void) {
        this.send = send;
        this.timers = timers;
        this.sendDetail = sendDetail ?? null;
    }

    get currentDetail(): WireGameDetail | null { return this.detail; }

    /** The game's detail lines changed (null = none / not shared). Call after setGame. */
    setDetail(detail: WireGameDetail | null): void {
        const next = this.game ? detail : null;
        if (sameWireDetail(next, this.detail)) return;
        this.detail = next;
        this.flushDetail();
    }

    private now(): number { return this.timers.now ? this.timers.now() : Date.now(); }

    private flushDetail(): void {
        if (!this.sendDetail) return;
        if (this.sentDetail !== undefined && sameWireDetail(this.detail, this.sentDetail)) return;
        const wait = this.detailSentAt + DETAIL_MIN_INTERVAL_MS - this.now();
        if (wait > 0 && this.timers.setTimeout) {
            if (this.detailTimer === null) {
                this.detailTimer = this.timers.setTimeout(() => { this.detailTimer = null; this.flushDetail(); }, wait);
            }
            return;
        }
        this.sentDetail = this.detail;
        this.detailSentAt = this.now();
        this.sendDetail(this.detail);
    }

    private clearDetailTimer(): void {
        if (this.detailTimer !== null) this.timers.clearTimeout?.(this.detailTimer);
        this.detailTimer = null;
    }

    get current(): string | null { return this.game; }

    /** The detected game changed (null = none / detection switched off). */
    setGame(game: string | null): void {
        const next = game && game.trim() ? game : null;
        if (next === this.game) return;
        this.game = next;
        // A new game (or none) starts with no detail; the server agrees.
        this.detail = null;
        this.sentDetail = null;
        this.clearDetailTimer();
        this.send(next);
        this.schedule();
    }

    /** A new socket connection: it has reported nothing yet. */
    onConnected(): void {
        this.send(this.game);
        this.schedule();
        // The new connection knows no detail yet: tell it now (not coalesced).
        this.clearDetailTimer();
        this.sentDetail = null;
        if (this.detail && this.sendDetail) {
            this.sentDetail = this.detail;
            this.detailSentAt = this.now();
            this.sendDetail(this.detail);
        }
    }

    dispose(): void {
        if (this.refresh !== null) this.timers.clearInterval(this.refresh);
        this.refresh = null;
        this.clearDetailTimer();
    }

    private schedule(): void {
        this.dispose();
        if (!this.game) return;
        this.refresh = this.timers.setInterval(() => this.send(this.game), GAME_REPORT_REFRESH_MS);
    }
}
