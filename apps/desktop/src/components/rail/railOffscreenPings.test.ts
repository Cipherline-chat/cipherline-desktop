import { describe, it, expect } from 'vitest';
import {
    NO_OFFSCREEN_PINGS, PING_REVEAL_MARGIN, RAIL_DM_KEY, RAIL_GROUP_KEY, VISIBLE_FRACTION,
    isPingBadge, offscreenPings, pingAnnouncement, pingArrowCount, pingArrowLabel,
    pingedRailKeys, sameOffscreenPings, scrollTopForPing, type PingTileBox,
} from './railOffscreenPings';
import type { BadgeState } from '../../utils/unreadBadges';
import type { RailItem } from './serverFolders';

const alert = (count: number): BadgeState => ({ count, tone: 'alert' });
const quiet = (count: number): BadgeState => ({ count, tone: 'quiet' });

// A 300px-tall visible box; 44px tiles.
const H = 300;
const tile = (key: string, top: number, height = 44): PingTileBox => ({ key, top, height });

describe('isPingBadge — the rail red-badge rule', () => {
    it('alert with a count is a ping; quiet, zero and null are not', () => {
        expect(isPingBadge(alert(1))).toBe(true);
        expect(isPingBadge(quiet(4))).toBe(false);
        expect(isPingBadge(alert(0))).toBe(false);
        expect(isPingBadge(null)).toBe(false);
        expect(isPingBadge(undefined)).toBe(false);
    });
});

describe('pingedRailKeys', () => {
    const items: RailItem[] = [
        { kind: 'server', id: 'a' },
        { kind: 'folder', folder: { id: 'f1', name: 'F', color: null, serverIds: ['b', 'c'] } as never },
        { kind: 'server', id: 'd' },
        { kind: 'server', id: 'e' },
    ];
    const badges: Record<string, BadgeState | null> = { a: alert(2), b: null, c: alert(1), d: quiet(3), e: null };
    const serverBadge = (id: string) => badges[id] ?? null;

    it('DM/Group tiles, red servers and folders with a red server inside, in rail order; quiet dots excluded', () => {
        expect(pingedRailKeys({ dm: alert(1), group: quiet(2), items, serverBadge, activeServerId: null }))
            .toEqual([RAIL_DM_KEY, 'srv:a', 'fld:f1']);
    });

    it('the active server hides its own badge, so it is not a ping', () => {
        expect(pingedRailKeys({ dm: null, group: null, items, serverBadge, activeServerId: 'a' }))
            .toEqual(['fld:f1']);
    });

    it('a folder whose only red server is the active one is not a ping (matches the folder tile badge)', () => {
        expect(pingedRailKeys({ dm: null, group: null, items, serverBadge, activeServerId: 'c' }))
            .toEqual(['srv:a']);
    });

    it('a folder holding only quiet servers is not a ping', () => {
        const only: RailItem[] = [{ kind: 'folder', folder: { id: 'q', name: 'Q', color: null, serverIds: ['d'] } as never }];
        expect(pingedRailKeys({ dm: null, group: null, items: only, serverBadge, activeServerId: null })).toEqual([]);
    });

    it('a red Group tile counts too', () => {
        expect(pingedRailKeys({ dm: null, group: alert(5), items: [], serverBadge, activeServerId: null }))
            .toEqual([RAIL_GROUP_KEY]);
    });
});

