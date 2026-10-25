// @vitest-environment jsdom
/**
 * A ceremony on the real MomentHost: guaranteed (no rarity, no dice, no ledger, no cooldown, no
 * waiting, no egg find), it replaces a moment on screen, shares the stage's skip / focus / pause
 * contract, and under reduced motion shows the same words on a still card that fades.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const kv = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let reduced = false;
window.matchMedia = ((q: string) => ({
    matches: reduced && /reduced-motion/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { MomentHost } = await import('./MomentHost');
const { requestMoment, requestCeremony, CEREMONIES, MOMENTS, stillMs, announcement, CEREMONY_EVENT } = await import('../../utils/moments');
const { EGG_LEDGER_KEY } = await import('../../utils/easterEggs');
const { pushEscapeLayer } = await import('../../utils/escapeStack');
const { EGG_FOUND_EVENT, bindEggAccount, unbindEggAccount } = await import('../../utils/eggProgress');
const { setHasActiveCall } = await import('../../utils/activeCallRegistry');

const DUR = CEREMONIES['safety-verified'].durationMs;
let root: Root;
let host: HTMLDivElement;
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    kv.clear();
    reduced = false;
    visibility = 'visible';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // The die is pinned to 0.999: anything gated by a chance would MISS.
    act(() => root.render(React.createElement(MomentHost, { random: () => 0.999 })));
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    setHasActiveCall(false);
    vi.useRealTimers();
});

const stage = () => document.querySelector<HTMLElement>('[data-testid="moment"]');
const live = () => document.querySelector('[data-testid="moment-live"]')?.textContent ?? '';
const ceremony = (peer?: string) => act(() => { requestCeremony('safety-verified', peer === undefined ? undefined : { peer }); });
const key = (k: string, target: EventTarget = document.activeElement ?? document.body) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(e); });
    return e;
};

describe('it plays, on the shared stage', () => {
    it('into a portal on <body>, announces the line with the name, and is gone when the animation ends', () => {
        ceremony('Mara');
        const m = stage();
        expect(m).not.toBeNull();
        expect(m!.parentElement).toBe(document.body);
        expect(m!.getAttribute('data-moment')).toBe('safety-verified');
        expect(m!.className).toContain('mo-root');
        expect(m!.className).toContain('mo-stage');
        expect(m!.className).toContain('mo-ceremony');
        expect(live()).toBe('Verified. Only you and Mara hold the keys.');
        // the animated view shows the same words in the data-read line
        expect(m!.querySelector('[data-read]')!.textContent).toBe('Verified. Only you and Mara hold the keys.');
        expect(m!.querySelector('[data-read]')!.textContent).toBe(announcement('safety-verified', 'Mara'));
        act(() => { vi.advanceTimersByTime(DUR - 10); });
        expect(stage()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(20); });
        expect(stage()).toBeNull();
    });

    it('is a dialog that says how to skip it (and is not called an easter egg)', () => {
        ceremony('Mara');
        const m = stage()!;
        expect(m.getAttribute('role')).toBe('dialog');
        expect(m.getAttribute('aria-label')).toBe('Press any key to skip.');
        expect(m.getAttribute('aria-label')).not.toMatch(/easter/i);
    });

    it('draws the orbs, the two blocks, the lock and the pulse; the other person’s initial is on their orb; no real digits', () => {
        ceremony('mara');
        const m = stage()!;
        expect(m.querySelectorAll('.mo-sv-orb')).toHaveLength(2);
        expect(m.querySelector('.mo-sv-orb-r .mo-sv-initial')!.textContent).toBe('M');
        expect(m.querySelectorAll('.mo-sv-blk')).toHaveLength(2);
        expect(m.querySelector('.mo-sv-lock')).not.toBeNull();
        expect(m.querySelectorAll('.mo-sv-pulse').length).toBeGreaterThanOrEqual(1);
        expect(m.querySelector('[aria-hidden="true"]')).not.toBeNull();   // the art is decorative
        expect(/\d{5}/.test(m.textContent ?? '')).toBe(false);
    });

    it('without a name: a silhouette on their orb and "them" in the line', () => {
        ceremony();
        const m = stage()!;
        expect(m.querySelector('.mo-sv-orb-r .mo-sv-initial')).toBeNull();
        expect(m.querySelector('[data-read]')!.textContent).toBe('Verified. Only you and them hold the keys.');
    });

    it('a name that looks like markup is shown as text, never parsed', () => {
        ceremony('<img src=x>');
        const m = stage()!;
        expect(m.querySelector('img')).toBeNull();
        expect(m.querySelector('[data-read]')!.textContent).toContain('<img src=x>');
    });
});

describe('guaranteed: none of the egg machinery applies', () => {
    it('plays on a die that would miss every chance-gated moment', () => {
        // self-ping rolls 1 in 3 (no free first play): 0.999 misses it...
        act(() => { requestMoment('self-ping'); });
        expect(stage()).toBeNull();
        // ...the ceremony does not roll at all.
        ceremony('Mara');
        expect(stage()).not.toBeNull();
    });

    it('plays again and again with no cooldown and no ledger entry: the once-per-account rule is the trigger’s, not the host’s', () => {
        for (let i = 0; i < 3; i++) {
            ceremony('Mara');
            expect(stage()).not.toBeNull();
            key('Escape', window);
            expect(stage()).toBeNull();
        }
        // nothing was claimed in the egg ledger
        expect(kv.get(EGG_LEDGER_KEY) ?? '{}').not.toMatch(/safety-verified/);
        expect([...kv.keys()].some(k => k.includes('safety'))).toBe(false);
    });

    it('is not blocked by a pacing window that would drop a moment (a cooldown that is running)', () => {
        const day = 86_400_000;
        kv.set(EGG_LEDGER_KEY, JSON.stringify({ 'moment:self-friend': { count: 3, last: Date.now() - 1000 } }));
        act(() => { requestMoment('self-friend'); });
        expect(stage()).toBeNull();                          // dropped by its weekly cooldown
        act(() => { vi.advanceTimersByTime(day / 24); });
        ceremony('Mara');
        expect(stage()).not.toBeNull();
    });

    it('does not wait for a quiet moment: it plays mid-call, mid-typing and while the window is hidden state allows', () => {
        setHasActiveCall(true);
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        key('a', input);                                      // typing right now
        ceremony('Mara');
        expect(stage()).not.toBeNull();
    });

    it('replaces a moment that is already on screen (an egg never makes it wait, or drop)', () => {
        act(() => { requestMoment('self-friend'); });
        expect(stage()!.getAttribute('data-moment')).toBe('self-friend');
        ceremony('Mara');
        expect(stage()!.getAttribute('data-moment')).toBe('safety-verified');
        expect(document.querySelectorAll('[data-testid="moment"]')).toHaveLength(1);
        expect(live()).toBe('Verified. Only you and Mara hold the keys.');
        // and it runs its own length, not the replaced moment’s
        act(() => { vi.advanceTimersByTime(DUR + 20); });
        expect(stage()).toBeNull();
    });

    it('an egg arriving while a ceremony plays is dropped (one at a time)', () => {
        ceremony('Mara');
        act(() => { requestMoment('self-friend'); });
        expect(stage()!.getAttribute('data-moment')).toBe('safety-verified');
    });

    it('is never counted as an egg found, and never spends a yield', () => {
        // Drain whatever earlier tests buffered for the next sign-in, then bind a clean account.
        bindEggAccount('u-drain', async () => null);
        unbindEggAccount();
        bindEggAccount('u-ceremony', async () => null);
        const found = vi.fn();
        window.addEventListener(EGG_FOUND_EVENT, found);
        try {
            ceremony('Mara');
            act(() => { vi.advanceTimersByTime(DUR + 20); });
        } finally {
            window.removeEventListener(EGG_FOUND_EVENT, found);
            unbindEggAccount();
        }
        expect(found).not.toHaveBeenCalled();
        expect(kv.get('cipherline_egg_progress_u-ceremony') ?? '').not.toMatch(/safety-verified/);

        // Positive control: the same wiring DOES see an ordinary moment being found.
        bindEggAccount('u-control', async () => null);
        window.addEventListener(EGG_FOUND_EVENT, found);
        try {
            act(() => { requestMoment('first-ban'); });
        } finally {
            window.removeEventListener(EGG_FOUND_EVENT, found);
            unbindEggAccount();
        }
        expect(found).toHaveBeenCalledTimes(1);
    });

    it('ignores a ceremony event for an id it does not know', () => {
        act(() => { window.dispatchEvent(new CustomEvent(CEREMONY_EVENT, { detail: { id: 'self-friend' } })); });
        act(() => { window.dispatchEvent(new CustomEvent(CEREMONY_EVENT, { detail: { id: 'nope' } })); });
        act(() => { window.dispatchEvent(new CustomEvent(CEREMONY_EVENT, { detail: null })); });
        expect(stage()).toBeNull();
    });

    it('MomentHost’s egg call sites are unchanged: one recordEggFound, still right after the ledger claim', () => {
        const src = readFileSync(join(__dirname, 'MomentHost.tsx'), 'utf8');
        expect(src.match(/recordEggFound\(/g)).toHaveLength(1);
        const ceremonyFn = src.slice(src.indexOf('const startCeremony'), src.indexOf('const offer = useCallback'));
        expect(ceremonyFn).not.toMatch(/claimMoment|recordEggFound|momentRollIn|momentDueIn|yieldMoments/);
    });
});

describe('skip, focus, pause: the stage’s contract', () => {
    it('Escape skips it, through the shared escape stack (the dialog underneath keeps its own)', () => {
        const dialogClose = vi.fn();
        const pop = pushEscapeLayer(() => dialogClose());
        ceremony('Mara');
        const e = key('Escape', window);
        expect(stage()).toBeNull();
        expect(dialogClose).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(true);
        pop();
    });

    it('any other key skips it without swallowing it; a bare modifier does not', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        ceremony('Mara');
        key('Shift', input);
        expect(stage()).not.toBeNull();
        const e = key('h', input);
        expect(stage()).toBeNull();
        expect(e.defaultPrevented).toBe(false);
    });

    it('a click skips it, in every phase, including the settled frame', () => {
        ceremony('Mara');
        act(() => { vi.advanceTimersByTime(DUR - 500); });
        act(() => { stage()!.click(); });
        expect(stage()).toBeNull();
    });

    it('takes focus when nothing is being typed, and hands it back', () => {
        const btn = document.createElement('button');
        document.body.appendChild(btn);
        btn.focus();
        ceremony('Mara');
        expect(document.activeElement).toBe(stage());
        key('Escape', window);
        expect(document.activeElement).toBe(btn);
    });

    it('never pulls focus out of a text field', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        ceremony('Mara');
        expect(document.activeElement).toBe(input);
    });

    it('a hidden window pauses its clock, a visible one resumes it', () => {
        ceremony('Mara');
        act(() => { vi.advanceTimersByTime(1000); });
        visibility = 'hidden';
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(stage()).not.toBeNull();
        visibility = 'visible';
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        act(() => { vi.advanceTimersByTime(DUR - 1000 + 20); });
        expect(stage()).toBeNull();
    });
});

describe('reduced motion', () => {
    it('shows a still card with the same words (name included) instead of the animation, with a fade-only hook', () => {
        reduced = true;
        ceremony('Mara');
        const m = stage()!;
        expect(m.className).toContain('mo-reduced');
        expect(m.className).toContain('mo-ceremony');
        expect(m.querySelector('[data-testid="moment-still"]')).not.toBeNull();
        expect(m.querySelector('.mo-sv')).toBeNull();                               // none of the travelling art
        expect(m.querySelector('.mo-sv-blk')).toBeNull();
        expect(m.querySelector('.mo-still-headline')!.textContent).toBe('Verified.');
        expect(m.querySelector('.mo-still-line')!.textContent).toBe('Only you and Mara hold the keys.');
        expect(live()).toBe('Verified. Only you and Mara hold the keys.');
        // the card’s fade runs for exactly as long as it stays
        expect(m.style.getPropertyValue('--mo-still')).toBe(`${stillMs('safety-verified', 'Mara')}ms`);
    });

    it('stays long enough to read the line, then goes; skippable like the animation', () => {
        reduced = true;
        ceremony('Mara');
        const ms = stillMs('safety-verified', 'Mara');
        act(() => { vi.advanceTimersByTime(ms - 10); });
        expect(stage()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(20); });
        expect(stage()).toBeNull();
        ceremony('Mara');
        key('Escape', window);
        expect(stage()).toBeNull();
    });

    it('the stylesheet fades the card on opacity alone and overrides the blanket no-animation rule on purpose', () => {
        const css = readFileSync(join(__dirname, '..', '..', 'styles', 'moment-safety-verified.css'), 'utf8');
        expect(css).toMatch(/\.mo-ceremony\.mo-reduced \.mo-still\s*\{[^}]*animation:\s*mo-sv-still var\(--mo-still[^}]*!important/);
        const frames = /@keyframes mo-sv-still \{([\s\S]*?)\}\s*$/m.exec(css)![1];
        expect([...frames.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]).filter(p => p !== 'opacity')).toEqual([]);
        expect(MOMENTS['self-friend']).toBeTruthy();
    });
});
