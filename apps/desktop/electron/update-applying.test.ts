import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ApplyingUpdatePopup, applyingUpdateHtml, applyingVersionLabel, APPLYING_UPDATE_MS, APPLYING_BAR_MS,
    APPLYING_STATUSES, APPLYING_STATUS_STEP_MS, APPLYING_CARD_W, APPLYING_CARD_H, APPLYING_SHADOW_MARGIN, APPLYING_CARD_BG,
    applyingUpdateWindowPlan,
    type ApplyingUpdateDeps,
} from './update-applying';
import {
    SPLASH_TOKENS_CSS, SPLASH_KEYFRAMES_CSS, SPLASH_CARD_CSS, SPLASH_MARK_CSS, SPLASH_FOOTER_CSS,
    SPLASH_HEADLINE_CSS, SPLASH_TITLEBAR_MARK_SVG, SPLASH_WORKING_MARK_HTML,
} from './splash-style';
import { installerSplashHtml } from './installer-splash';
import { createHash } from 'node:crypto';

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

    it('is built from the installer splash styles, verbatim', () => {
        const html = applyingUpdateHtml('1.0.25');
        for (const [name, chunk] of Object.entries({
            SPLASH_TOKENS_CSS, SPLASH_KEYFRAMES_CSS, SPLASH_CARD_CSS, SPLASH_MARK_CSS, SPLASH_FOOTER_CSS,
            SPLASH_HEADLINE_CSS, SPLASH_TITLEBAR_MARK_SVG, SPLASH_WORKING_MARK_HTML,
        })) {
            expect(chunk.length, name).toBeGreaterThan(20);
            expect(html.includes(chunk), name).toBe(true);
            expect(installerSplashHtml('1.0.25', true).includes(chunk), `installer ${name}`).toBe(true);
        }
        expect(html).toContain('<div class="big">Applying update</div>');
        expect(html).toContain('<div class="sub">Updating to 1.0.25</div>');
        expect(html).toContain('<span class="ver">updating 1.0.25</span>');
        expect(applyingUpdateHtml('')).toContain('<span class="ver">updating</span>');
    });

    it('never fetches fonts (unlike the installer) and sets no color-scheme (a transparent window must stay transparent)', () => {
        const html = applyingUpdateHtml('1.0.25', { floating: true });
        expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@font-face|url\(/);
        expect(html).toContain("'Fredoka'");
        expect(html).not.toMatch(/color-scheme\s*:/);
        expect(installerSplashHtml('1.0.25', true)).toContain('fonts.googleapis.com'); // positive control for the matcher
    });

    it('status lines rotate in CSS only: one step each, the last one stays', () => {
        const html = applyingUpdateHtml('1.0.25');
        for (const s of APPLYING_STATUSES) expect(html).toContain(`<span class="st">${s}</span>`);
        expect(APPLYING_STATUS_STEP_MS * APPLYING_STATUSES.length).toBeLessThanOrEqual(APPLYING_UPDATE_MS);
        const last = APPLYING_STATUSES.length;
        expect(html).toMatch(new RegExp(`\\.st:nth-child\\(1\\) \\{ opacity: 1; animation: st-out 160ms ease-in ${APPLYING_STATUS_STEP_MS}ms forwards; \\}`));
        expect(html).toMatch(new RegExp(`\\.st:nth-child\\(${last}\\) \\{ opacity: 0; animation: st-in 160ms ease-out ${(last - 1) * APPLYING_STATUS_STEP_MS}ms forwards; \\}`));
        expect(html).toContain(`animation: fill ${APPLYING_BAR_MS}ms`);
        expect(html).toContain(`animation: pct ${APPLYING_BAR_MS}ms`);
    });

    it('reduced motion stops every animation and rests at a full bar', () => {
        const html = applyingUpdateHtml('1.0.25');
        const rm = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(rm).toContain('.pulse-ring, .statusdot, .headline, .st, .pct::after, .bar-fill, .mark-wrap rect { animation: none !important; }');
        expect(rm).toContain('.bar-fill { width: 100%; }');
        expect(rm).toContain('.pct::after { --p: 100; }');
    });

    it('floating = the installer card as is; fill = the card is the window, square', () => {
        expect(applyingUpdateHtml('1.0.25', { floating: true })).toContain('<html lang="en" class="float">');
        expect(applyingUpdateHtml('1.0.25', { floating: false })).toContain('<html lang="en" class="fill">');
        expect(applyingUpdateHtml('1.0.25')).toContain('<html lang="en" class="fill">');
        expect(applyingUpdateHtml('1.0.25')).toContain('html.fill .card { width: 100%; height: 100%; border-radius: 0; box-shadow: none; }');
    });
});

