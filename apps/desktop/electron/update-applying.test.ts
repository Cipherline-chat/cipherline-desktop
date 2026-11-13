import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ApplyingUpdatePopup, applyingUpdateHtml, applyingVersionLabel, APPLYING_UPDATE_MS, APPLYING_BAR_MS,
    type ApplyingUpdateDeps,
} from './update-applying';

function rig(over: Partial<ApplyingUpdateDeps> = {}) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const opened: string[] = [];
    let closed = 0;
    const popup = new ApplyingUpdatePopup({
        smokeTest: false,
        open: (v) => { opened.push(v); return () => { closed++; }; },
        setTimer: (fn, ms) => { timers.push({ fn, ms }); },
        ...over,
    });
    return { popup, timers, opened, closed: () => closed };
}

describe('ApplyingUpdatePopup decision logic', () => {
    it('shows the popup for a downloaded version and holds the install by APPLYING_UPDATE_MS (positive control)', () => {
        const r = rig();
        let installs = 0;
        expect(r.popup.show('1.0.25')).toBe(true);
        r.popup.install(() => { installs++; });
        expect(r.opened).toEqual(['1.0.25']);
        expect(r.timers).toHaveLength(1);
        expect(r.timers[0].ms).toBe(APPLYING_UPDATE_MS);
        expect(installs).toBe(0);
        r.timers[0].fn();
        expect(installs).toBe(1);
    });

    it('the hold never exceeds 2 s and the bar finishes inside it', () => {
        expect(APPLYING_UPDATE_MS).toBeLessThanOrEqual(2000);
        expect(APPLYING_BAR_MS).toBeLessThan(APPLYING_UPDATE_MS);
    });

    it('never shows under the smoke test and installs on the next tick', () => {
        const r = rig({ smokeTest: true });
        expect(r.popup.show('1.0.25')).toBe(false);
        r.popup.install(() => {});
        expect(r.opened).toEqual([]);
        expect(r.timers[0].ms).toBe(0);
    });

    it('shows nothing when there is no downloaded version', () => {
        for (const v of [null, undefined, '']) {
            const r = rig();
            expect(r.popup.show(v)).toBe(false);
            expect(r.opened).toEqual([]);
        }
    });

    it('falls back to an immediate install when the window cannot be created (throws)', () => {
        const logs: string[] = [];
        const r = rig({ open: () => { throw new Error('no display'); }, log: (l) => logs.push(l) });
        expect(r.popup.show('1.0.25')).toBe(false);
        expect(r.popup.visible).toBe(false);
        r.popup.install(() => {});
        expect(r.timers[0].ms).toBe(0);
        expect(logs.join()).toContain('no display');
    });

    it('falls back to an immediate install when open returns null', () => {
        const r = rig({ open: () => null });
        expect(r.popup.show('1.0.25')).toBe(false);
        r.popup.install(() => {});
        expect(r.timers[0].ms).toBe(0);
    });

    it('runs the install exactly once even if the timer fires twice', () => {
        const r = rig();
        let n = 0;
        r.popup.install(() => { n++; });
        r.timers[0].fn(); r.timers[0].fn();
        expect(n).toBe(1);
    });

    it('show twice opens one window; dismiss closes it once and is idempotent', () => {
        const r = rig();
        r.popup.show('1.0.25'); r.popup.show('1.0.25');
        expect(r.opened).toHaveLength(1);
        r.popup.dismiss(); r.popup.dismiss();
        expect(r.closed()).toBe(1);
        expect(r.popup.visible).toBe(false);
    });

    it('a closer that throws does not escape dismiss()', () => {
        const r = rig({ open: () => () => { throw new Error('gone'); } });
        r.popup.show('1.0.25');
        expect(() => r.popup.dismiss()).not.toThrow();
    });
});

describe('applying-update page', () => {
    it('says "Applying update" and the version, allow-listing the version characters', () => {
        const html = applyingUpdateHtml('1.0.25');
        expect(html).toContain('Applying update');
        expect(html).toContain('Updating to 1.0.25');
        expect(applyingVersionLabel('1.0.25-staging.3')).toBe('Updating to 1.0.25-staging.3');
        expect(applyingUpdateHtml('1.0<script>alert(1)</script>')).not.toContain('<script');
        expect(applyingVersionLabel('')).toBe('Updating Cipherline');
    });

    it('is self-contained: no script, no remote URL, locked CSP, reduced-motion rule', () => {
        const html = applyingUpdateHtml('1.0.25');
        expect(html).not.toMatch(/<script|https?:\/\/|@import|<link|<iframe/i);
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('prefers-reduced-motion: reduce');
    });
});

describe('wiring in main.ts / window file', () => {
    const MAIN = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const WIN = readFileSync(join(__dirname, 'applying-update-window.ts'), 'utf8');

    it('the popup is built with the smoke-test flag and every hand-over goes through it', () => {
        expect(MAIN).toMatch(/new ApplyingUpdatePopup\(\{\s*smokeTest: IS_SMOKE_TEST,/);
        expect(MAIN).toContain('defer: (fn) => applyingUpdate.install(fn)');
        expect(MAIN).toContain('applyingUpdate.install(() => autoUpdater.quitAndInstall(false, true))');
        expect(MAIN).toContain('applyingUpdate.install(() => autoUpdater.quitAndInstall(true, true))');
        expect(MAIN).not.toMatch(/setImmediate\(\(\) => autoUpdater\.quitAndInstall/);
        expect(MAIN).toMatch(/dismissInstallingUi = \(\) => \{\s*applyingUpdate\.dismiss\(\);/);
    });

    it('the window is locked down and never imports renderer source', () => {
        for (const needle of ['nodeIntegration: false', 'contextIsolation: true', 'sandbox: true', 'javascript: false', 'setContentProtection(true)', "setWindowOpenHandler(() => ({ action: 'deny' }))"]) {
            expect(WIN).toContain(needle);
        }
        expect(WIN).not.toMatch(/preload:|openExternal\(/);
        for (const f of ['applying-update-window.ts', 'update-applying.ts']) {
            expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/from '\.\.\/src/);
        }
    });
});
