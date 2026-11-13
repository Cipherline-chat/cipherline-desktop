import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NOTICE_CLOSE_GRACE_MS, createNoticeGuard } from './keyring-notice-guard';

describe('notice guard: closing the wallet notice must not quit the app', () => {
    it('holds the app while a notice is open', () => {
        let t = 1_000_000;
        const g = createNoticeGuard(() => t);
        expect(g.holdsApp()).toBe(false);
        g.opened();
        t += 60_000; // a user who takes a minute over the wallet dialog
        expect(g.holdsApp()).toBe(true);
    });

    it('keeps holding for the grace period after the close (window-all-closed follows the destroy), then lets go', () => {
        let t = 1_000_000;
        const g = createNoticeGuard(() => t);
        g.opened();
        g.closed();
        expect(g.holdsApp()).toBe(true);
        t += NOTICE_CLOSE_GRACE_MS - 1;
        expect(g.holdsApp()).toBe(true);
        t += 1;
        expect(g.holdsApp()).toBe(false);
    });

    it('NEGATIVE CONTROL: a launch with no notice never holds the app (a real close-all quits as before)', () => {
        const g = createNoticeGuard(() => 5);
        expect(g.holdsApp()).toBe(false);
    });

    it('a stray closed() without opened() cannot go negative or wedge the guard open', () => {
        let t = 10_000_000;
        const g = createNoticeGuard(() => t);
        g.closed();
        t += NOTICE_CLOSE_GRACE_MS;
        expect(g.holdsApp()).toBe(false);
    });
});

describe('wiring (source scan)', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');

    it('main.ts consults the guard first thing in window-all-closed', () => {
        const main = read('main.ts');
        const at = main.indexOf("app.on('window-all-closed'");
        expect(at).toBeGreaterThan(0);
        const body = main.slice(at, at + 1500);
        expect(body.indexOf('keyringNoticeGuard.holdsApp()')).toBeGreaterThan(0);
        expect(body.indexOf('keyringNoticeGuard.holdsApp()')).toBeLessThan(body.indexOf('app.quit()'));
    });

    it('the notice marks itself closed BEFORE destroying the window', () => {
        const n = read('keyring-notice.ts');
        expect(n.indexOf('keyringNoticeGuard.closed()')).toBeGreaterThan(0);
        expect(n.indexOf('keyringNoticeGuard.closed()')).toBeLessThan(n.indexOf('win.destroy()'));
        expect(n).toContain('keyringNoticeGuard.opened()');
    });

    it('the notice window is hardened: sandbox, isolation, no node, no script, no preload, in-memory session', () => {
        const n = read('keyring-notice.ts');
        for (const frag of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'javascript: false', "partition: 'keyring-notice'", 'setContentProtection(true)', 'focusable: false']) {
            expect(n, frag).toContain(frag);
        }
        expect(n).not.toMatch(/preload\s*:/);
    });

    it('nothing under electron/ imports from src/ (the electron-rootdir trap)', () => {
        for (const f of ['keyring-prompt.ts', 'keyring-ipc.ts', 'keyring-marker.ts', 'keyring-notice.ts', 'keyring-notice-html.ts', 'keyring-notice-guard.ts']) {
            expect(read(f), f).not.toMatch(/from\s+['"]\.\.\/src/);
        }
    });
});
