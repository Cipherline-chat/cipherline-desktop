/**
 * ThemePreviewBar — the bottom-left "Previewing <name>" bar while a theme is
 * shown on the whole app for a while (theme/engine.ts startThemePreview).
 *
 * Entry points: Preview on a theme card in chat (ThemeLinkEmbed), Preview in
 * the import dialog (CustomThemeShareDialog, also from a cipherline://theme
 * link), Preview on a custom theme tile (Settings → Appearance → Theme).
 *
 * Actions:
 *   Save          adds the theme to "Your themes" and KEEPS previewing;
 *   Save and use  makes it the device's theme the normal way
 *                 (activeThemeMirror.chooseCustomTheme: main's store + the
 *                 backup mirror) and closes the bar;
 *   ×  / Escape   stops previewing: the device's real theme comes back exactly
 *                 (built-in, custom or Sync with system).
 * Nothing about the preview itself is ever stored: a reload or a restart is
 * always back in the real theme. Escape goes through the shared Esc stack.
 *
 * Mounted once by Dashboard (signed in: the library needs the account). The
 * Dashboard unmounting (sign-out) ends a preview.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { ClButton } from '../cl';
import { useAuth } from '../../contexts/AuthContext';
import { useEscape } from '../../hooks/useEscape';
import { claimKeyCombo } from '../../utils/keyClaims';
import { useCustomThemes } from '../../theme/customThemeLibrary';
import { stopThemePreview, useThemePreview } from '../../theme/engine';
import { saveAndUsePreviewedTheme, savePreviewedTheme, savedEntryFor } from '../../theme/themePreviewActions';
import '../../styles/theme-live-preview.css';

/** What a screen reader hears when a preview starts. */
const previewAnnouncement = (name: string): string => `Previewing theme ${name}. Press Escape to stop.`;

/**
 * Sets --tlp-left / --tlp-bottom on the bar so it never covers the message box,
 * the call dock or the Settings nav: sits 16px above the composer (or call dock)
 * when one is on screen, 24px from the bottom otherwise; with Settings open it
 * starts 16px right of the Settings nav. CSS holds the fallbacks (90px / 16px).
 */
