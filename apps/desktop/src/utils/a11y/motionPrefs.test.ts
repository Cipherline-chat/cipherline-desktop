// @vitest-environment jsdom
/**
 * Settings → Accessibility → Motion & effects: the setting → effective value
 * rules (System/On/Off × OS on/off), animated-image playback, celebration
 * gating, the storage migration from the old GIF toggle, and the matchMedia
 * wrapper that makes every existing reduced-motion check follow the setting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = new Map<string, string>();
const writes: string[] = [];
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    whenAccountReady: () => Promise.resolve(),
};
vi.mock('../secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

// A controllable OS preference. Installed BEFORE motionPrefs wraps matchMedia.
const os = { reduced: false, listeners: new Set<(e: { matches: boolean }) => void>() };
function osMql(q: string) {
    return {
        media: q,
        get matches() { return /reduce\)/.test(q) ? os.reduced : false; },
        addEventListener: (_: string, f: (e: { matches: boolean }) => void) => os.listeners.add(f),
        removeEventListener: (_: string, f: (e: { matches: boolean }) => void) => os.listeners.delete(f),
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false, onchange: null,
    };
}
(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => osMql(q);

const m = await import('./motionPrefs');
const { classifyKvKey } = await import('../../services/backupRegistry');

const setOs = (reduced: boolean) => { os.reduced = reduced; m.refreshMotionPrefs(); };
const stored = (o: Record<string, unknown>) => { mem.set(m.MOTION_PREFS_KEY, JSON.stringify(o)); m.refreshMotionPrefs(); };

beforeEach(() => {
    mem.clear(); writes.length = 0; os.reduced = false;
    document.documentElement.removeAttribute('data-reduced-motion');
    document.documentElement.removeAttribute('data-effects');
    m.refreshMotionPrefs();
});

describe('reduce motion: System / On / Off x OS', () => {
    it.each([
        ['system', false, false], ['system', true, true],
        ['on', false, true], ['on', true, true],
        ['off', false, false], ['off', true, false],
    ] as const)('%s with OS reduced=%s -> %s', (mode, osReduced, want) => {
        expect(m.effectiveReducedMotion(mode, osReduced)).toBe(want);
    });

    it('the live snapshot follows the stored setting and the OS (positive control: it changes)', () => {
        expect(m.reducedMotionNow()).toBe(false);
        setOs(true);
        expect(m.reducedMotionNow()).toBe(true);           // System follows the OS
        stored({ reduce: 'off' });
        expect(m.reducedMotionNow()).toBe(false);          // Off beats an OS that asks for reduced
        stored({ reduce: 'on' });
        setOs(false);
        expect(m.reducedMotionNow()).toBe(true);           // On beats an OS that allows motion
    });
});

describe('parsing is strict', () => {
    it.each([null, '', 'x', '[]', '{"reduce":"maybe","images":"sometimes","effects":"yes"}', '"on"'])('malformed %j -> defaults', raw => {
        expect(m.parseMotionPrefs(raw as string | null)).toEqual({ reduce: 'system', images: undefined, effects: true });
    });
    it('keeps valid fields independently', () => {
        expect(m.parseMotionPrefs('{"reduce":"on","images":"never","effects":false}')).toEqual({ reduce: 'on', images: 'never', effects: false });
        expect(m.parseMotionPrefs('{"reduce":"on","images":"bogus"}')).toEqual({ reduce: 'on', images: undefined, effects: true });
    });
});

describe('animated image playback mode', () => {
    it('explicit choice wins; "always" becomes hover under reduced motion', () => {
        expect(m.effectiveImageMode('always', 'gif', true, false)).toBe('always');
        expect(m.effectiveImageMode('always', 'gif', true, true)).toBe('hover');
        expect(m.effectiveImageMode('hover', 'emoji', true, false)).toBe('hover');
        expect(m.effectiveImageMode('never', 'avatar', true, true)).toBe('never');
    });
    it('imagePlays: always / hover / never / manual play', () => {
        expect(m.imagePlays('always', false)).toBe(true);
        expect(m.imagePlays('hover', false)).toBe(false);
        expect(m.imagePlays('hover', true)).toBe(true);
        expect(m.imagePlays('never', true)).toBe(false);   // hover does not play in Never
        expect(m.imagePlays('never', false, true)).toBe(true); // the play button does
    });
});

describe('migration: nobody\'s current behaviour changes', () => {
    it('untouched install: everything plays as designed', () => {
        expect(m.imageModeNow('gif')).toBe('always');
        expect(m.imageModeNow('emoji')).toBe('always');
        expect(m.imageModeNow('avatar')).toBe('always');
        expect(m.effectsEnabledNow()).toBe(true);
        expect(m.getMotionSnapshot().reduce).toBe('system');
    });
    it('"Automatically play GIFs" was off -> GIFs on hover, emoji/avatars untouched', () => {
        mem.set('cipherline_gif_settings', JSON.stringify({ autoPlayGifs: false }));
        m.refreshMotionPrefs();
        expect(m.imageModeNow('gif')).toBe('hover');
        expect(m.imageModeNow('emoji')).toBe('always');
        expect(m.imageModeNow('avatar')).toBe('always');
    });
    it('reading and refreshing never writes (no write on mount)', () => {
        m.refreshMotionPrefs(); m.getMotionSnapshot(); m.reducedMotionNow(); m.imageModeNow('gif');
        expect(writes).toEqual([]);
    });
    it('choosing a mode applies to every category and mirrors the legacy toggle', () => {
        mem.set('cipherline_gif_settings', JSON.stringify({ autoPlayGifs: false, klipyEnabled: true }));
        m.setImageMode('always');
        expect(JSON.parse(mem.get('cipherline_gif_settings')!)).toMatchObject({ autoPlayGifs: true, klipyEnabled: true }); // KLIPY opt-in untouched
        expect(m.imageModeNow('gif')).toBe('always');
        m.setImageMode('never');
        expect(JSON.parse(mem.get('cipherline_gif_settings')!).autoPlayGifs).toBe(false);
        expect(m.imageModeNow('gif')).toBe('never');
        expect(m.imageModeNow('emoji')).toBe('never');
        expect(m.imageModeNow('avatar')).toBe('never');
    });
});

describe('celebrations and effects switch', () => {
    it('on by default; off makes celebrations take their still path, nothing else', () => {
        expect(m.celebrationReducedNow()).toBe(false);
        m.setEffectsEnabled(false);
        expect(m.effectsEnabledNow()).toBe(false);
        expect(m.celebrationReducedNow()).toBe(true);
        expect(m.reducedMotionNow()).toBe(false);           // general motion is a separate setting
        expect(m.imageModeNow('gif')).toBe('always');       // so are images
        m.setEffectsEnabled(true);
        expect(m.celebrationReducedNow()).toBe(false);
    });
    it('reduced motion also gives the still path (as before)', () => {
        setOs(true);
        expect(m.celebrationReducedNow()).toBe(true);
    });
    it('the three settings persist together under one key and survive each other', () => {
        m.setReduceMotion('on'); m.setImageMode('hover'); m.setEffectsEnabled(false);
        expect(JSON.parse(mem.get(m.MOTION_PREFS_KEY)!)).toEqual({ reduce: 'on', effects: false, images: 'hover' });
        m.setReduceMotion('bogus' as never);
        expect(m.getMotionSnapshot().reduce).toBe('on');
    });
});

describe('document attributes (the CSS hook)', () => {
    it('System removes the attribute, On/Off set it; effects off sets data-effects', () => {
        const el = document.documentElement;
        m.setReduceMotion('on');
        expect(el.getAttribute('data-reduced-motion')).toBe('true');
        m.setReduceMotion('off');
        expect(el.getAttribute('data-reduced-motion')).toBe('false');
        m.setReduceMotion('system');
        expect(el.hasAttribute('data-reduced-motion')).toBe(false);
        m.setEffectsEnabled(false);
        expect(el.getAttribute('data-effects')).toBe('off');
        m.setEffectsEnabled(true);
        expect(el.hasAttribute('data-effects')).toBe(false);
    });
});

describe('matchMedia wrapper: every existing reduced-motion check follows the setting', () => {
    it('answers with the effective value, notifies listeners, passes other queries through', () => {
        const before = window.matchMedia;
        m.installReducedMotionMedia();
        expect(window.matchMedia).not.toBe(before);
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
        const noPref = window.matchMedia('(prefers-reduced-motion: no-preference)');
        const seen: boolean[] = [];
        reduce.addEventListener('change', e => seen.push((e as MediaQueryListEvent).matches));

        expect(reduce.matches).toBe(false);
        expect(noPref.matches).toBe(true);
        m.setReduceMotion('on');
        expect(reduce.matches).toBe(true);
        expect(noPref.matches).toBe(false);
        expect(seen).toEqual([true]);

        m.setReduceMotion('off'); setOs(true);              // OS asks for reduced; user said allow motion
        expect(reduce.matches).toBe(false);
        m.setReduceMotion('system');                        // now the OS wins again
        expect(reduce.matches).toBe(true);

        expect(window.matchMedia('(min-width: 1px)').media).toBe('(min-width: 1px)'); // untouched
        m.installReducedMotionMedia();                      // idempotent
        expect(window.matchMedia('(prefers-reduced-motion: reduce)')).toBe(reduce);
    });
});

describe('backups', () => {
    it('the key is classified as a portable preference (included)', () => {
        expect(classifyKvKey(m.MOTION_PREFS_KEY, 'u1')).toBe('include');
    });
});
