/**
 * ThemePreviewBar — the "Previewing <name>" safety bar while a theme is shown
 * on the whole app but not kept yet (theme/engine.ts startThemePreview /
 * startBuiltinThemePreview).
 *
 * Owner, 2026-11-26: "When previewing themes, have the little pop-out that
 * says you're previewing, and [a way to] not take the theme — [with a] timer —
 * in case the theme makes text or buttons unfindable." Custom colours are used
 * exactly as picked (no contrast correction, theme/customTheme.ts), so a theme
 * CAN be black on black. This bar is how you get out of one:
 *
 *   Keep     the previewed theme becomes the device's theme
 *            (themePreviewActions.keepPreviewedTheme: main's store + mirror);
 *   Revert   / Escape / the countdown (engine PREVIEW_REVERT_MS, 15 s) /
 *            leaving Settings: the real theme comes back exactly.
 * Picking another theme restarts the countdown. The timer lives in the engine,
 * so the revert happens even if this bar failed to render.
 *
 * UN-THEMABLE BY CONSTRUCTION. The bar must stay readable and clickable
 * whatever the previewed theme does, so none of the app's styling reaches it:
 *   - it renders into a SHADOW ROOT on its own host element, appended to
 *     <html> (outside <body> and the React root), so no app or theme
 *     stylesheet selector can match anything inside it;
 *   - the host's own box is locked with `!important` declarations (`all:
 *     initial`, fixed, max z-index, isolation, opacity 1, no filter /
 *     transform) both inline and in the shadow root's `:host` rule, which the
 *     cascade ranks above ANY outer-document rule, even an !important one;
 *     `all: initial` also stops inherited colour / font / size from leaking in;
 *   - inside, every colour, font family and size is a hard-coded px / hex
 *     value (BAR_COLORS below) and nothing reads a CSS variable, so theme
 *     tokens (which do inherit through `all`) are never used;
 *   - themes are DATA ONLY (theme/customTheme.ts, owner decision D7: never raw
 *     user CSS), so a theme cannot inject a stylesheet in the first place.
 *
 * Keyboard / screen reader: focus moves to Keep when a preview starts, Tab /
 * Shift+Tab cycle Keep and Revert, Enter activates, Escape reverts (shared Esc
 * stack). The start, the 10 s and 5 s marks and the end are announced through
 * an always-mounted aria-live region. No animation (reduced-motion safe, and
 * nothing can leave it mid-fade).
 *
 * Mounted once by Dashboard (signed in: Keep may save to the account's
 * library). The Dashboard unmounting (sign-out) reverts a preview.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useEscape } from '../../hooks/useEscape';
import { claimKeyCombo } from '../../utils/keyClaims';
import { PREVIEW_REVERT_MS, stopThemePreview, useThemePreview } from '../../theme/engine';
import { keepPreviewedTheme } from '../../theme/themePreviewActions';
import {
    ANNOUNCE_AT, BAR_CSS, HOST_LOCK, PREVIEW_BAR_HOST_TAG, computeBarPlacement, countdownText, secondsLeft, startAnnouncement,
    type BarPlacement,
} from './themePreviewBarParts';

function measurePlacement(): BarPlacement {
    const gaugeEl = document.querySelector<HTMLElement>('.sd-gauge');
    const g = gaugeEl?.getBoundingClientRect();
    const obstacles = [...document.querySelectorAll<HTMLElement>('.cl-composer, [data-call-dock]')].map((el) => el.getBoundingClientRect());
    return computeBarPlacement(window.innerWidth, window.innerHeight, g && g.width > 0 ? g : null, obstacles);
}

/** The shadow-root mount point, created on mount and removed on unmount. */
function useShadowMount(): HTMLElement | null {
    const [mount, setMount] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const host = document.createElement(PREVIEW_BAR_HOST_TAG);
        for (const [k, v] of HOST_LOCK) host.style.setProperty(k, v, 'important');
        host.setAttribute('data-theme-preview-host', '');
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = BAR_CSS;
        const el = document.createElement('div');
        root.append(style, el);
        document.documentElement.appendChild(host);
        setMount(el);
        return () => { host.remove(); setMount(null); };
    }, []);
    return mount;
}

