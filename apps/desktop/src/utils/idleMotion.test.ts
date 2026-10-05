import { describe, it, expect } from 'vitest';
import {
    isWindowActive,
    applyMotionState,
    installIdleMotionGate,
    setOccluded,
    MOTION_ACTIVE,
    MOTION_IDLE,
    OCCLUDED_ON,
} from './idleMotion';

/**
 * The suite runs under vitest's `node` environment (see vitest.config.ts), so
 * there is no real DOM. idleMotion takes its document/window as parameters
 * precisely so the gate can be driven by these stubs.
 */
function makeDoc(opts: { hidden?: boolean; focused?: boolean; throwOnFocus?: boolean } = {}) {
    const attrs: Record<string, string> = {};
    let setCount = 0;
    const listeners: Record<string, Array<() => void>> = {};
    const doc = {
        hidden: opts.hidden ?? false,
        hasFocus: () => {
            if (opts.throwOnFocus) throw new Error('no browsing context');
            return opts.focused ?? true;
        },
        documentElement: {
            getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
            setAttribute: (k: string, v: string) => { attrs[k] = v; setCount++; },
            hasAttribute: (k: string) => k in attrs,
            removeAttribute: (k: string) => { delete attrs[k]; setCount++; },
        },
        addEventListener: (ev: string, fn: () => void) => {
            (listeners[ev] ||= []).push(fn);
        },
        removeEventListener: (ev: string, fn: () => void) => {
            listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
        },
        __attrs: attrs,
        __listeners: listeners,
        __setCount: () => setCount,
    };
    return doc as unknown as Document & {
        __attrs: Record<string, string>;
        __listeners: Record<string, Array<() => void>>;
        __setCount: () => number;
    };
}

function makeWin(doc: Document) {
    const listeners: Record<string, Array<() => void>> = {};
    return {
        document: doc,
        addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ||= []).push(fn); },
        removeEventListener: (ev: string, fn: () => void) => {
            listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
        },
        __listeners: listeners,
    } as unknown as Window & { __listeners: Record<string, Array<() => void>> };
}

describe('isWindowActive', () => {
    it('is active only when visible AND focused', () => {
        expect(isWindowActive(makeDoc({ hidden: false, focused: true }))).toBe(true);
        expect(isWindowActive(makeDoc({ hidden: true, focused: true }))).toBe(false);
        expect(isWindowActive(makeDoc({ hidden: false, focused: false }))).toBe(false);
        expect(isWindowActive(makeDoc({ hidden: true, focused: false }))).toBe(false);
    });

    it('fails OPEN (active) if hasFocus() throws, so the UI can never freeze', () => {
        expect(isWindowActive(makeDoc({ throwOnFocus: true }))).toBe(true);
    });
});

describe('applyMotionState', () => {
    it('writes the active/idle attribute onto <html>', () => {
        const doc = makeDoc();
        applyMotionState(true, doc);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
        applyMotionState(false, doc);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
    });

    it('does not rewrite the attribute when the state is unchanged', () => {
        // Each write invalidates style for the whole subtree, so a repeated
        // focus event must not cost a restyle.
        const doc = makeDoc();
        applyMotionState(false, doc);
        const afterFirst = doc.__setCount();
        applyMotionState(false, doc);
        applyMotionState(false, doc);
        expect(doc.__setCount()).toBe(afterFirst);
    });
});

describe('installIdleMotionGate', () => {
    it('applies the initial state immediately, before any event fires', () => {
        const doc = makeDoc({ focused: false });
        const win = makeWin(doc);
        installIdleMotionGate(win);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
    });

    it('subscribes to focus, blur and visibilitychange', () => {
        const doc = makeDoc();
        const win = makeWin(doc);
        installIdleMotionGate(win);
        expect(win.__listeners.focus?.length).toBe(1);
        expect(win.__listeners.blur?.length).toBe(1);
        expect(doc.__listeners.visibilitychange?.length).toBe(1);
    });

    it('flips to idle on blur and back to active on focus', () => {
        let focused = true;
        const attrs: Record<string, string> = {};
        const doc = {
            hidden: false,
            hasFocus: () => focused,
            documentElement: {
                getAttribute: (k: string) => attrs[k] ?? null,
                setAttribute: (k: string, v: string) => { attrs[k] = v; },
            },
            addEventListener: () => {},
            removeEventListener: () => {},
        } as unknown as Document;
        const win = makeWin(doc);
        installIdleMotionGate(win);
        expect(attrs['data-cl-motion']).toBe(MOTION_ACTIVE);

        focused = false;
        win.__listeners.blur[0]();
        expect(attrs['data-cl-motion']).toBe(MOTION_IDLE);

        focused = true;
        win.__listeners.focus[0]();
        expect(attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
    });

    it('treats a hidden-but-focused window as idle (minimise / workspace switch)', () => {
        const doc = makeDoc({ hidden: true, focused: true });
        const win = makeWin(doc);
        installIdleMotionGate(win);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_IDLE);
    });

    it('teardown removes every listener it added', () => {
        const doc = makeDoc();
        const win = makeWin(doc);
        const stop = installIdleMotionGate(win);
        stop();
        expect(win.__listeners.focus?.length).toBe(0);
        expect(win.__listeners.blur?.length).toBe(0);
        expect(doc.__listeners.visibilitychange?.length).toBe(0);
    });

    it('does not throw when hasFocus() is unavailable', () => {
        const doc = makeDoc({ throwOnFocus: true });
        const win = makeWin(doc);
        expect(() => installIdleMotionGate(win)).not.toThrow();
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
    });
});

