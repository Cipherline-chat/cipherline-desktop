/**
 * Motion & effects — Settings → Accessibility → "Motion & effects".
 *
 * ONE app-level source of truth for three independent choices:
 *
 *   reduce   'system' | 'on' | 'off'   Reduce motion.
 *              system (default) follows the OS setting; on forces reduced motion
 *              even if the OS allows full motion; off allows full motion even
 *              when the OS asks for reduced motion (an explicit in-app choice
 *              wins over the OS default, so someone who finds the reduced
 *              presentation worse can opt out of it for this app only).
 *   images   'always' | 'hover' | 'never'   Animated images (GIFs, animated
 *              emoji, animated avatars / server icons / banners).
 *              always = every surface plays as it was designed to (GIFs and
 *              emoji play; avatars and banners keep their own hover / speaking /
 *              opened-profile rules). hover = frozen until hovered or focused.
 *              never = first frame only, with a play button on GIFs.
 *   effects  boolean   Celebrations and effects (confetti, Pro welcome, gift
 *              unwrap motion, high-five, first friend, mascot idle, ambient
 *              motes, marine snow, ping pill float). Calls, screen share and
 *              video are never affected.
 *
 * How the choice reaches the code:
 *   CSS   <html data-reduced-motion="true|false"> (absent = follow the OS). The
 *         PostCSS step (postcss-reduced-motion.cjs) makes every existing
 *         `@media (prefers-reduced-motion: reduce)` rule also answer to it, so
 *         the 200+ rules are written once.
 *         <html data-effects="off"> lets CSS drop decorative loops.
 *   JS    `window.matchMedia('(prefers-reduced-motion: …)')` is wrapped
 *         (`installReducedMotionMedia`) so the ~35 direct call sites, framer-motion's
 *         useReducedMotion and every test that mocks matchMedia keep working
 *         unchanged; `prefersReducedMotion()` / `usePrefersReducedMotion()` read
 *         the same effective value.
 *
 * Stored in secureLocalStore under ONE key (backed up: portable preferences).
 * Nothing is written on mount; the store is cold until the account is ready, so
 * the snapshot refreshes then and after a backup restore.
 *
 * Migration: `images` is absent until the user chooses. GIFs then follow the
 * legacy "Automatically play GIFs" setting (off => hover), everything else
 * stays 'always' — nobody's current behaviour changes.
 */
import { useSyncExternalStore } from 'react';
import * as storeModule from '../secureLocalStore';
import { loadGifSettings, updateGifSettings, GIF_SETTINGS_CHANGED } from '../../hooks/useGifSettings';
import { BACKUP_RESTORED_EVENT } from '../../services/backupRegistry';

/** The store, tolerant of test doubles that export only the default or only the named instance. */
type Store = typeof storeModule.secureLocalStore;
const secureLocalStore: Store = new Proxy({} as Store, {
    get(_t, prop) {
        let inst: Store | undefined;
        try { inst = storeModule.secureLocalStore; } catch { /* named export absent */ }
        if (!inst) { try { inst = storeModule.default; } catch { /* default absent */ } }
        const v = inst ? (inst as unknown as Record<string | symbol, unknown>)[prop] : undefined;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(inst) : v;
    },
});

export type ReduceMotionMode = 'system' | 'on' | 'off';
export type ImageMotionMode = 'always' | 'hover' | 'never';
export type ImageCategory = 'gif' | 'emoji' | 'avatar';

export const MOTION_PREFS_KEY = 'cipherline_motion_prefs';
export const MOTION_PREFS_CHANGED_EVENT = 'cipherline:motion-prefs-changed';

export const REDUCE_MODES: readonly ReduceMotionMode[] = ['system', 'on', 'off'];
export const IMAGE_MODES: readonly ImageMotionMode[] = ['always', 'hover', 'never'];

