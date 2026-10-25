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
 * Pure of React; timers are injectable for tests.
 */

/** Mirrors GAME_REPORT_REFRESH_MS in apps/api/src/gateway/presence.logic.ts. */
export const GAME_REPORT_REFRESH_MS = 60_000;

export interface GameReporterTimers {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

const defaultTimers: GameReporterTimers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class GameActivityReporter {
    private game: string | null = null;
    private refresh: unknown = null;
    private readonly send: (game: string | null) => void;
    private readonly timers: GameReporterTimers;

    /** `send` delivers one `presence:game` frame on the current socket, if
     *  one is open (a no-op otherwise — the next connect re-sends). */
    constructor(send: (game: string | null) => void, timers: GameReporterTimers = defaultTimers) {
        this.send = send;
        this.timers = timers;
    }

    get current(): string | null { return this.game; }

    /** The detected game changed (null = none / detection switched off). */
    setGame(game: string | null): void {
        const next = game && game.trim() ? game : null;
        if (next === this.game) return;
        this.game = next;
        this.send(next);
        this.schedule();
    }

    /** A new socket connection: it has reported nothing yet. */
    onConnected(): void {
        this.send(this.game);
        this.schedule();
    }

    dispose(): void {
        if (this.refresh !== null) this.timers.clearInterval(this.refresh);
        this.refresh = null;
    }

    private schedule(): void {
        this.dispose();
        if (!this.game) return;
        this.refresh = this.timers.setInterval(() => this.send(this.game), GAME_REPORT_REFRESH_MS);
    }
}
