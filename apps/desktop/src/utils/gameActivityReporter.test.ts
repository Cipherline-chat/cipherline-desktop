import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameActivityReporter, GAME_REPORT_REFRESH_MS } from './gameActivityReporter';

/**
 * The client half of "Playing X expires on its own": the server only shows a
 * game a connection keeps refreshing (apps/api presence.logic.ts,
 * GAME_REPORT_TTL_MS = 150 s). These pin what this machine sends.
 */
describe('GameActivityReporter', () => {
    let sent: Array<string | null>;
    let r: GameActivityReporter;
    beforeEach(() => {
        vi.useFakeTimers();
        sent = [];
        r = new GameActivityReporter(g => { sent.push(g); });
    });
    afterEach(() => { r.dispose(); vi.useRealTimers(); });

    it('reports "no game" on connect, so the connection is never read as an older client', () => {
        r.onConnected();
        expect(sent).toEqual([null]);
    });

    it('reports a change at once, and nothing for a repeat', () => {
        r.onConnected();
        r.setGame('Marvel Rivals');
        r.setGame('Marvel Rivals');
        r.setGame(null);
        expect(sent).toEqual([null, 'Marvel Rivals', null]);
    });

    it('re-asserts a running game every refresh period (inside the server TTL)', () => {
        r.setGame('Marvel Rivals');
        vi.advanceTimersByTime(3 * GAME_REPORT_REFRESH_MS);
        expect(sent).toEqual(['Marvel Rivals', 'Marvel Rivals', 'Marvel Rivals', 'Marvel Rivals']);
        expect(GAME_REPORT_REFRESH_MS * 2).toBeLessThanOrEqual(150_000);
    });

    it('stops refreshing once the game stops — the server then drops it even if "stopped" was lost', () => {
        r.setGame('Marvel Rivals');
        r.setGame(null);
        const before = sent.length;
        vi.advanceTimersByTime(10 * GAME_REPORT_REFRESH_MS);
        expect(sent.length).toBe(before);
    });

    it('re-sends the current game on every reconnect (a new connection starts unreported)', () => {
        r.setGame('Chess');
        r.onConnected();
        expect(sent).toEqual(['Chess', 'Chess']);
    });

    it('treats a blank name as no game', () => {
        r.setGame('   ');
        expect(sent).toEqual([]);
        expect(r.current).toBeNull();
    });

    it('dispose stops the refresh', () => {
        r.setGame('Chess');
        r.dispose();
        vi.advanceTimersByTime(5 * GAME_REPORT_REFRESH_MS);
        expect(sent).toEqual(['Chess']);
    });
});