export interface StoredMotionPrefs {
    reduce: ReduceMotionMode;
    /** Undefined until the user chooses (see Migration above). */
    images: ImageMotionMode | undefined;
    effects: boolean;
}

export const DEFAULT_MOTION_PREFS: StoredMotionPrefs = { reduce: 'system', images: undefined, effects: true };

/** Strict parse: anything malformed falls back per-field to the default. Never throws. */
export function parseMotionPrefs(raw: string | null | undefined): StoredMotionPrefs {
    let v: Record<string, unknown> = {};
    try {
        const p = raw ? JSON.parse(raw) : {};
        if (p && typeof p === 'object' && !Array.isArray(p)) v = p as Record<string, unknown>;
    } catch { /* defaults */ }
    return {
        reduce: REDUCE_MODES.includes(v.reduce as ReduceMotionMode) ? (v.reduce as ReduceMotionMode) : 'system',
        images: IMAGE_MODES.includes(v.images as ImageMotionMode) ? (v.images as ImageMotionMode) : undefined,
        effects: typeof v.effects === 'boolean' ? v.effects : true,
    };
}

/** The effective "is motion reduced" answer. */
export function effectiveReducedMotion(mode: ReduceMotionMode, osReduced: boolean): boolean {
    return mode === 'on' ? true : mode === 'off' ? false : osReduced;
}

/**
 * The playback mode a surface should use. An explicit choice wins; otherwise
 * GIFs follow the legacy autoplay setting and everything else is 'always'.
 * Reduced motion (effective) turns "play automatically" into "on hover" — the
 * rule GifPlayer has always had for the OS setting.
 */
export function effectiveImageMode(
    stored: ImageMotionMode | undefined,
    category: ImageCategory,
    legacyAutoPlayGifs: boolean,
    reduced: boolean,
): ImageMotionMode {
    const base: ImageMotionMode = stored ?? (category === 'gif' && !legacyAutoPlayGifs ? 'hover' : 'always');
    return reduced && base === 'always' ? 'hover' : base;
}

/** Whether a surface in `mode` shows its animation right now. */
export function imagePlays(mode: ImageMotionMode, hoveredOrFocused: boolean, manualPlay = false): boolean {
    if (manualPlay) return true;
    return mode === 'always' ? true : mode === 'hover' ? hoveredOrFocused : false;
}

// ── store ────────────────────────────────────────────────────────────────────

export interface MotionSnapshot extends StoredMotionPrefs {
    /** Effective reduced motion (after the OS query). */
    reduced: boolean;
    legacyAutoPlayGifs: boolean;
}

/** The browser's own matchMedia, set once ours wraps it (before that, window.matchMedia IS the real one). */
let realMatchMedia: ((q: string) => MediaQueryList) | null = null;

const osQuery = (): MediaQueryList | null => {
    try {
        const mm = realMatchMedia ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null);
        return mm ? mm('(prefers-reduced-motion: reduce)') : null;
    } catch { return null; }
};
/** Held so the OS 'change' listener's target is not garbage collected. */
const osHold: MediaQueryList[] = [];
const osReduced = (): boolean => !!osQuery()?.matches;

function readStored(): StoredMotionPrefs {
    try { return parseMotionPrefs(secureLocalStore.getItem(MOTION_PREFS_KEY)); } catch { return DEFAULT_MOTION_PREFS; }
}

function rawOf(key: string): string | null {
    try { return secureLocalStore.getItem(key); } catch { return null; }
}

function build(): MotionSnapshot {
    const s = readStored();
    let legacy = true;
    try { legacy = loadGifSettings().autoPlayGifs; } catch { /* default */ }
    return { ...s, legacyAutoPlayGifs: legacy, reduced: effectiveReducedMotion(s.reduce, osReduced()) };
}

/**
 * The current snapshot. Rebuilt only when an input (the two stored strings or
 * the OS query) differs from last time, so the SAME object comes back between
 * changes (what useSyncExternalStore needs) and a hot call site costs two map
 * reads and a matchMedia call.
 */
