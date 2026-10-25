import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Minus, X } from 'lucide-react';
import { useEscape } from '../hooks/useEscape';
import '../styles/client-block.css';

/**
 * The shared full-screen shell for the two server-imposed blocking screens:
 * "Update required" (UpgradeRequiredOverlay) and "App shut down"
 * (AppSuspendedScreen). It owns everything that makes a screen BLOCKING, so
 * neither screen can get it subtly wrong:
 *
 *   - Portaled to <body>, above every app layer (z-index in client-block.css),
 *     so it covers the auth screen, the loading screen, the dashboard and a
 *     popped-out call alike.
 *   - The app root (#root) is made `inert` while it is up: no pointer, no
 *     focus, no assistive-tech access to anything underneath — the screen
 *     cannot be clicked or tabbed around. Restored on unmount.
 *   - Keyboard: focus moves into the card on mount, Tab / Shift+Tab cycle
 *     inside it, Escape is consumed (top of the escape stack) and does nothing, and keystrokes are stopped in the
 *     capture phase so the app's global shortcuts (Ctrl+K, push-to-talk…)
 *     never fire underneath.
 *   - role="alertdialog" + aria-modal, labelled by the screen's title/body.
 *   - The frameless window stays draggable, and on Linux (where the app draws
 *     its own caption buttons inside the now-inert Dashboard) it keeps a
 *     minimise and a close button, so being blocked never means being unable
 *     to close the window. Windows/macOS draw native controls.
 *
 * There is deliberately no way to dismiss it: the parent unmounts it when the
 * condition is gone (update installed — the app restarts — or shutdown lifted).
 */

const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
const needsOwnWindowControls = (): boolean =>
    !!window.electronAPI
    && !ua.includes('macintosh')
    && !ua.includes('windows')
    && !(navigator as Navigator & { windowControlsOverlay?: { visible?: boolean } }).windowControlsOverlay?.visible;

/** How many blocking screens are mounted (see the inert effect). */
let activeBlockers = 0;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Deterministic "marine snow": the same 14 motes every render (no Math.random in render). */
const SNOW = Array.from({ length: 14 }, (_, i) => ({
    left: `${(i * 37 + 11) % 100}%`,
    size: 2 + (i % 3),
    dur: 14 + ((i * 7) % 11),
    delay: -((i * 13) % 20),
}));

export interface ClientBlockScreenProps {
    tone: 'lume' | 'glow' | 'ok';
    titleId: string;
    bodyId: string;
    /** For tests / harness screenshots. */
    testId?: string;
    leaving?: boolean;
    children: React.ReactNode;
}

export function ClientBlockScreen({ tone, titleId, bodyId, testId, leaving, children }: ClientBlockScreenProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);

    // Make the whole app underneath inert while blocked. Counted, because
    // both screens can be up at once (shut down AND below the floor) and the
    // first to leave must not un-inert the app under the other.
    useLayoutEffect(() => {
        const app = document.getElementById('root');
        if (!app) return;
        activeBlockers++;
        app.inert = true;
        app.setAttribute('aria-hidden', 'true');
        return () => {
            activeBlockers = Math.max(0, activeBlockers - 1);
            if (activeBlockers === 0) {
                app.inert = false;
                app.removeAttribute('aria-hidden');
            }
        };
    }, []);

    // Escape goes through the shared escape stack (utils/escapeStack.ts):
    // this screen is the TOP layer while it is up, and its handler consumes
    // the press without dismissing anything — so Escape can neither close
    // this screen nor reach a dialog of the app hidden underneath it.
    useEscape(() => undefined, true);

    // Focus in, trap Tab, swallow everything else before the app sees it.
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? cardRef.current;
        first?.focus({ preventScroll: true });

        const onKey = (e: KeyboardEvent) => {
            const inside = root.contains(e.target as Node);
            if (e.key === 'Tab') {
                const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
                if (items.length === 0) { e.preventDefault(); return; }
                const idx = items.indexOf(document.activeElement as HTMLElement);
                const next = e.shiftKey
                    ? items[(idx <= 0 ? items.length : idx) - 1]
                    : items[(idx + 1) % items.length];
                e.preventDefault();
                e.stopPropagation();
                next.focus();
                return;
            }
            // Activation keys on our own buttons work normally; nothing else
            // reaches the app's global shortcut listeners.
            if (!inside) { e.preventDefault(); }
            e.stopPropagation();
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('keyup', onKey, true);
        };
    }, []);

    const ownControls = needsOwnWindowControls();

    return createPortal(
        <div
            ref={rootRef}
            className={`cb-root${leaving ? ' is-leaving' : ''}`}
            data-tone={tone}
            data-testid={testId}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
        >
            <div className="cb-drag" aria-hidden />
            {ownControls && (
                <div className="cb-winctl">
                    <button type="button" aria-label="Minimize window" onClick={() => window.electronAPI?.minimizeWindow?.()}><Minus size={14} /></button>
                    <button type="button" className="cb-close" aria-label="Close window" onClick={() => window.electronAPI?.closeWindow?.()}><X size={14} /></button>
                </div>
            )}
            <div className="cb-current a" aria-hidden />
            <div className="cb-current b" aria-hidden />
            <div className="cb-snow" aria-hidden>
                {SNOW.map((s, i) => (
                    <i key={i} style={{ left: s.left, width: s.size, height: s.size, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }} />
                ))}
            </div>
            <div ref={cardRef} className="cb-card" tabIndex={-1}>
                {children}
            </div>
        </div>,
        document.body,
    );
}

export default ClientBlockScreen;
