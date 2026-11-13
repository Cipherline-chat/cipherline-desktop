import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Trash2, Keyboard, Copy, Check } from 'lucide-react';
import {
    ACTIONS, ACTION_CATEGORIES,
    eventToCombo, formatCombo,
    type BindableAction, type KeybindHook,
} from '../hooks/useKeybinds';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import { OPEN_SHORTCUTS_EVENT } from '../utils/shortcutsSheet';
import {
    globalShortcutNotice, globalShortcutCoverage, portalBindingNotice, hyprlandBindLines,
} from '../utils/globalShortcutNotice';
import { writeToClipboard } from '../utils/clipboard';

/**
 * Twilight · Keybinds — Descent redesign (phase 2).
 * One card per category; combos render as physical keycap chips that breathe
 * while listening for the replacement combo. Esc cancels a capture.
 */
interface KeybindSettingsProps {
    keybinds: KeybindHook;
}

/** A combo as keycap chips. Click starts capture; caps breathe while recording. */
const KeyCaps: React.FC<{ combo: string | null; capturing: boolean; onClick: () => void }> = ({ combo, capturing, onClick }) => (
    <button
        onClick={onClick}
        className={`sd-kbd${capturing ? ' sd-rec' : ''}`}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
        title={capturing ? 'Press a key combo — Esc cancels' : 'Click to rebind'}
    >
        {capturing ? (
            <i>Press keys…</i>
        ) : combo ? (
            formatCombo(combo).split(' + ').map((k, i) => <i key={i}>{k}</i>)
        ) : (
            <i style={{ color: 'var(--cl-faint)' }}>Not bound</i>
        )}
    </button>
);