let lastKey: string | null = null;
let snap: MotionSnapshot = build();
function current(): MotionSnapshot {
    const key = `${rawOf(MOTION_PREFS_KEY)}|${rawOf('cipherline_gif_settings')}|${osReduced()}`;
    if (key !== lastKey) { lastKey = key; snap = build(); }
    return snap;
}
const compute = current;
const subs = new Set<() => void>();
let wired = false;

function same(a: MotionSnapshot, b: MotionSnapshot): boolean {
    return a.reduce === b.reduce && a.images === b.images && a.effects === b.effects
        && a.reduced === b.reduced && a.legacyAutoPlayGifs === b.legacyAutoPlayGifs;
}

export function refreshMotionPrefs(): void {
    const prev = snap;
    const next = compute();
    if (next === prev || same(next, prev)) return;
    applyMotionToDocument(next);
    subs.forEach(f => f());
    vmqls.forEach(m => m.refresh());
}

function wire(): void {
    if (wired || typeof window === 'undefined') return;
    wired = true;
    window.addEventListener(MOTION_PREFS_CHANGED_EVENT, refreshMotionPrefs);
    window.addEventListener(GIF_SETTINGS_CHANGED, refreshMotionPrefs);
    window.addEventListener(BACKUP_RESTORED_EVENT, refreshMotionPrefs);
    try {
        const mql = osQuery();
        if (mql) { osHold.push(mql); mql.addEventListener?.('change', refreshMotionPrefs); }
    } catch { /* old engine */ }
    // The store is cold until the account is ready; re-read then.
    void Promise.resolve(secureLocalStore.whenAccountReady?.()).catch(() => undefined).then(refreshMotionPrefs);
}

export function getMotionSnapshot(): MotionSnapshot { return current(); }

export function subscribeMotion(cb: () => void): () => void {
    wire();
    subs.add(cb);
    return () => { subs.delete(cb); };
}

function persist(patch: Partial<StoredMotionPrefs>): void {
    const next = { ...readStored(), ...patch };
    const out: Record<string, unknown> = { reduce: next.reduce, effects: next.effects };
    if (next.images) out.images = next.images;
    try { secureLocalStore.setItem(MOTION_PREFS_KEY, JSON.stringify(out)); } catch { /* applies for this session */ }
    try { window.dispatchEvent(new CustomEvent(MOTION_PREFS_CHANGED_EVENT)); } catch { /* no DOM */ }
    refreshMotionPrefs();
}

export function setReduceMotion(mode: ReduceMotionMode): void {
    if (!REDUCE_MODES.includes(mode)) return;
    persist({ reduce: mode });
}

/** Also mirrors the legacy autoplay flag so an older build / a restored backup agrees. */
export function setImageMode(mode: ImageMotionMode): void {
    if (!IMAGE_MODES.includes(mode)) return;
    persist({ images: mode });
    updateGifSettings({ autoPlayGifs: mode === 'always' });
}

export function setEffectsEnabled(on: boolean): void { persist({ effects: !!on }); }

// ── plain getters (non-React callers) ────────────────────────────────────────

export const reducedMotionNow = (): boolean => { refreshMotionPrefs(); return snap.reduced; };
export const effectsEnabledNow = (): boolean => current().effects;
export const imageModeNow = (category: ImageCategory): ImageMotionMode =>
    effectiveImageMode(current().images, category, current().legacyAutoPlayGifs, current().reduced);

// ── React ────────────────────────────────────────────────────────────────────

export function useMotionSnapshot(): MotionSnapshot {
    return useSyncExternalStore(subscribeMotion, getMotionSnapshot, getMotionSnapshot);
}
export function useReducedMotionSetting(): boolean { return useMotionSnapshot().reduced; }
export function useEffectsEnabled(): boolean { return useMotionSnapshot().effects; }
/**
 * Celebrations and effects: reduced motion OR the effects switch off. The
 * celebration hosts already have a static end state for reduced motion (the
 * finished card, the unwrap cross-fade, no particles) — "effects off" reuses
 * it, so the sequence (unwrap, then welcome) and its timing are unchanged,
 * only the motion is dropped. Calls, screen share and video never read this.
 */