export const ThemePreviewBar: React.FC = () => {
    const p = useThemePreview();
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const mount = useShadowMount();
    const keepRef = useRef<HTMLButtonElement>(null);
    const revertRef = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const keptSeq = useRef(0);
    const [now, setNow] = useState(() => Date.now());
    const [note, setNote] = useState<{ seq: number; text: string } | null>(null);
    const [announce, setAnnounce] = useState('');
    const [place, setPlace] = useState<BarPlacement>({ left: 90, bottom: 24, width: 300 });

    const seq = p?.seq ?? 0;
    const previewing = !!p;
    // A `now` older than this preview's start (the interval has not ticked yet) reads as the full countdown.
    const secs = p ? secondsLeft(p.revertAt, Math.max(now, p.revertAt - PREVIEW_REVERT_MS)) : 0;
    const name = p?.name ?? '';

    // Sign-out / Dashboard gone: a preview must never outlive the bar that can stop it.
    useEffect(() => () => { stopThemePreview(); }, []);

    // The countdown display (the revert itself is the engine's timer).
    useEffect(() => {
        if (!previewing) return undefined;
        const t = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(t);
    }, [previewing, p?.revertAt]);

    // A preview started (or replaced): remember where focus was, move it to Keep, announce.
    useEffect(() => {
        if (!seq || !p) return;
        const a = document.activeElement;
        const inBar = a instanceof HTMLElement && a.tagName.toLowerCase() === PREVIEW_BAR_HOST_TAG;
        if (a instanceof HTMLElement && a !== document.body && !inBar) returnFocus.current = a;
        try { keepRef.current?.focus({ preventScroll: true }); } catch { /* detached */ }
        setAnnounce(startAnnouncement(p.name, secondsLeft(p.revertAt, Date.now())));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per preview start
    }, [seq, !!mount]);

    // The 10 s and 5 s marks.
    useEffect(() => {
        if (previewing && ANNOUNCE_AT.has(secs)) setAnnounce(`${secs} seconds left to keep ${name}.`);
    }, [previewing, secs, name]);

    // The preview ended (Keep, Revert, Escape, the timer, leaving Settings): say so, give focus back.
    const wasPreviewing = useRef(false);
    const lastSeq = useRef(0);
    useEffect(() => {
        if (previewing) { wasPreviewing.current = true; lastSeq.current = seq; return; }
        if (!wasPreviewing.current) return;
        wasPreviewing.current = false;
        setAnnounce(keptSeq.current === lastSeq.current ? 'Theme kept.' : 'Preview ended. Your theme is back.');
        const back = returnFocus.current;
        returnFocus.current = null;
        const a = document.activeElement;
        const lost = !a || a === document.body || (a instanceof HTMLElement && a.tagName.toLowerCase() === PREVIEW_BAR_HOST_TAG);
        if (lost && back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch { /* gone */ } }
    }, [previewing, seq]);

    // Placement: re-measured on resize and whenever the page changes under it.
    useEffect(() => {
        if (!previewing) return undefined;
        let pending: ReturnType<typeof setTimeout> | null = null;
        const run = () => { pending = null; setPlace((old) => { const n = measurePlacement(); return old.left === n.left && old.bottom === n.bottom && old.width === n.width ? old : n; }); };
        // Coalesced to one measure per ~frame (a timer, not rAF: rAF pauses in a hidden window).
        const schedule = () => { if (!pending) pending = setTimeout(run, 16); };
        const mo = new MutationObserver(schedule);
        mo.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', schedule);
        run();
        return () => { mo.disconnect(); window.removeEventListener('resize', schedule); if (pending) clearTimeout(pending); };
    }, [previewing]);

    const revert = () => { stopThemePreview(); };
    useEscape(() => { revert(); }, previewing);
    // The `close-panel` keybind (Escape by default) listens on window ahead of the
    // Esc stack and would ALSO close Settings / a panel on the same press. While
    // previewing, Escape belongs to the stack, so one press backs out one step.
    useEffect(() => (previewing ? claimKeyCombo('escape') : undefined), [previewing]);

    const keep = () => {
        if (!p) return;
        const at = p.seq;
        keptSeq.current = at;
        void keepPreviewedTheme(uid).then((r) => {
            if (r.ok) return;
            keptSeq.current = 0;
            setNote({ seq: at, text: 'Could not keep it: your themes are still loading, or you already have 24.' });
        });
    };

    // Focus stays in the bar while it has it: Tab / Shift+Tab cycle Keep and Revert.
    const onBarKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        const order = [keepRef.current, revertRef.current].filter((b): b is HTMLButtonElement => !!b);
        if (order.length === 0) return;
        const at = order.findIndex((b) => b === (e.target as Node));
        e.preventDefault();
        const next = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + order.length) % order.length;
        order[next].focus();
    };

    if (!mount) return null;
    const shownNote = note && p && note.seq === p.seq ? note : null;
    return createPortal(
        <>
            {/* Always mounted, so changes are announced (a region that appears with its text is often skipped). */}
            <span className="sr" role="status" aria-live="polite" aria-atomic="true">{announce}</span>
            {p && (
                <div
                    className="bar"
                    role="alertdialog"
                    aria-modal="false"
                    aria-labelledby="tpb-title"
                    aria-describedby="tpb-count"
                    data-theme-preview-bar
                    style={{ left: `${place.left}px`, bottom: `${place.bottom}px`, width: `${place.width}px` }}
                    onKeyDown={onBarKeyDown}
                >
                    <span className="title" id="tpb-title" title={`Previewing ${name}`}>Previewing {name}</span>
                    <span className="count" id="tpb-count">{countdownText(secs)}</span>
                    {shownNote && <span className="note" role="alert">{shownNote.text}</span>}
                    <div className="actions">
                        <button ref={keepRef} type="button" className="keep" onClick={keep} data-preview-keep>Keep</button>
                        <button ref={revertRef} type="button" className="revert" onClick={revert} data-preview-revert aria-keyshortcuts="Escape">Revert</button>
                    </div>
                </div>
            )}
        </>,
        mount,
    );
};

export default ThemePreviewBar;
