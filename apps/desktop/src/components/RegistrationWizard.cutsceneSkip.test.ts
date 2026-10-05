// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Covers KeysCutscene's skip teardown (RegistrationWizard.tsx): cancelling
 * every pending timer, landing on the same next state a natural finish
 * reaches (onFinish fired), and firing onFinish EXACTLY once no matter how
 * many times skip is triggered or how long fake time runs afterward. A
 * no-JSX render harness per this file's `.test.ts` extension (vitest's
 * include only picks up `src/**\/*.test.ts` — a `.tsx` test file is silently
 * never collected — see useKeepMountedForExit.test.ts / ReactionPill.anim.
 * test.ts for the same pattern this file follows).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// matchMedia must exist BEFORE RegistrationWizard's import graph is
// evaluated: framer-motion's useReducedMotion and ClButton's own wake-pop
// effect both call window.matchMedia at runtime and throw under jsdom
// otherwise (see ReactionPill.anim.test.ts). `reducedMatches` is mutated per
// test via the closure so both the animated and reduced-motion branches are
// exercised from the one dynamic import.
let reducedMatches = false;
window.matchMedia = ((q: string) => ({
    matches: reducedMatches, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let KeysCutscene: any;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(async () => {
    vi.useFakeTimers();
    reducedMatches = false;
    if (!KeysCutscene) {
        ({ KeysCutscene } = await import('./RegistrationWizard'));
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    host.remove();
    vi.useRealTimers();
});

// Mirrors CUT_BEATS' `dur` values and the intro settle delay in
// RegistrationWizard.tsx. If those change, this constant must move with
// them — that coupling is intentional: it's what lets "advance well past
// every remaining beat" mean something concrete rather than an arbitrary
// big number.
const INTRO_MS = 1100;
const CUT_BEAT_DURS = [3000, 3300, 3600, 4100, 4100, 3800];
const TOTAL_MS = INTRO_MS + CUT_BEAT_DURS.reduce((a, b) => a + b, 0);

function mount(onFinish: () => void) {
    act(() => { root!.render(React.createElement(KeysCutscene, { onFinish })); });
}

function pressEscape() {
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
}

describe('KeysCutscene skip teardown', () => {
    it('skipping mid-beat explicitly clears the pending timer (not just guards onFinish), and no later timer fires it again', () => {
        const onFinish = vi.fn();
        mount(onFinish);

        // Let the intro settle and get partway into beat 0 — this arms the
        // beat-0 -> beat-1 auto-advance timer (dur 3000ms) that skip must cancel.
        act(() => { vi.advanceTimersByTime(1500); });
        expect(onFinish).not.toHaveBeenCalled();

        // Assert the teardown ACTUALLY calls clearTimeout — distinct from
        // (and stronger than) merely checking onFinish fires once, since a
        // re-entrancy guard alone could mask a leaked-but-inert timer. This
        // is the literal "cancel every pending timer" behavior.
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        pressEscape();
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();

        expect(onFinish).toHaveBeenCalledTimes(1);

        // Advance well past every remaining beat's duration. If the pending
        // beat-advance timer (or any timer scheduled off a subsequent beat)
        // wasn't actually cancelled, THIS is where a leaked timer would fire
        // and double-call onFinish.
        act(() => { vi.advanceTimersByTime(TOTAL_MS + 10_000); });
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('skipping during the intro (before any beat timer is armed) still fires onFinish exactly once', () => {
        const onFinish = vi.fn();
        mount(onFinish);

        // t=0 — still mid-intro, only the intro timer is armed.
        pressEscape();
        expect(onFinish).toHaveBeenCalledTimes(1);

        act(() => { vi.advanceTimersByTime(TOTAL_MS + 10_000); });
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('pressing Escape twice in a row still only fires onFinish once', () => {
        const onFinish = vi.fn();
        mount(onFinish);
        act(() => { vi.advanceTimersByTime(1500); });
        pressEscape();
        pressEscape();
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('natural completion (no skip) still fires onFinish exactly once at the end', () => {
        const onFinish = vi.fn();
        mount(onFinish);
        // Each beat's timer is only ARMED once the effect from the PREVIOUS
        // beat's state update has committed, so this advances one timer at a
        // time (one act() per step) rather than a single big jump — a single
        // vi.advanceTimersByTime(TOTAL_MS) can outrun React's effect commit
        // and miss timers that get armed partway through the advance.
        act(() => { vi.advanceTimersByTime(INTRO_MS); });
        for (const dur of CUT_BEAT_DURS) {
            expect(onFinish).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(dur); });
        }
        expect(onFinish).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('the reduced-motion fallback also completes exactly once on Escape (no separate Skip control needed there)', () => {
        reducedMatches = true;
        const onFinish = vi.fn();
        mount(onFinish);
        pressEscape();
        expect(onFinish).toHaveBeenCalledTimes(1);
        pressEscape();
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('clicking the rendered Skip button fires onFinish exactly once, and the control is absent until the intro settles', () => {
        const onFinish = vi.fn();
        mount(onFinish);

        // Immediately on mount (still mid-intro): no Skip button yet — it's
        // deliberately not present on first paint (see the header comment).
        const findSkipButton = () => Array.from(host.querySelectorAll('button'))
            .find(b => (b.textContent || '').includes('Skip'));
        expect(findSkipButton()).toBeUndefined();

        act(() => { vi.advanceTimersByTime(1500); }); // past the 1100ms intro settle
        const skipBtn = findSkipButton();
        expect(skipBtn).toBeTruthy();

        act(() => { skipBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(onFinish).toHaveBeenCalledTimes(1);

        act(() => { vi.advanceTimersByTime(TOTAL_MS + 10_000); });
        expect(onFinish).toHaveBeenCalledTimes(1);
    });
});
