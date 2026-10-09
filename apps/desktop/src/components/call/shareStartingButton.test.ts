/**
 * The share control while a share is starting (ControlBar `screenShareStarting`).
 *
 * Rendered for real (react-dom/server, node env — there is no DOM harness in
 * this suite): idle, starting from idle, live, and restarting a live share.
 * Plus the CSS rule that keeps the indicator visible with the OS "reduce
 * motion" setting on (the spinner's arc is drawn at rest; only the rotation is
 * animation). Every assertion has a control render or rule that fails it.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({ canPublishVideo: true, promptUpgrade: () => {} }),
}));

// The suite's window has no matchMedia; clPhysics reads it at import time.
// ControlBar reads window.screen.height for its quality presets.
const w = globalThis as unknown as { window?: { matchMedia?: unknown; screen?: unknown } };
if (w.window && typeof w.window.matchMedia !== 'function') {
    w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
if (w.window && !w.window.screen) w.window.screen = { width: 2560, height: 1440 };
const { ControlBar } = await import('./ControlBar');

const noop = () => {};
function render(opts: { sharing: boolean; starting: boolean }): string {
    const participant = {
        isMicrophoneEnabled: true,
        isCameraEnabled: false,
        isScreenShareEnabled: opts.sharing,
        getTrackPublication: () => undefined,
    };
    return renderToStaticMarkup(React.createElement(ControlBar, {
        localParticipant: participant,
        isLocalDeafened: false,
        onToggleMic: noop, onToggleDeafen: noop, onToggleCamera: noop,
        onToggleScreenshare: noop, onOpenScreenSharePicker: noop,
        onAdjustScreenShareQuality: noop, onLeave: noop,
        screenShareStarting: opts.starting,
    }));
}

/** The opening tag of every <button> in the markup. */
const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];
const shareButtons = (html: string) => buttons(html).filter(b => /Share Screen|Starting screen share|Stop Screen Share|Screen share options|permission to screen share/.test(b));

describe('share button while a share is starting', () => {
    it('idle → starting: one busy, disabled button named "Starting screen share…" with a spinner', () => {
        const html = render({ sharing: false, starting: true });
        const [btn] = shareButtons(html);
        expect(btn).toBeDefined();
        expect(btn).toContain('aria-busy="true"');
        expect(btn).toContain('aria-label="Starting screen share…"');
        expect(btn).toMatch(/\sdisabled=""/);
        expect(btn).toContain('data-busy="true"');
        expect(html).toContain('cl-share-starting');
        expect(html).toContain('lucide-loader-circle');
    });
    it('control: idle and not starting is the normal clickable "Share Screen" button', () => {
        const html = render({ sharing: false, starting: false });
        const [btn] = shareButtons(html);
        expect(btn).toContain('title="Share Screen"');
        expect(btn).not.toContain('aria-busy');
        expect(btn).not.toMatch(/\sdisabled=""/);
        expect(html).not.toContain('cl-share-starting');
    });
    it('busy keeps its normal colours — it is not the greyed "no permission" state', () => {
        const [btn] = shareButtons(render({ sharing: false, starting: true }));
        expect(btn).not.toContain('rgba(255,255,255,0.28)');
        const disabled = renderToStaticMarkup(React.createElement(ControlBar, {
            localParticipant: { isScreenShareEnabled: false, getTrackPublication: () => undefined },
            isLocalDeafened: false, onToggleMic: noop, onToggleDeafen: noop, onToggleCamera: noop,
            onToggleScreenshare: noop, onOpenScreenSharePicker: noop, onAdjustScreenShareQuality: noop, onLeave: noop,
            canScreenShare: false,
        }));
        // control: the permission-disabled button IS greyed, so the check can fail
        expect(shareButtons(disabled)[0]).toContain('rgba(255,255,255,0.28)');
    });
    it('live → restarting (change source / audio): stop face and options both locked, spinner shown', () => {
        const html = render({ sharing: true, starting: true });
        const btns = shareButtons(html);
        const stop = btns.find(b => b.includes('cl-share-stop'))!;
        const chev = btns.find(b => b.includes('cl-share-chev'))!;
        expect(stop).toContain('aria-busy="true"');
        expect(stop).toContain('aria-label="Starting screen share…"');
        expect(stop).toMatch(/\sdisabled=""/);
        expect(chev).toMatch(/\sdisabled=""/);
        expect(html).toContain('cl-share-starting');
    });
    it('control: a live share that is not restarting can be stopped and opened', () => {
        const html = render({ sharing: true, starting: false });
        const btns = shareButtons(html);
        const stop = btns.find(b => b.includes('cl-share-stop'))!;
        const chev = btns.find(b => b.includes('cl-share-chev'))!;
        expect(stop).toContain('title="Stop Screen Share"');
        expect(stop).not.toMatch(/\sdisabled=""/);
        expect(chev).not.toMatch(/\sdisabled=""/);
        expect(html).not.toContain('cl-share-starting');
    });
});

describe('spinner without animations (prefers-reduced-motion)', () => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    /** Declarations of every top-level rule with exactly this selector. */
    const restingRules = (src: string, sel: string): string[] => {
        const noMedia = src.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
        const out: string[] = [];
        const re = new RegExp('(^|[}\\s])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(noMedia))) out.push(m[2]);
        return out;
    };
    const hiddenAtRest = (decls: string) => /opacity:\s*0(?![.\d])|visibility:\s*hidden|display:\s*none/.test(decls);

    it('the spinner is drawn at rest; only rotation is animated; reduced motion stops the rotation', () => {
        const wrap = restingRules(css, '.cl-ctrlbtn .cl-share-starting');
        const svg = restingRules(css, '.cl-ctrlbtn .cl-share-starting svg');
        expect(wrap.length).toBeGreaterThan(0);
        expect(svg.length).toBeGreaterThan(0);
        for (const r of [...wrap, ...svg]) expect(hiddenAtRest(r)).toBe(false);
        const kf = /@keyframes cl-share-starting-spin\s*\{([^}]*\{[^}]*\})*[^}]*\}/.exec(css)?.[0] ?? '';
        expect(kf).toMatch(/rotate\(360deg\)/);
        expect(kf).not.toMatch(/opacity/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cl-ctrlbtn \.cl-share-starting svg \{ animation: none; \}/);
    });
    it('control: an indicator that only appears through its animation is caught', () => {
        const bad = '.cl-ctrlbtn .cl-share-starting{opacity:0;animation:fade-in .2s forwards}';
        expect(restingRules(bad, '.cl-ctrlbtn .cl-share-starting').some(hiddenAtRest)).toBe(true);
    });
});