describe('applyingUpdateWindowPlan', () => {
    it.each(['win32', 'darwin'])('%s: transparent window, card floats with room for its shadow', (platform) => {
        const p = applyingUpdateWindowPlan(platform);
        expect(p).toEqual({
            transparent: true,
            width: APPLYING_CARD_W + 2 * APPLYING_SHADOW_MARGIN,
            height: APPLYING_CARD_H + 2 * APPLYING_SHADOW_MARGIN,
            backgroundColor: '#00000000',
            page: { floating: true },
        });
        // The installer shadow (0 24px 60px) reaches 84px below the card.
        expect(SPLASH_CARD_CSS).toContain('box-shadow: 0 24px 60px');
        expect(APPLYING_SHADOW_MARGIN).toBeGreaterThanOrEqual(24 + 60);
    });

    it.each(['linux', 'freebsd', 'openbsd', ''])('%s: opaque window, the card fills it', (platform) => {
        expect(applyingUpdateWindowPlan(platform)).toEqual({
            transparent: false, width: APPLYING_CARD_W, height: APPLYING_CARD_H,
            backgroundColor: APPLYING_CARD_BG, page: { floating: false },
        });
        // The opaque window paints the card's own colour before the page does.
        expect(SPLASH_TOKENS_CSS).toContain(`--cl-deep:    ${APPLYING_CARD_BG}`);
        expect(SPLASH_CARD_CSS).toContain('width: 440px');
        expect(APPLYING_CARD_W).toBe(440);
    });
});

describe('splash-style.ts extraction left the installer page byte-identical', () => {
    // sha256 of installerSplashHtml() output, recorded on origin/staging e2f82b16 BEFORE the styles
    // moved into splash-style.ts. If you change the installer on purpose, re-record these.
    it.each([
        ['0.1.1', false, '6b4ba9628b3f5abd9ab18b7638643d33c284af697c0a439a566050173a975f4a'],
        ['0.1.1', true, 'e48f6e7a2864e8259a4060d191919f3d5ef4d10f25482ebbb130126e1fe39e7d'],
        ['0.1.1-staging.232', true, '224c11af51f556d22f0633a85731bc939c3c9196a229cfcc8cb4db23a4383242'],
        ['1.0<x>', false, '0e5d110b3da91b9668b7a3658bcc330875617a9df074d1a710dc836ad0f4901d'],
    ])('%s isUpdate=%s', (v, isUpdate, sha) => {
        expect(createHash('sha256').update(installerSplashHtml(v, isUpdate)).digest('hex')).toBe(sha);
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
        // Every geometry / transparency choice comes from the tested per-OS plan.
        for (const needle of ['const plan = applyingUpdateWindowPlan(process.platform);', 'width: plan.width', 'height: plan.height',
            'transparent: plan.transparent', 'backgroundColor: plan.backgroundColor', 'applyingUpdateHtml(version, plan.page)']) {
            expect(WIN).toContain(needle);
        }
        expect(WIN).not.toMatch(/backgroundColor: '#|transparent: (true|false)|width: \d|height: \d/);
        for (const f of ['applying-update-window.ts', 'update-applying.ts', 'splash-style.ts', 'installer-splash.ts']) {
            expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/from '\.\.\/src/);
        }
    });
});
