import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.kv.get(k) ?? null,
        setItem: (k: string, v: string) => { h.kv.set(k, v); },
        removeItem: (k: string) => { h.kv.delete(k); },
    },
}));

import {
    parseWireGameDetail, parseBridgeDetail, toWireGameDetail, detailLines, detailSummary, partyLine, timeLine, clock,
    sameDetail, isEmptyDetail, sharedPreviewLines, DETAIL_TS_SKEW_MS, type GameDetail,
} from './richPresence';
import { GameActivityReporter, DETAIL_MIN_INTERVAL_MS } from './gameActivityReporter';
import { toEntry, applyPresenceEvent } from './presenceState';
import { statusLineModel } from './customStatus';
import {
    RPC_HELD_TIP_KEY, offerRichPresenceHeldTip, acknowledgeHeldTip, neverShowHeldTip, withdrawHeldTip, heldTipStore,
    shouldOfferHeldTip, __resetHeldTipForTests,
} from './richPresenceTip';
import { KV_RULES } from '../services/backupRegistry';

const NOW = 1_800_000_000_000;
const R6: GameDetail = { details: 'Ranked • Round 3', state: 'Score 2 – 1', partySize: 2, partyMax: 5, start: NOW - 754_000, end: null };
const R6_WIRE = { details: 'Ranked • Round 3', state: 'Score 2 – 1', party_size: 2, party_max: 5, start: NOW - 754_000, end: null };

describe('detail model: parse, format', () => {
    it('wire and bridge shapes parse to the same detail; round-trips', () => {
        expect(parseWireGameDetail(R6_WIRE, NOW)).toEqual(R6);
        expect(parseBridgeDetail(R6, NOW)).toEqual(R6);
        expect(parseWireGameDetail(toWireGameDetail(R6), NOW)).toEqual(R6);
    });

    it('drops what is out of bounds, field by field; nothing left → null', () => {
        expect(parseWireGameDetail({ details: 'x'.repeat(129), state: 'ok' }, NOW)).toMatchObject({ details: null, state: 'ok' });
        expect(parseWireGameDetail({ party_size: 6, party_max: 5 }, NOW)).toBeNull();
        expect(parseWireGameDetail({ party_size: 1.5, party_max: 5 }, NOW)).toBeNull();
        expect(parseWireGameDetail({ start: NOW - DETAIL_TS_SKEW_MS - 1 }, NOW)).toBeNull();
        expect(parseWireGameDetail({ start: '1' }, NOW)).toBeNull();
        expect(parseWireGameDetail('Ranked', NOW)).toBeNull();
        expect(parseWireGameDetail([R6_WIRE], NOW)).toBeNull();
        expect(isEmptyDetail(null)).toBe(true);
    });

    it('lines: details, state, party, live clock', () => {
        expect(detailLines(R6, NOW)).toEqual(['Ranked • Round 3', 'Score 2 – 1', 'Party 2 of 5', '12:34 elapsed']);
        expect(detailLines(R6, NOW + 1000)[3]).toBe('12:35 elapsed');
        expect(timeLine({ ...R6, end: NOW + 185_000 }, NOW)).toBe('3:05 left');
        expect(timeLine({ ...R6, start: null }, NOW)).toBeNull();
        expect(clock(3_725_000)).toBe('1:02:05');
        expect(partyLine({ ...R6, partyMax: null, partySize: null })).toBeNull();
        expect(detailSummary(R6)).toBe('Ranked • Round 3 · Score 2 – 1');
        expect(detailSummary({ ...R6, details: null, state: null })).toBe('Party 2 of 5');
    });
});

describe('a friend’s detail through the presence reducer', () => {
    const wire = { user_id: 'u1', status: 'online', game_name: "Tom Clancy's Rainbow Six Siege", game_detail: R6_WIRE };

    it('is kept with the game', () => {
        expect(toEntry(wire).current_game_detail).toMatchObject({ details: 'Ranked • Round 3', partyMax: 5 });
    });
    it('never without a game, never offline, never on a phone', () => {
        expect(toEntry({ ...wire, game_name: null }).current_game_detail ?? null).toBeNull();
        expect(toEntry({ ...wire, status: 'offline' }).current_game_detail ?? null).toBeNull();
        expect(toEntry({ ...wire, on_mobile: true }).current_game_detail ?? null).toBeNull();
    });
    it('a new round line is a change (re-render); the same one is not', () => {
        const prev = applyPresenceEvent({}, { kind: 'changed', entry: wire });
        expect(applyPresenceEvent(prev, { kind: 'changed', entry: wire })).toBe(prev);
        const next = applyPresenceEvent(prev, { kind: 'changed', entry: { ...wire, game_detail: { ...R6_WIRE, details: 'Ranked • Round 4' } } });
        expect(next).not.toBe(prev);
        expect(next.u1.current_game_detail?.details).toBe('Ranked • Round 4');
    });
    it('the member-list hover (status line tooltip) carries the lines', () => {
        const e = toEntry(wire);
        expect(statusLineModel(e, NOW).gameTooltip).toBe("Playing Tom Clancy's Rainbow Six Siege — Ranked • Round 3 · Score 2 – 1");
        expect(statusLineModel({ ...e, current_game_detail: null }, NOW).gameTooltip).toBe("Playing Tom Clancy's Rainbow Six Siege");
    });
});

