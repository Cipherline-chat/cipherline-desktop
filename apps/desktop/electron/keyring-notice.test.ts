import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { wins, workArea } = vi.hoisted(() => ({
    wins: [] as unknown[],
    workArea: { x: 0, y: 0, width: 1280, height: 752 },
}));

vi.mock('electron', async () => {
    const { EventEmitter } = await import('events');
    class FakeWebContents extends EventEmitter {
        setWindowOpenHandler = vi.fn();
        setZoomFactor = vi.fn();
        setVisualZoomLevelLimits = vi.fn(async () => undefined);
        setZoomLevel = vi.fn();
    }
    class FakeWindow extends EventEmitter {
        opts: Record<string, any>;
        webContents = new FakeWebContents();
        shown = false;
        destroyed = false;
        log: string[] = [];
        constructor(opts: Record<string, any>) { super(); this.opts = opts; wins.push(this); }
        removeMenu = vi.fn();
        setContentProtection = vi.fn();
        setIgnoreMouseEvents = vi.fn();
        loadURL = vi.fn(async (url: string) => { this.log.push('load'); (this as any).url = url; });
        showInactive() { this.shown = true; this.log.push('show'); setTimeout(() => this.emit('show'), 5); }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.log.push('destroy'); }
    }
    return {
        BrowserWindow: FakeWindow,
        screen: { getPrimaryDisplay: () => ({ workArea }) },
    };
});

import { showKeyringNotice } from './keyring-notice';
import { keyringNoticeGuard } from './keyring-notice-guard';
import { keyringNoticeHtml } from './keyring-notice-html';
import { KEYRING_PROMPT_AFTER_MS } from './keyring-prompt';

type W = EventEmitter & { opts: Record<string, any>; webContents: EventEmitter; shown: boolean; destroyed: boolean; url: string; setContentProtection: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn> };
const last = () => wins[wins.length - 1] as W;

beforeEach(() => { wins.length = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('showKeyringNotice: resolves only once the notice is ON SCREEN', () => {
    it('waits for first paint AND load AND the show, then a compositor beat; not a moment sooner', async () => {
        let resolved = false;
        const p = showKeyringNotice('kwallet6').then(d => { resolved = true; return d; });
        await vi.advanceTimersByTimeAsync(0);
        const w = last();
        expect(w.shown).toBe(false);

        w.emit('ready-to-show');
        await vi.advanceTimersByTimeAsync(10);
        expect(w.shown).toBe(false); // load not finished yet: still hidden

        w.webContents.emit('did-finish-load');
        await vi.advanceTimersByTimeAsync(0);
        expect(w.shown).toBe(true);
        expect(resolved).toBe(false); // shown, but the compositor has not had its beat

        await vi.advanceTimersByTimeAsync(100);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(resolved).toBe(true);
        (await p)();
        expect(w.destroyed).toBe(true);
    });

    it('a window that never paints is not waited on for ever (bounded)', async () => {
        let resolved = false;
        void showKeyringNotice('kwallet6').then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(1100);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(800);
        expect(resolved).toBe(true);
    });

    it('the disposer closes it, is idempotent, and balances the quit guard', async () => {
        const p = showKeyringNotice('kwallet6');
        await vi.advanceTimersByTimeAsync(0);
        last().emit('ready-to-show'); last().webContents.emit('did-finish-load');
        await vi.advanceTimersByTimeAsync(300);
        const dispose = await p;
        expect(keyringNoticeGuard.holdsApp()).toBe(true);
        dispose(); dispose();
        expect(last().destroyed).toBe(true);
    });
});

describe('placement: tall transparent click-through window, card pinned to the top', () => {
    it('is as tall as the work area, transparent, top-aligned (Wayland centres it and ignores x/y)', async () => {
        void showKeyringNotice('kwallet6');
        await vi.advanceTimersByTimeAsync(0);
        const o = last().opts;
        expect(o.height).toBe(752);
        expect(o.transparent).toBe(true);
        expect(o.y).toBe(0);
        expect(o.width).toBe(480);
        expect(o.focusable).toBe(false);
        expect(last().setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    });

    it('a smaller screen gives a smaller window; a tiny one never goes below the card', async () => {
        workArea.height = 600;
        void showKeyringNotice('kwallet6'); await vi.advanceTimersByTimeAsync(0);
        expect(last().opts.height).toBe(600);
        workArea.height = 100;
        void showKeyringNotice('kwallet6'); await vi.advanceTimersByTimeAsync(0);
        expect(last().opts.height).toBe(160);
        workArea.height = 752;
    });

    it('without a compositor (transparent:false) it is just the card, as before', async () => {
        void showKeyringNotice('kwallet6', { transparent: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(last().opts.height).toBe(160);
        expect(last().opts.transparent).toBe(false);
    });

    it('page: card pinned to the top of a tall transparent window', () => {
        expect(keyringNoticeHtml('KDE Wallet', { delayed: false, pinTop: true })).toContain('align-items: flex-start');
        expect(keyringNoticeHtml('KDE Wallet', { delayed: false })).toContain('align-items: center');
    });
});

describe('hardening is unchanged', () => {
    it('sandboxed, context-isolated, no node, NO preload, no script, content protection on, in-memory session, nothing navigates', async () => {
        void showKeyringNotice('kwallet6');
        await vi.advanceTimersByTimeAsync(0);
        const w = last();
        const wp = w.opts.webPreferences;
        expect(wp).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, partition: 'keyring-notice' });
        expect(wp.preload).toBeUndefined();
        expect(w.setContentProtection).toHaveBeenCalledWith(true);
        const nav = { preventDefault: vi.fn() };
        w.webContents.emit('will-navigate', nav);
        expect(nav.preventDefault).toHaveBeenCalled();
        expect((w.webContents as any).setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
        expect((w.webContents as any).setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1); // zoom lock
    });
});

describe('the page: no delay when a prompt is known to be coming', () => {
    it('immediate: visible at once, no animation; delayed (legacy): reveals after KEYRING_PROMPT_AFTER_MS', async () => {
        void showKeyringNotice('kwallet6', { delayed: false });
        void showKeyringNotice('kwallet6', { delayed: true });
        await vi.advanceTimersByTimeAsync(0);
        const [a, b] = wins as W[];
        const dec = (u: string) => decodeURIComponent(u.split(',').slice(1).join(','));
        expect(dec(a.url)).toContain('opacity: 1;');
        expect(dec(a.url)).not.toContain('animation: reveal');
        expect(dec(b.url)).toContain(`reveal 220ms ease-out ${KEYRING_PROMPT_AFTER_MS}ms`);
    });

    it('create mode names creating a wallet; unlock mode asks for the password', () => {
        expect(keyringNoticeHtml('KDE Wallet', { mode: 'create', delayed: false })).toContain('Create a KDE Wallet so Cipherline can protect your keys');
        expect(keyringNoticeHtml('KDE Wallet', { mode: 'unlock', delayed: false })).toContain('Your system is asking for your KDE Wallet password');
        expect(keyringNoticeHtml('GNOME Keyring', { mode: 'create' })).not.toContain('KDE');
    });
});
