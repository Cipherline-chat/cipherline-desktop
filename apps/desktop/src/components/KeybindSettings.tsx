import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import {
    ACTIONS, ACTION_CATEGORIES,
    eventToCombo, formatCombo,
    type BindableAction, type KeybindHook,
} from '../hooks/useKeybinds';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';

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
    const { binds, setBind, resetAll, resetOne, defaults } = keybinds;

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
            {ACTION_CATEGORIES.map(cat => {
                const items = ACTIONS.filter(a => a.category === cat.id);
                if (items.length === 0) return null;
                return (
                    <div key={cat.id} className="sd-card">
                        <h3>{cat.label}</h3>
                        <p className="sd-sub">{cat.hint}</p>
                        {items.map(action => {
                            const combo = binds[action.id] ?? null;
                            const isCapturing = capturing === action.id;
                            const isDefault = combo === defaults[action.id];

                            return (
                                <div key={action.id} className="sd-row">
                                    <div className="sd-rl">
                                        <b>{action.label}</b>
                                        <span>{action.description}</span>
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
                        })}
                    </div>
                );
            })}

            <div className="sd-card">
                <div className="sd-row" style={{ padding: 0, border: 'none' }}>
                    <div className="sd-rl">
                        <b>Defaults not feeling right?</b>
                        <span>
                            Call controls work system-wide, even while another app is focused. Navigation
                            shortcuts only fire when Cipherline is in the foreground. Esc cancels a capture.
                        </span>
                    </div>
                    <div className="sd-rc">
                        <ClButton size="sm" variant="ghost" onClick={resetAll}>
                            <RotateCcw size={13} /> Reset all
                        </ClButton>
                    </div>
                </div>
            </div>
        </>
    );
};
