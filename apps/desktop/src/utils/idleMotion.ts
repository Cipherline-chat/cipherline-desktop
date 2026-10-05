/**
 * Idle-motion gate.
 *
 * The app's decorative loops (the Keys mascot's idle sway, the home deck's
 * ambient motes and micro-loops, seasonal flakes, the online status pulse) are
 * `animation: … infinite` — they run for as long as they are mounted, whether
 * or not anyone is looking at the window.
 *
 * That is the whole of Cipherline's idle CPU cost. Measured on the Home panel,
 * signed in, no call, nothing happening:
 *
 *     all decorative animations running   84.6% of a core (total, all processes)
 *     the same view with `animation:none`  2.3%
 *
 * The mascot alone is ~10 points of renderer MAIN-thread time, because it
 * animates `transform` on twelve SVG child elements — SVG children cannot get
 * their own compositing layer, so every frame is a main-thread style recalc +
 * repaint. That cost is paid on every platform, GPU or not.
 *
 * This module publishes one bit to CSS — `<html data-cl-motion="idle|active">`
 * — so the stylesheets can stop those loops when the window is blurred or
 * hidden. Nobody is looking at a decorative sway in a window they have alt-
 * tabbed away from, so nothing is lost visually; see the `[data-cl-motion]`
 * blocks in keys.css / home-deck.css / index.css for what is gated.
 *
 * Only decoration is gated. Anything that carries live information — the call
 * equalizer, incoming-call rings, loading shimmers and spinners — is deliberately
 * left alone, because a background window still needs to show it is doing work.
 *
 * Why an attribute on <html> and not a React context: the animations live in
 * plain CSS across three stylesheets and several components that are not all
 * under one provider, and re-rendering the tree on every focus change to toggle
 * a class would itself cost more than it saves.
 */

/** Attribute value while the window is focused and visible. */
export const MOTION_ACTIVE = 'active';
/** Attribute value while the window is blurred or hidden. */
export const MOTION_IDLE = 'idle';

/** True when the window is focused AND visible. */
export function isWindowActive(doc: Document = document): boolean {
    // `hasFocus()` throws in no-browsing-context edge cases; treat that as active
    // so a failure can never leave the UI frozen.
    let focused = true;
    try {
        focused = doc.hasFocus();
    } catch {
        focused = true;
    }
    return !doc.hidden && focused;
}

/** Writes the current state onto <html>. Exported for tests. */
export function applyMotionState(active: boolean, doc: Document = document): void {
    const root = doc.documentElement;
    if (!root) return;
    const next = active ? MOTION_ACTIVE : MOTION_IDLE;
    // Avoid a pointless attribute write (each one invalidates style for the
    // whole subtree) when nothing actually changed.
    if (root.getAttribute('data-cl-motion') !== next) {
        root.setAttribute('data-cl-motion', next);
        for (const cb of [...motionListeners]) { try { cb(active); } catch { /* a listener must not break the gate */ } }
    }
}

const motionListeners = new Set<(active: boolean) => void>();

/**
 * The gate's current answer, for JS-driven decoration (rAF canvases) that a
 * stylesheet cannot stop. Defaults to active before the gate is installed.
 */
export function isMotionActive(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
    return doc?.documentElement?.getAttribute('data-cl-motion') !== MOTION_IDLE;
}

/** Called with the new state whenever the gate flips. Returns an unsubscribe. */
export function onMotionChange(cb: (active: boolean) => void): () => void {
    motionListeners.add(cb);
    return () => { motionListeners.delete(cb); };
}

/** Attribute value while a full-surface overlay covers the app behind it. */
export const OCCLUDED_ON = 'on';

/**
 * Second, independent reason to stop the same decorative loops: something is
 * covering them.
 *
 * `data-cl-motion` above answers "is anyone looking at this window". This one
 * answers "is anyone looking at what is UNDERNEATH the thing on top" — the
 * Descent settings screen (SettingsScreen.tsx) is a full-surface overlay, and
 * the dashboard keeps animating behind it either fully hidden (fullscreen
 * mode) or behind a 70%-black scrim (windowed mode, which is what
 * any viewport ≥1080x780 gets — i.e. every normal desktop).
 *
 * Measured in the real client at 1920x1080 CSS / DPR 2, settings closed,
 * 5 interleaved A/B windows (style recalc is main-thread work, so this number
 * is not confounded by the software rasteriser used when profiling headless):
 *
 *     decorative animations running   6.53 ms/frame of style recalc (4.20–9.40)
 *     the same view, animations gated 1.24 ms/frame            (0.68–2.07)
 *
 * ~5.3x, with no overlap between the two sets. Every one of those frames was
 * being spent on animation nobody could see.
 *
 * This bullet used to go on to say that on a 4K panel those same wasted frames
 * also re-dirty the backdrop behind the veil's full-viewport `backdrop-filter`
 * (8.3 Mpx of blur to redo), and that this is "why the settings screen is the
 * worst offender on a high-DPI display". The diagnosis was right; the remedy
 * attributed to it was not. Gating the animation behind the veil could never
 * have fixed it, because the filter was recomputed on EVERY compositor frame
 * however it was triggered — the Descent's own motes and mascot, a hover, a
 * toggle, a keystroke. The veil's `backdrop-filter` has since been removed
 * outright (see the long note on `.sd-veil` in settings-descent.css for the
 * numbers); this gate still earns its keep on the style-recalc figures above,
 * which are what it actually buys.
 *
 * Scoped with `:not(.sd-root *)` in the stylesheets so the overlay's OWN
 * decoration (the settings screen renders its own copy of the mascot) keeps
 * animating — only what is behind it stops.
 */