export const celebrationReducedNow = (): boolean => { refreshMotionPrefs(); return snap.reduced || !snap.effects; };
export function useCelebrationReduced(): boolean { const s = useMotionSnapshot(); return s.reduced || !s.effects; }

export function useImageMode(category: ImageCategory): ImageMotionMode {
    const s = useMotionSnapshot();
    return effectiveImageMode(s.images, category, s.legacyAutoPlayGifs, s.reduced);
}

// ── document attributes ──────────────────────────────────────────────────────

export function applyMotionToDocument(
    s: Pick<MotionSnapshot, 'reduce' | 'effects'>,
    el: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
    if (!el) return;
    if (s.reduce === 'system') el.removeAttribute('data-reduced-motion');
    else el.setAttribute('data-reduced-motion', s.reduce === 'on' ? 'true' : 'false');
    if (s.effects) el.removeAttribute('data-effects');
    else el.setAttribute('data-effects', 'off');
}

// ── matchMedia wrapper ───────────────────────────────────────────────────────

const REDUCE_Q = /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;
const NOPREF_Q = /^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/i;

class VirtualMql {
    onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
    private ls = new Set<(e: MediaQueryListEvent) => void>();
    private last: boolean;
    readonly media: string;
    private readonly invert: boolean;
    constructor(media: string, invert: boolean) { this.media = media; this.invert = invert; this.last = this.matches; }
    get matches(): boolean { const r = current().reduced; return this.invert ? !r : r; }
    addEventListener(_t: string, cb: EventListenerOrEventListenerObject | null) {
        if (!cb) return;
        this.ls.add(typeof cb === 'function' ? cb as (e: MediaQueryListEvent) => void : (e) => cb.handleEvent(e));
        wire();
    }
    removeEventListener() { /* one shared object per query for the whole session */ }
    addListener(cb: (e: MediaQueryListEvent) => void) { this.ls.add(cb); wire(); }
    removeListener(cb: (e: MediaQueryListEvent) => void) { this.ls.delete(cb); }
    dispatchEvent() { return false; }
    refresh() {
        const m = this.matches;
        if (m === this.last) return;
        this.last = m;
        const ev = { matches: m, media: this.media } as MediaQueryListEvent;
        this.ls.forEach(f => { try { f(ev); } catch { /* one bad listener */ } });
        try { this.onchange?.call(this as unknown as MediaQueryList, ev); } catch { /* ditto */ }
    }
}
const vmqls = new Set<VirtualMql>();
const vmqlByQuery = new Map<string, VirtualMql>();

let installed = false;
/**
 * Make `window.matchMedia('(prefers-reduced-motion: reduce | no-preference)')`
 * answer with the effective setting. Other queries pass through untouched.
 * Idempotent; call once before the first render.
 */
export function installReducedMotionMedia(): void {
    if (installed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    installed = true;
    const orig = window.matchMedia.bind(window);
    realMatchMedia = orig;
    compute();
    window.matchMedia = ((q: string) => {
        const key = String(q);
        const invert = NOPREF_Q.test(key);
        if (!invert && !REDUCE_Q.test(key)) return orig(q);
        let m = vmqlByQuery.get(key);
        if (!m) { m = new VirtualMql(key, invert); vmqlByQuery.set(key, m); vmqls.add(m); }
        return m as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    wire();
}

/**
 * Boot: wrap matchMedia, take the stored value and put the attributes on <html>.
 * Called from main.tsx before the first render (and by the screenshot harnesses).
 */
export function bootMotion(): void {
    installReducedMotionMedia();
    refreshMotionPrefs();
    applyMotionToDocument(current());
}