describe('GameActivityReporter — presence:game_detail', () => {
    let games: Array<string | null>;
    let details: Array<unknown>;
    let r: GameActivityReporter;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        games = []; details = [];
        r = new GameActivityReporter(g => { games.push(g); }, undefined, d => { details.push(d); });
    });
    afterEach(() => { r.dispose(); vi.useRealTimers(); });

    it('detail goes out after its game; a game change drops it', () => {
        r.setGame('R6');
        r.setDetail(R6_WIRE);
        expect(games).toEqual(['R6']);
        expect(details).toEqual([R6_WIRE]);
        r.setGame('Chess');
        expect(r.currentDetail).toBeNull();
        r.setDetail(null);
        expect(details).toEqual([R6_WIRE]); // the server already dropped it with the game change
    });

    it('detail with no game is never sent', () => {
        r.setDetail(R6_WIRE);
        expect(details).toEqual([]);
    });

    it('coalesces: a score line rewritten every second sends at most one frame per interval, and the LAST value lands', () => {
        r.setGame('R6');
        r.setDetail(R6_WIRE);
        for (let i = 0; i < 30; i++) {
            vi.advanceTimersByTime(1000);
            r.setDetail({ ...R6_WIRE, state: `Score ${i} – 1` });
        }
        // 30 s of once-a-second changes → the first frame + one per 15 s window.
        expect(details.length).toBeLessThanOrEqual(1 + Math.ceil(30_000 / DETAIL_MIN_INTERVAL_MS));
        vi.advanceTimersByTime(DETAIL_MIN_INTERVAL_MS);
        expect(details.at(-1)).toMatchObject({ state: 'Score 29 – 1' });
    });

    it('positive control: without coalescing pressure every change is sent', () => {
        r.setGame('R6');
        r.setDetail(R6_WIRE);
        vi.advanceTimersByTime(DETAIL_MIN_INTERVAL_MS);
        r.setDetail({ ...R6_WIRE, state: 'Score 3 – 1' });
        vi.advanceTimersByTime(DETAIL_MIN_INTERVAL_MS);
        r.setDetail({ ...R6_WIRE, state: 'Score 4 – 1' });
        expect(details).toHaveLength(3);
    });

    it('a reconnect re-sends game then detail at once', () => {
        r.setGame('R6');
        r.setDetail(R6_WIRE);
        games = []; details = [];
        r.onConnected();
        expect(games).toEqual(['R6']);
        expect(details).toEqual([R6_WIRE]);
    });

    it('withdrawing (share details turned off) sends null', () => {
        r.setGame('R6');
        r.setDetail(R6_WIRE);
        vi.advanceTimersByTime(DETAIL_MIN_INTERVAL_MS);
        r.setDetail(null);
        expect(details.at(-1)).toBeNull();
    });
});

describe('Settings "What friends see" shows exactly what is shared', () => {
    it('sharing off → nothing; details off → name only; both on → name + lines', () => {
        expect(sharedPreviewLines('R6', R6, false, true, NOW)).toBeNull();
        expect(sharedPreviewLines('R6', R6, true, false, NOW)).toEqual(['Playing R6']);
        expect(sharedPreviewLines('R6', R6, true, true, NOW)).toEqual(['Playing R6', 'Ranked • Round 3', 'Score 2 – 1', 'Party 2 of 5', '12:34 elapsed']);
        expect(sharedPreviewLines(null, R6, true, true, NOW)).toBeNull();
    });
    it('matches what the reporter would send: the same detail, or none', () => {
        expect(sameDetail(parseWireGameDetail(toWireGameDetail(R6), NOW), R6)).toBe(true);
    });
});

describe('one-time "Discord is holding it" tip', () => {
    beforeEach(() => { h.kv.clear(); __resetHeldTipForTests(); });

    it('decision table', () => {
        const clean = { never: false, games: [] };
        expect(shouldOfferHeldTip(clean, 'R6', true, false)).toBe(true);
        expect(shouldOfferHeldTip(clean, 'R6', false, false)).toBe(false);          // game activity off
        expect(shouldOfferHeldTip(clean, 'R6', true, true)).toBe(false);            // already showing
        expect(shouldOfferHeldTip({ never: true, games: [] }, 'R6', true, false)).toBe(false);
        expect(shouldOfferHeldTip({ never: false, games: ['r6'] }, 'R6', true, false)).toBe(false);
        expect(shouldOfferHeldTip({ never: false, games: ['r6'] }, 'FiveM', true, false)).toBe(true);
    });

    it('"Got it" = not again for this game; another game can still show it', () => {
        expect(offerRichPresenceHeldTip('Rainbow Six Siege', true)).toBe(true);
        expect(heldTipStore.get()).toEqual({ name: 'Rainbow Six Siege' });
        acknowledgeHeldTip();
        expect(heldTipStore.get()).toBeNull();
        expect(offerRichPresenceHeldTip('Rainbow Six Siege', true)).toBe(false);
        expect(offerRichPresenceHeldTip('FiveM', true)).toBe(true);
    });

    it('"Don\'t show again" = never, any game; persisted in secureLocalStore', () => {
        offerRichPresenceHeldTip('FiveM', true);
        neverShowHeldTip();
        expect(JSON.parse(h.kv.get(RPC_HELD_TIP_KEY)!)).toMatchObject({ never: true });
        expect(offerRichPresenceHeldTip('Anything', true)).toBe(false);
    });

    it('never with game activity off; withdrawing records nothing', () => {
        expect(offerRichPresenceHeldTip('R6', false)).toBe(false);
        offerRichPresenceHeldTip('R6', true);
        withdrawHeldTip();
        expect(h.kv.has(RPC_HELD_TIP_KEY)).toBe(false);
        expect(offerRichPresenceHeldTip('R6', true)).toBe(true);
    });

    it('its key is classified in the backup registry as EXCLUDED', () => {
        const rule = KV_RULES.find(r => r.pattern === RPC_HELD_TIP_KEY);
        expect(rule).toMatchObject({ include: false });
    });
});
