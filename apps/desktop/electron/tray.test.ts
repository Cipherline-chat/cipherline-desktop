import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The tray icon and tooltip are synchronous Explorer round trips on Windows,
 * on main's thread (see the comment above applyTrayIcon in tray.ts). These
 * pin how many of them a burst of state pushes may cost.
 */
const osCalls: string[] = [];
vi.mock('electron', () => {
    class FakeTray {
        constructor() { osCalls.push('new'); }
        setImage(img: { v: string }) { osCalls.push(`image:${img.v}`); }
        setToolTip(t: string) { osCalls.push(`tip:${t}`); }
        setContextMenu() { osCalls.push('menu'); }
        on() { /* no-op */ }
        destroy() { osCalls.push('destroy'); }
    }
    return {
        app: { dock: undefined, setBadgeCount: () => {} },
        // Each variant's SVG differs only in its dot; tag the image with the
        // dot colour so a test can tell the variants apart.
        nativeImage: {
            createFromDataURL: (url: string) => {
                const svg = Buffer.from(url.split(',')[1], 'base64').toString();
                const v = svg.includes('#F59E0B') ? 'muted' : svg.includes('#A855F7') ? 'deafened'
                    : svg.includes('fill-opacity="0.22"') ? 'silent' : svg.includes('#FF6B5E') ? 'unread'
                    : (svg.match(/<circle/g) ? 'speaking' : 'clean');
                return { v, isEmpty: () => false };
            },
            createFromPath: () => ({ resize: () => ({ v: 'fallback' }) }),
            createFromBuffer: () => ({}),
        },
        Tray: FakeTray,
        Menu: { buildFromTemplate: () => ({}) },
        BrowserWindow: class {},
    };
});

const tray = await import('./tray');
const { setBadgeCount } = await import('./badge');
const win = { isDestroyed: () => false, setOverlayIcon: () => {} } as never;
const quitting = { value: false };
const STATE = { unreadCount: 0, dndActive: false, dndManual: false, status: 'online' as const };

const imageCalls = () => osCalls.filter(c => c.startsWith('image:'));
const tipCalls = () => osCalls.filter(c => c.startsWith('tip:'));

describe('tray — only changed state reaches the OS, speaking flips are coalesced', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        tray.destroyTray();
        tray.setTrayCallState(false, false, false, false);
        tray.setTrayBadgeIcon(0);
        tray.setupTray(true, win, quitting, STATE);
        osCalls.length = 0;
    });
    afterEach(() => { tray.destroyTray(); vi.useRealTimers(); });

    it('20 speaking flips in 2 s cost at most a few OS calls, and the icon ends right', () => {
        tray.setTrayCallState(true, false, false, false);           // join the call: immediate
        expect(imageCalls()).toEqual(['image:silent']);
        osCalls.length = 0;
        for (let i = 0; i < 20; i++) {
            tray.setTrayCallState(true, i % 2 === 0, false, false);  // speaking on / off every 100 ms
            vi.advanceTimersByTime(100);
        }
        // Before this change: 20 setImage + 20 setToolTip = 40 Explorer round trips.
        expect(imageCalls().length + tipCalls().length).toBeLessThanOrEqual(6);
        tray.setTrayCallState(true, true, false, false);             // stops talking mid-word… then speaks
        vi.advanceTimersByTime(tray.SPEAKING_FLIP_MIN_MS + 10);
        expect(imageCalls().at(-1)).toBe('image:speaking');
        expect(tipCalls().at(-1)).toBe('tip:Cipherline · Speaking');
    });

    it('mute and deafen are never delayed by the speaking throttle', () => {
        tray.setTrayCallState(true, true, false, false);
        osCalls.length = 0;
        tray.setTrayCallState(true, false, true, false);             // mute right after speaking
        expect(imageCalls()).toEqual(['image:muted']);
        tray.setTrayCallState(true, false, true, true);
        expect(imageCalls()).toEqual(['image:muted', 'image:deafened']);
    });

    it('a flip that is undone inside the window sends nothing', () => {
        tray.setTrayCallState(true, true, false, false);
        osCalls.length = 0;
        tray.setTrayCallState(true, false, false, false);
        tray.setTrayCallState(true, true, false, false);
        vi.advanceTimersByTime(5 * tray.SPEAKING_FLIP_MIN_MS);
        expect(osCalls).toEqual([]);
    });

    it('an unread-count push sends the icon once and the tooltip only when its text changes', () => {
        setBadgeCount(win, 3);
        tray.updateTrayMenu({ ...STATE, unreadCount: 3 }, win, quitting);
        setBadgeCount(win, 3);
        // Before: 3 setImage + 4 setToolTip + 1 menu rebuild for one count change.
        expect(imageCalls()).toEqual(['image:unread']);
        expect(tipCalls()).toEqual(['tip:Cipherline · 3 unread']);
        expect(osCalls.filter(c => c === 'menu')).toEqual([]);
        setBadgeCount(win, 4);
        expect(imageCalls()).toEqual(['image:unread']);
        expect(tipCalls()).toEqual(['tip:Cipherline · 3 unread', 'tip:Cipherline · 4 unread']);
    });

    it('the context menu is rebuilt only when a field it shows changes', () => {
        tray.updateTrayMenu({ ...STATE, unreadCount: 5 }, win, quitting);
        tray.updateTrayMenu({ ...STATE, unreadCount: 6 }, win, quitting);
        expect(osCalls.filter(c => c === 'menu')).toEqual([]);
        tray.updateTrayMenu({ ...STATE, status: 'dnd' }, win, quitting);
        tray.updateTrayMenu({ ...STATE, status: 'dnd', dndManual: true }, win, quitting);
        tray.updateTrayMenu({ ...STATE, status: 'dnd', dndManual: true, screenLockAvailable: true }, win, quitting);
        expect(osCalls.filter(c => c === 'menu')).toHaveLength(3);
    });

    it('a re-created tray starts from a clean slate (nothing deduped against the old one)', () => {
        tray.setTrayCallState(true, false, true, false);
        tray.destroyTray();
        tray.setupTray(true, win, quitting, STATE);
        osCalls.length = 0;
        tray.setTrayCallState(true, false, false, false);
        expect(imageCalls()).toEqual(['image:silent']);
    });
});