export function setOccluded(occluded: boolean, doc: Document = document): void {
    const root = doc.documentElement;
    if (!root) return;
    if (occluded) {
        if (root.getAttribute('data-cl-occluded') !== OCCLUDED_ON) {
            root.setAttribute('data-cl-occluded', OCCLUDED_ON);
        }
    } else if (root.hasAttribute('data-cl-occluded')) {
        root.removeAttribute('data-cl-occluded');
    }
}

let installed = false;

/** Decorative loops rest after this long without pointer/key/wheel input. */
export const INPUT_IDLE_MS = 45_000;

/**
 * Starts the gate. Idempotent — calling it twice does not double-subscribe.
 * Returns a teardown function (used by tests; the app never stops it).
 */
export function installIdleMotionGate(win: Window = window): () => void {
    const doc = win.document;
    if (installed && win === window) return () => { /* already running */ };
    installed = true;

    // Minimised / closed to tray, as reported by the MAIN process. The page's
    // own signals are not enough on their own: the window is created with
    // `backgroundThrottling: false` (electron/main.ts — the WebSocket must
    // keep running), which also stops Chromium from ever telling the page it
    // is hidden, so `document.hidden` stays false and every frame keeps being
    // produced while minimised; and hiding to the tray does not reliably blur.
    // Cleared by the next focus, which is how a window comes back.
    let backgrounded = false;
    // Nobody has touched the app for INPUT_IDLE_MS: a focused window left on
    // the Home deck kept its mascot sway, motes and spotlight running for as
    // long as it sat there (measured ~42% of a core, 60 frames/s, with the
    // window simply open on Home). Any pointer/key/wheel input resumes them
    // the same frame. Decoration only — the same rules as the focus gate.
    let inputIdle = false;
    let lastInput = Date.now();
    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    const sync = () => applyMotionState(!backgrounded && !inputIdle && isWindowActive(doc), doc);
    const armInputTimer = (ms: number) => {
        inputTimer = setTimeout(() => {
            inputTimer = null;
            const quiet = Date.now() - lastInput;
            if (quiet >= INPUT_IDLE_MS) { inputIdle = true; sync(); }
            else armInputTimer(INPUT_IDLE_MS - quiet);
        }, ms);
    };
    // Cheap on purpose (pointermove is hot): one timestamp write; the timer is
    // only re-armed when it is not already pending.
    const onInput = () => {
        lastInput = Date.now();
        if (inputIdle) { inputIdle = false; sync(); }
        if (!inputTimer) armInputTimer(INPUT_IDLE_MS);
    };
    armInputTimer(INPUT_IDLE_MS);
    const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const ev of INPUT_EVENTS) win.addEventListener(ev, onInput, { capture: true, passive: true });
    const onBackground = () => { backgrounded = true; sync(); };
    // Coming back to the window counts as input.
    const onForeground = () => { backgrounded = false; onInput(); sync(); };

    const api = (win as unknown as { electronAPI?: Partial<Record<'onWindowMinimize' | 'onWindowHide' | 'onWindowFocus', (cb: () => void) => (() => void)>> }).electronAPI;
    // Only a REAL OS focus (the main process's BrowserWindow 'focus' push)
    // ends a minimise/hide: a page can receive a DOM 'focus' while its window
    // is still hidden (measured: with backgroundThrottling off, a hidden
    // window's page kept reporting hasFocus() === true and got DOM focus
    // events), and that would restart the loops nobody can see. Without the
    // bridge (browser, tests) DOM focus is all there is.
    const domFocus = api?.onWindowFocus ? sync : onForeground;

    // focus/blur cover alt-tab; visibilitychange covers minimise and OS
    // workspace switches. Same three signals as useWindowFocus, kept here
    // rather than reused so the gate works before React mounts.
    win.addEventListener('focus', domFocus);
    win.addEventListener('blur', sync);
    doc.addEventListener('visibilitychange', sync);
    const unsubs = [
        api?.onWindowMinimize?.(onBackground),
        api?.onWindowHide?.(onBackground),
        api?.onWindowFocus?.(onForeground),
    ];

    sync();

    return () => {
        if (inputTimer) clearTimeout(inputTimer);
        for (const ev of INPUT_EVENTS) win.removeEventListener(ev, onInput, { capture: true });
        win.removeEventListener('focus', domFocus);
        win.removeEventListener('blur', sync);
        doc.removeEventListener('visibilitychange', sync);
        for (const u of unsubs) { try { u?.(); } catch { /* already gone */ } }
        if (win === window) installed = false;
    };
}