export const KeybindSettings: React.FC<KeybindSettingsProps> = ({ keybinds }) => {
    const { binds, setBind, resetAll, resetOne, defaults, globalShortcutStatus } = keybinds;
    const globalNotice = globalShortcutNotice(globalShortcutStatus);
    const labelOf = useCallback((id: string) => ACTIONS.find(a => a.id === id)?.label ?? id, []);
    const bindingNotice = portalBindingNotice(globalShortcutStatus, labelOf);
    const coverage = globalShortcutCoverage(globalShortcutStatus);
    // Hyprland binds nothing on its own: the lines the user adds to hyprland.conf, from each shortcut's current key.
    const hyprlandLines = bindingNotice?.hyprland
        ? hyprlandBindLines(
            ACTIONS
                .filter(a => a.global && binds[a.id] && (bindingNotice.hyprlandIds.includes(a.id) || a.armedOnly))
                .map(a => ({ id: a.id, combo: binds[a.id] as string })),
            globalShortcutStatus?.appId ?? 'chat.cipherline.Cipherline',
        )
        : [];
    const [linesCopied, setLinesCopied] = useState(false);
    // A key the desktop remembers can only be changed in the desktop's own settings (KDE ignores a later one).
    const desktopKeys = globalShortcutStatus?.portal?.desktopKeys ?? {};
    const elsewhere = new Set(globalShortcutStatus?.portal?.elsewhere ?? []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent
    const canConfigureDesktop = !!(window as any).electronAPI?.configureDesktopShortcuts && !!bindingNotice && !bindingNotice.hyprland;
    const [configureFailed, setConfigureFailed] = useState(false);
    const openDesktopShortcuts = async () => {
        let ok = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        try { ok = !!(await (window as any).electronAPI?.configureDesktopShortcuts?.()); } catch { ok = false; }
        setConfigureFailed(!ok);
    };
    const copyLines = async () => {
        try {
            await writeToClipboard(hyprlandLines.join('\n'));
            setLinesCopied(true);
            setTimeout(() => setLinesCopied(false), 1800);
        } catch { /* the lines are on screen to select by hand */ }
    };
    // The category hint must not promise "works in the background" when the desktop says otherwise.
    const hintFor = (cat: { id: string; hint: string }): string => {
        if (cat.id === 'navigation') return cat.hint;
        if (coverage === 'none') return 'Only work while Cipherline is focused on this desktop (see the note above)';
        if (coverage === 'some') return `${cat.hint}, except the ones listed in the note above`;
        return cat.hint;
    };

    // Which action is currently being re-bound (capturing next keystroke)
    const [capturing, setCapturing] = useState<BindableAction | null>(null);
    const captureRef = useRef<BindableAction | null>(null);
    captureRef.current = capturing;

    // Capture next key combo (any key except plain Escape, which cancels).
    useEffect(() => {
        if (!capturing) return;

        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Modifier-only presses are ignored (user is still building the combo)
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            // Escape — plain OR modified — is handled entirely by the
            // useEscape layer below instead, which needs to be the one and
            // only place deciding: it must win over Settings' own
            // Escape-to-close (a capture-phase stack layer beneath this one
            // while `capturing`), and this window listener alone cannot
            // guarantee that ordering against it.
            if (e.key === 'Escape') return;

            const combo = eventToCombo(e);
            if (combo && captureRef.current) {
                setBind(captureRef.current, combo);
            }
            setCapturing(null);
        };

        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [capturing, setBind]);

    // Escape cancels the capture, through the shared stack, so it wins over
    // Settings' own Escape-to-close (which would otherwise also see the press
    // and close Settings out from under an in-progress recording) — the stack
    // only invokes the TOPMOST layer, and this one is pushed while
    // `capturing`, i.e. strictly after Settings' own layer.
    //
    // A held modifier makes it a legitimate bindable combo rather than a
    // cancel (matches the app's existing rule — Ctrl/Alt/Shift+Escape can be
    // bound, plain Escape cannot). That capture is done HERE, not declined
    // down to the window listener above: declining would let Settings' layer
    // beneath this one see the modified press too and close, since this
    // layer would no longer be the one stopping the event.
    useEscape((e) => {
        if (e.ctrlKey || e.altKey || e.shiftKey) {
            const combo = eventToCombo(e);
            if (combo && captureRef.current) setBind(captureRef.current, combo);
        }
        setCapturing(null);
    }, !!capturing);

    const startCapture = useCallback((action: BindableAction) => {
        setCapturing(action);
    }, []);

    const clearBind = useCallback((action: BindableAction) => {
        setBind(action, null);
    }, [setBind]);

    return (
        <>
            {globalNotice && (
                <div className="sd-card" role="status" data-testid="global-shortcuts-notice">
                    <div className="sd-row" style={{ padding: 0, border: 'none' }}>
                        <div className="sd-rl">
                            <b>System-wide shortcuts are off</b>
                            <span>{globalNotice}</span>
                        </div>
                    </div>
                </div>
            )}
            {bindingNotice && (
                <div className="sd-card" role="status" data-testid="global-shortcuts-binding-notice">
                    <div className="sd-row" style={{ padding: 0, border: 'none' }}>
                        <div className="sd-rl">
                            <b>{bindingNotice.title}</b>
                            <span>{bindingNotice.text}</span>
                        </div>
                    </div>
                    {canConfigureDesktop && (
                        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }} data-testid="desktop-shortcut-settings">
                            <ClButton size="sm" variant="ghost" onClick={openDesktopShortcuts}>
                                <Keyboard size={13} /> Open desktop shortcut settings
                            </ClButton>
                            {configureFailed && (
                                <span className="sd-sub">Your desktop did not open them. Look for Cipherline in its System Settings, under Keyboard › Shortcuts.</span>
                            )}
                        </div>
                    )}
                    {hyprlandLines.length > 0 && (
                        <div style={{ marginTop: 10 }} data-testid="hyprland-bind-lines">
                            <p className="sd-sub">
                                Add these to your hyprland.conf, then run <code>hyprctl reload</code>. Each line uses the key shown
                                for that shortcut below; change a key here and the lines update.
                            </p>
                            <pre style={{ margin: '6px 0', padding: '8px 10px', overflowX: 'auto', fontSize: 12, userSelect: 'text' }}>{hyprlandLines.join('\n')}</pre>
                            <ClButton size="sm" variant="ghost" onClick={copyLines}>
                                {linesCopied ? <Check size={13} /> : <Copy size={13} />} {linesCopied ? 'Copied' : 'Copy lines'}
                            </ClButton>
                        </div>
                    )}
                </div>
            )}
            {ACTION_CATEGORIES.filter(cat => cat.id !== 'annotation').map(cat => {
                // Owner, 2026-11-08: the drawing-request keys sit with the other
                // call controls (both work in the background) instead of in a
                // folded-away section of their own. Their descriptions say they
                // only fire while someone is asking to draw.
                const items = ACTIONS.filter(a => a.category === cat.id
                    || (cat.id === 'controls' && a.category === 'annotation'));
                if (items.length === 0) return null;
                const rows = items.map(action => {
                    // '' is an explicit "cleared" (persisted so it
                    // survives a restart) and reads as unbound here.
                    const combo = binds[action.id] || null;
                    const isCapturing = capturing === action.id;
                    const isDefault = combo === (defaults[action.id] || null);

                    return (
                        <div key={action.id} className="sd-row">
                            <div className="sd-rl">
                                <b>{action.label}</b>
                                <span>{action.description}</span>
                                {elsewhere.has(action.id) && desktopKeys[action.id] && (
                                    <span data-testid="desktop-key-hint" style={{ color: 'var(--cl-glow)' }}>
                                        System-wide your desktop uses {desktopKeys[action.id]} for this
                                    </span>
                                )}
                            </div>
                            <div className="sd-rc">
                                {!isDefault && !isCapturing && (
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => resetOne(action.id)}
                                        tooltip="Reset to default"
                                    >
                                        <RotateCcw size={12} />
                                    </ClButton>
                                )}
                                {combo && !isCapturing && (
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => clearBind(action.id)}
                                        tooltip="Remove shortcut"
                                    >
                                        <Trash2 size={12} />
                                    </ClButton>
                                )}
                                <KeyCaps
                                    combo={combo}
                                    capturing={isCapturing}
                                    onClick={() => startCapture(action.id)}
                                />
                            </div>
                        </div>
                    );
                });
                return (
                    <div key={cat.id} className="sd-card">
                        <h3>{cat.label}</h3>
                        <p className="sd-sub">{hintFor(cat)}</p>
                        {rows}
                    </div>
                );
            })}

            <div className="sd-card">
                <div className="sd-row" style={{ padding: 0, border: 'none' }}>
                    <div className="sd-rl">
                        <b>Defaults not feeling right?</b>
                        <span>
                            {coverage === 'none' || coverage === 'some'
                                ? 'See the note above for which call controls work system-wide on this desktop. '
                                : 'Call controls work system-wide, even while another app is focused. '}
                            Navigation shortcuts only fire when Cipherline is in the foreground. Esc cancels a capture. Press ? anywhere you are not typing to see them all.
                        </span>
                    </div>
                    <div className="sd-rc">
                        <ClButton size="sm" variant="ghost" onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}>
                            <Keyboard size={13} /> Cheat sheet
                        </ClButton>
                        <ClButton size="sm" variant="ghost" onClick={resetAll}>
                            <RotateCcw size={13} /> Reset all
                        </ClButton>
                    </div>
                </div>
            </div>
        </>
    );
};