describe('offscreenPings', () => {
    it('none: every pinged tile fully visible', () => {
        expect(offscreenPings([tile('a', 10), tile('b', 200)], H)).toBe(NO_OFFSCREEN_PINGS);
    });

    it('none: no pinged tiles at all', () => {
        expect(offscreenPings([], H)).toEqual({ above: 0, below: 0, nearestAbove: null, nearestBelow: null });
    });

    it('above only — nearest is the one closest to the top edge', () => {
        const r = offscreenPings([tile('far', -400), tile('near', -60), tile('vis', 100)], H);
        expect(r).toEqual({ above: 2, below: 0, nearestAbove: 'near', nearestBelow: null });
    });

    it('below only — nearest is the one closest to the bottom edge', () => {
        const r = offscreenPings([tile('near', 320), tile('far', 900)], H);
        expect(r).toEqual({ above: 0, below: 2, nearestAbove: null, nearestBelow: 'near' });
    });

    it('both directions at once', () => {
        const r = offscreenPings([tile('up', -100), tile('mid', 120), tile('down', 400), tile('down2', 500)], H);
        expect(r).toEqual({ above: 1, below: 2, nearestAbove: 'up', nearestBelow: 'down' });
    });

    it(`threshold: a tile exactly ${VISIBLE_FRACTION * 100}% shown counts as visible`, () => {
        expect(offscreenPings([tile('t', -22)], H).above).toBe(0);          // 22 of 44 shown at the top
        expect(offscreenPings([tile('b', H - 22)], H).below).toBe(0);       // 22 of 44 shown at the bottom
    });

    it('threshold: just under half shown counts as off-screen, in the right direction', () => {
        expect(offscreenPings([tile('t', -23)], H)).toMatchObject({ above: 1, nearestAbove: 't' });   // 21px shown
        expect(offscreenPings([tile('b', H - 21)], H)).toMatchObject({ below: 1, nearestBelow: 'b' }); // 21px shown
    });

    it('fully out by any amount is off-screen; a tile ending exactly at the top edge is above', () => {
        expect(offscreenPings([tile('t', -44)], H).above).toBe(1);
        expect(offscreenPings([tile('b', H)], H).below).toBe(1);
    });

    it('custom threshold is honoured', () => {
        // 30 of 44 (68%) shown: visible at 0.5, off-screen at 0.9.
        expect(offscreenPings([tile('t', -14)], H, 0.5).above).toBe(0);
        expect(offscreenPings([tile('t', -14)], H, 0.9).above).toBe(1);
    });

    it('tiles with no height (not laid out) and a zero-height box are ignored', () => {
        expect(offscreenPings([tile('x', -500, 0)], H)).toBe(NO_OFFSCREEN_PINGS);
        expect(offscreenPings([tile('x', -500)], 0)).toBe(NO_OFFSCREEN_PINGS);
    });

    it('a tile taller than the box straddling it is visible when half of it shows', () => {
        expect(offscreenPings([tile('big', -100, 500)], H).above + offscreenPings([tile('big', -100, 500)], H).below).toBe(0);
    });
});

describe('scrollTopForPing', () => {
    it('scrolls up so the tile lands clear of the top pill', () => {
        // tile 200px above the visible top, current scrollTop 500
        expect(scrollTopForPing(500, tile('t', -200), H)).toBe(500 - 200 - PING_REVEAL_MARGIN);
    });
    it('scrolls down so the tile lands clear of the bottom pill', () => {
        expect(scrollTopForPing(0, tile('b', 400), H)).toBe(400 + 44 - (H - PING_REVEAL_MARGIN));
    });
    it('never below 0', () => {
        expect(scrollTopForPing(10, tile('t', -6), H)).toBe(0);
    });
});

describe('labels, counts, equality', () => {
    it('labels read as a sentence', () => {
        expect(pingArrowLabel('up', 3)).toBe('3 unread pings above');
        expect(pingArrowLabel('down', 1)).toBe('1 unread ping below');
    });
    it('count is capped like the badges', () => {
        expect(pingArrowCount(1)).toBe('1');
        expect(pingArrowCount(9)).toBe('9');
        expect(pingArrowCount(10)).toBe('9+');
    });
    it('sameOffscreenPings compares every field', () => {
        const a = { above: 1, below: 0, nearestAbove: 'x', nearestBelow: null };
        expect(sameOffscreenPings(a, { ...a })).toBe(true);
        expect(sameOffscreenPings(a, { ...a, nearestAbove: 'y' })).toBe(false);
        expect(sameOffscreenPings(a, { ...a, below: 1 })).toBe(false);
    });
});

describe('pingAnnouncement — at most once per change, only for NEW pings', () => {
    const none = NO_OFFSCREEN_PINGS;
    const oneUp = { above: 1, below: 0, nearestAbove: 'a', nearestBelow: null };
    const twoUpOneDown = { above: 2, below: 1, nearestAbove: 'a', nearestBelow: 'b' };
    it('a new ping out of view is announced', () => {
        expect(pingAnnouncement(none, oneUp, true)).toBe('1 unread ping above in the server list');
        expect(pingAnnouncement(oneUp, twoUpOneDown, true)).toBe('2 unread pings above, 1 unread ping below in the server list');
    });
    it('the user scrolling a ping away is NOT announced', () => {
        expect(pingAnnouncement(none, oneUp, false)).toBeNull();
    });
    it('counts going down (read / revealed) are silent', () => {
        expect(pingAnnouncement(twoUpOneDown, oneUp, true)).toBeNull();
        expect(pingAnnouncement(oneUp, oneUp, true)).toBeNull();
    });
});