describe('the idle gate stylesheets', () => {
    const readCss = async (rel: string) => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        return fs.readFile(path.resolve(here, '..', rel), 'utf8');
    };

    /** The `[data-cl-motion="idle"]` rules of one stylesheet, as raw text. */
    const gateRules = (css: string) =>
        css.split('\n').filter(l => l.includes('data-cl-motion="idle"')).join('\n');

    it('gates the decorative loops in every stylesheet that has them', async () => {
        expect(gateRules(await readCss('styles/keys.css'))).toContain('.k2-leg');
        expect(gateRules(await readCss('styles/home-deck.css'))).toContain('.hd-mote');
        const index = await readCss('index.css');
        expect(gateRules(index)).toContain('.status-online');
        expect(gateRules(index)).toContain('.season-flake');
    });

    it('never gates a ONE-SHOT entry animation', async () => {
        // Regression guard. These all use `animation: … both`, so their resting
        // appearance is the animation's END frame; `animation: none` reverts
        // them to the START frame. Gating `.hd-host::after` — a full-deck
        // opaque veil that only exists to fade out on entry — painted the
        // entire Home deck over in --cl-abyss. Only `infinite` animations may
        // appear in a gate rule.
        const oneShotOnly = ['.hd-host::after', '.hd-tile', '.hd-count', '.hd-pill'];
        const rules = gateRules(await readCss('styles/home-deck.css'));
        for (const sel of oneShotOnly) {
            expect(rules).not.toContain(sel);
        }
    });

    it('never gates an animation that conveys live information', async () => {
        // .hd-wave is the in-call equalizer: a backgrounded window still has to
        // show that a call is running.
        const rules = gateRules(await readCss('styles/home-deck.css'));
        expect(rules).not.toContain('.hd-wave');
    });

    it('pairs `animation:none` with `opacity:0` where the element is only visible mid-animation', async () => {
        // .hd-mote / .season-flake have no resting opacity of their own, so
        // stopping the animation would leave them parked, fully opaque, at
        // their start position.
        const deck = await readCss('styles/home-deck.css');
        const moteRule = gateRules(deck).split('\n').find(l => l.includes('.hd-mote'));
        expect(moteRule).toBeDefined();
        expect(moteRule).toContain('opacity: 0');

        const flakeRule = gateRules(await readCss('index.css')).split('\n').find(l => l.includes('.season-flake'));
        expect(flakeRule).toBeDefined();
        expect(flakeRule).toContain('opacity: 0');
    });
});

/**
 * The occlusion gate — the SECOND, independent reason to stop the same
 * decorative loops: the Descent settings screen is covering them.
 *
 * These pin the two halves that have to agree: the attribute this module
 * publishes, and the stylesheets' scoping of it. The scoping matters because
 * the settings screen renders its OWN copy of the mascot — gating that too
 * would freeze decoration the user is actively looking at.
 */
describe('idleMotion — occlusion gate', () => {
    const readCss = async (rel: string) => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const here = path.dirname(new URL(import.meta.url).pathname);
        return fs.readFile(path.resolve(here, '..', rel), 'utf8');
    };

    it('sets the attribute while occluded and removes it when cleared', () => {
        const doc = makeDoc();
        setOccluded(true, doc);
        expect(doc.__attrs['data-cl-occluded']).toBe(OCCLUDED_ON);
        setOccluded(false, doc);
        expect('data-cl-occluded' in doc.__attrs).toBe(false);
    });

    it('does not rewrite the attribute when the state is unchanged', () => {
        // Each write invalidates style for the whole subtree, which is the
        // very cost this gate exists to avoid.
        const doc = makeDoc();
        setOccluded(true, doc);
        const after = doc.__setCount();
        setOccluded(true, doc);
        setOccluded(true, doc);
        expect(doc.__setCount()).toBe(after);
    });

    it('clearing when never set is a no-op', () => {
        const doc = makeDoc();
        setOccluded(false, doc);
        expect(doc.__setCount()).toBe(0);
    });

    it('is independent of the focus gate — neither clobbers the other', () => {
        const doc = makeDoc();
        applyMotionState(true, doc);
        setOccluded(true, doc);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
        expect(doc.__attrs['data-cl-occluded']).toBe(OCCLUDED_ON);
        setOccluded(false, doc);
        expect(doc.__attrs['data-cl-motion']).toBe(MOTION_ACTIVE);
    });

    it('scopes every occlusion rule so the overlay\'s own decoration keeps running', async () => {
        // Without `:not(.sd-root *)` the settings screen would freeze the
        // mascot it renders for itself.
        for (const file of ['index.css', 'styles/keys.css', 'styles/home-deck.css']) {
            const css = await readCss(file);
            const rules = css
                .split('\n')
                .filter(l => l.includes('data-cl-occluded'));
            expect(rules.length).toBeGreaterThan(0);
            for (const rule of rules) {
                expect(rule).toContain(':not(.sd-root *)');
            }
        }
    });
});