function trackBarClearance(ref: React.RefObject<HTMLDivElement | null>): () => void {
    let raf = 0;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null;
    const measure = () => {
        raf = 0;
        const bar = ref.current;
        if (!bar) return;
        const vh = window.innerHeight;
        const gauge = document.querySelector<HTMLElement>('.sd-gauge');
        let left = '';
        let bottom = 24;
        if (gauge) {
            left = `${Math.round(gauge.getBoundingClientRect().right) + 16}px`;
        } else {
            for (const el of document.querySelectorAll<HTMLElement>('.cl-composer, [data-call-dock]')) {
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;
                bottom = Math.max(bottom, Math.round(vh - r.top) + 16);
                ro?.observe(el);
            }
        }
        if (gauge) ro?.observe(gauge);
        if (left) bar.style.setProperty('--tlp-left', left); else bar.style.removeProperty('--tlp-left');
        bar.style.setProperty('--tlp-bottom', `${bottom}px`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => { mo.disconnect(); ro?.disconnect(); window.removeEventListener('resize', schedule); if (raf) cancelAnimationFrame(raf); };
}

export const ThemePreviewBar: React.FC = () => {
    const p = useThemePreview();
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const lib = useCustomThemes(uid);
    const barRef = useRef<HTMLDivElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const [note, setNote] = useState<{ seq: number; text: string; err: boolean } | null>(null);

    // Sign-out / Dashboard gone: a preview must never outlive the bar that can stop it.
    useEffect(() => () => { stopThemePreview(); }, []);

    // A preview started (or replaced): remember where focus was, then move it to the bar.
    const seq = p?.seq ?? 0;
    useEffect(() => {
        if (!seq) return;
        const bar = barRef.current;
        const a = typeof document !== 'undefined' ? document.activeElement : null;
        if (a instanceof HTMLElement && a !== document.body && !bar?.contains(a)) returnFocus.current = a;
        try { bar?.focus({ preventScroll: true }); } catch { /* detached */ }
    }, [seq]);

    const giveFocusBack = () => {
        const back = returnFocus.current;
        returnFocus.current = null;
        if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch { /* gone */ } }
    };
    // Keep the bar clear of what it would cover (see theme-live-preview.css "Placement").
    useEffect(() => (p ? trackBarClearance(barRef) : undefined), [!!p]);
    const stop = () => { stopThemePreview(); giveFocusBack(); };
    useEscape(() => { stop(); }, !!p);
    // The `close-panel` keybind (Escape by default) listens on window ahead of the
    // Esc stack and would ALSO close Settings / a panel on the same press. While
    // previewing, Escape belongs to the stack, so one press backs out one step.
    const previewing = !!p;
    useEffect(() => (previewing ? claimKeyCombo('escape') : undefined), [previewing]);

    const saved = savedEntryFor(p, lib.items);
    const refusal = !lib.ready ? 'Your themes are still loading.' : lib.full ? 'You have 24 themes. Delete one to add another.' : null;
    const shownNote = note && p && note.seq === p.seq ? note : null;

    const save = () => {
        if (!p || saved) return;
        const r = savePreviewedTheme(uid);
        setNote(r.ok
            ? { seq: p.seq, text: `Saved to your themes as ${r.entry.name}.`, err: false }
            : { seq: p.seq, text: refusal ?? 'Could not save this theme.', err: true });
        // Save turns into a disabled "Saved": keep focus in the bar instead of dropping it to the page.
        try { barRef.current?.focus({ preventScroll: true }); } catch { /* detached */ }
    };
    const saveAndUse = () => {
        if (!p) return;
        const at = p.seq;
        void saveAndUsePreviewedTheme(uid).then((r) => {
            if (!r.ok) setNote({ seq: at, text: refusal ?? 'Could not save this theme.', err: true });
        });
        giveFocusBack();
    };

    const name = p?.def.name ?? '';
    return (
        <>
            {/* Always mounted, so the change is announced (a region that appears with its text is often skipped). */}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {p ? previewAnnouncement(name) : ''}
                {shownNote && !shownNote.err ? ` ${shownNote.text}` : ''}
            </span>
            {p && (
                <div
                    ref={barRef}
                    className="tlp"
                    role="region"
                    aria-label={`Theme preview: ${name}`}
                    tabIndex={-1}
                    data-theme-preview-bar
                >
                    <div className="tlp-row">
                        <span className="tlp-ic" aria-hidden="true"><Eye size={15} strokeWidth={2.4} /></span>
                        <p className="tlp-text" title={`Previewing ${name}`}>
                            Previewing <b>{name}</b>
                        </p>
                        <div className="tlp-actions">
                            <ClButton
                                variant="ghost"
                                size="sm"
                                onClick={save}
                                disabled={!!saved || !!refusal}
                                tooltip={saved ? `In your themes as ${saved.name}` : refusal ?? 'Add it to Your themes and keep previewing'}
                                tooltipSide="bottom"
                            >
                                {saved ? 'Saved' : 'Save'}
                            </ClButton>
                            <ClButton
                                size="sm"
                                onClick={saveAndUse}
                                disabled={!saved && !!refusal}
                                tooltip={!saved && refusal ? refusal : undefined}
                                tooltipSide="bottom"
                            >
                                {saved ? 'Use' : 'Save and use'}
                            </ClButton>
                            <ClButton variant="ghost" size="sm" icon ariaLabel="Stop previewing" tooltip="Stop previewing (Esc)" tooltipSide="bottom" onClick={stop}>
                                <X size={15} strokeWidth={2.6} />
                            </ClButton>
                        </div>
                    </div>
                    {shownNote?.err && <p className="tlp-note" role="alert">{shownNote.text}</p>}
                </div>
            )}
        </>
    );
};

/**
 * Settings → Appearance → Theme while a preview is up: what is on screen is
 * not the device's theme yet. Picking any theme tile ends the preview.
 */
export const ThemePreviewNotice: React.FC = () => {
    const p = useThemePreview();
    if (!p) return null;
    return (
        <div className="tlp-notice" data-theme-preview-notice>
            <span className="tlp-ic" aria-hidden="true"><Eye size={15} strokeWidth={2.4} /></span>
            <p className="tlp-notice-text">
                Previewing <b>{p.def.name}</b>. It is not saved and goes away when you stop previewing or restart. Picking a theme below ends the preview.
            </p>
            <ClButton variant="ghost" size="sm" onClick={() => stopThemePreview()}>Stop previewing</ClButton>
        </div>
    );
};

export default ThemePreviewBar;
