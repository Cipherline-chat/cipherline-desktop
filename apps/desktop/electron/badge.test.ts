import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// The overlay only exists on Windows; pretend, for the module under test.
const realPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); });

const created: number[] = [];
vi.mock('electron', () => ({
    app: { dock: undefined, setBadgeCount: () => {} },
    nativeImage: { createFromBuffer: (b: Buffer) => { created.push(b.length); return { b }; }, createFromDataURL: () => ({ resize: () => ({}) }), createFromPath: () => ({ resize: () => ({}) }) },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    BrowserWindow: class {},
}));

const { applyWindowsCallOverlay, setBadgeCount } = await import('./badge');
const { setTrayCallState } = await import('./tray');

function fakeWin() {
    const calls: Array<string | null> = [];
    return {
        calls,
        win: {
            isDestroyed: () => false,
            setOverlayIcon: (img: unknown, desc: string) => { calls.push(img ? desc : null); },
        } as never,
    };
}

describe('Windows taskbar overlay — only real changes reach Explorer', () => {
    it('speaking on/off in a call (overlay unchanged) does not re-send the overlay', () => {
        const { win, calls } = fakeWin();
        for (let i = 0; i < 20; i++) {
            setTrayCallState(true, i % 2 === 0, false, false);   // speaking toggles
            applyWindowsCallOverlay(win);
        }
        expect(calls).toEqual([null]);                           // cleared once
        setTrayCallState(true, false, true, false);                // mute → one real change
        applyWindowsCallOverlay(win);
        applyWindowsCallOverlay(win);
        expect(calls).toEqual([null, 'Muted']);
    });

    it('the unread badge PNG is encoded once, and a changed count still updates the label', () => {
        const { win, calls } = fakeWin();
        setTrayCallState(false, false, false, false);
        const before = created.length;
        setBadgeCount(win as never, 3);
        setBadgeCount(win as never, 3);
        setBadgeCount(win as never, 4);
        expect(calls).toEqual(['3 unread', '4 unread']);
        expect(created.length - before).toBeLessThanOrEqual(2);  // nativeImage per apply, PNG cached
    });
});

describe('Windows taskbar overlay — one glyph, mention > deafened > muted > unread', () => {
    it('walks the whole priority ladder, one Explorer call per real change', () => {
        const { win, calls } = fakeWin();
        setTrayCallState(false, false, false, false);
        setBadgeCount(win as never, 0, false);                       // clean slate
        calls.length = 0;

        setTrayCallState(true, false, true, true);                   // in call, deafened (and muted)
        applyWindowsCallOverlay(win);
        setBadgeCount(win as never, 2, false);                       // unread arrives: deafened still wins
        setTrayCallState(true, false, true, false);                  // undeafen: muted
        applyWindowsCallOverlay(win);
        setBadgeCount(win as never, 2, true);                        // @mention: outranks the call state
        setTrayCallState(true, true, false, true);                   // deafen again: still the mention
        applyWindowsCallOverlay(win);
        setBadgeCount(win as never, 2, false);                       // mention read: deafened returns
        setTrayCallState(false, false, false, false);                // leave the call: unread dot
        applyWindowsCallOverlay(win);
        setBadgeCount(win as never, 0, false);                       // all read: cleared

        expect(calls).toEqual(['Deafened', 'Muted', 'You were mentioned', 'Deafened', '2 unread', null]);
    });

    it('a count-only push (older renderer / other IPC path) does not clear a pending mention', () => {
        const { win, calls } = fakeWin();
        setTrayCallState(false, false, false, false);
        setBadgeCount(win as never, 5, true);
        calls.length = 0;
        setBadgeCount(win as never, 6);                              // hasMention omitted
        expect(calls).toEqual([]);                                   // still the same glyph: nothing re-sent
        setBadgeCount(win as never, 0, false);
        expect(calls).toEqual([null]);
    });

    it('the mention glyph is encoded once and unchanged repeats are not re-set', () => {
        const { win, calls } = fakeWin();
        setTrayCallState(false, false, false, false);
        setBadgeCount(win as never, 0, false);
        calls.length = 0;
        for (let i = 0; i < 10; i++) setBadgeCount(win as never, 1, true);
        expect(calls).toEqual(['You were mentioned']);
    });
});
