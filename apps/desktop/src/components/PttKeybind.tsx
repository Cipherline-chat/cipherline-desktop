import React, { useEffect, useRef, useState } from 'react';
import { formatCombo } from '../hooks/useKeybinds';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import { createComboRecorder, setPttUiState } from '../utils/pushToTalk';

/**
 * The push-to-talk key field. ONE component for both places the key is edited
 * (Settings -> Voice & Video and Settings -> Keybinds): both pass the same voice
 * setting's value/setter, so there is a single source of truth and they cannot
 * disagree.
 *
 * A bare modifier is a valid key (the default is Alt): it is committed when the
 * modifier is RELEASED with nothing else pressed, so holding Ctrl to start
 * Ctrl+K does not bind plain Ctrl. Esc cancels (through the shared escape stack,
 * so it wins over Settings' own Escape-to-close).
 */
export const PttKeybind: React.FC<{
    value: string | null;
    onSet: (v: string | null) => void;
    /** What the key does, for screen readers: 'push to talk' (default) or 'push to mute'. */
    what?: string;
    /** Bump (or mount with > 0) to open key capture right away, e.g. when push to talk is switched on with no key. */
    captureSignal?: number;
}> = ({ value, onSet, what = 'push to talk', captureSignal = 0 }) => {
    const [recording, setRecording] = useState(false);
    useEffect(() => { if (captureSignal > 0) setRecording(true); }, [captureSignal]);
    const onSetRef = useRef(onSet);
    useEffect(() => { onSetRef.current = onSet; }, [onSet]);

    useEffect(() => {
        if (!recording) return;
        // The key being recorded must not also open the mic of a call in progress.
        setPttUiState({ recording: true });
        const recorder = createComboRecorder((combo) => { onSetRef.current(combo); setRecording(false); });
        const onDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Escape (any modifiers) is handled entirely by the useEscape layer below:
            // Escape is never itself a bindable push-to-talk key.
            if (e.key === 'Escape') return;
            recorder.keydown(e);
        };
        const onUp = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            recorder.keyup(e);
        };
        window.addEventListener('keydown', onDown, { capture: true });
        window.addEventListener('keyup', onUp, { capture: true });
        return () => {
            window.removeEventListener('keydown', onDown, { capture: true });
            window.removeEventListener('keyup', onUp, { capture: true });
            setPttUiState({ recording: false });
        };
    }, [recording]);

    useEscape(() => setRecording(false), recording);

    return (
        <div className="flex items-center gap-1.5">
            {value && !recording && (
                <ClButton
                    icon
                    variant="ghost"
                    size="sm"
                    onClick={() => onSet(null)}
                    tooltip="Clear keybind"
                >
                    ×
                </ClButton>
            )}
            <button
                type="button"
                onClick={() => setRecording(r => !r)}
                className={`sd-kbd vv-kbd${recording ? ' sd-rec' : ''}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                title={recording ? 'Press a key or combo, then let go. Esc cancels' : 'Click to rebind'}
                aria-label={recording ? `Recording ${what} key, press a key or combo, Escape cancels` : value ? `${what} key: ${formatCombo(value)}. Click to change` : `Set ${what} key`}
            >
                {recording ? (
                    <i>Press keys…</i>
                ) : value ? (
                    formatCombo(value).split(' + ').map((k, i) => <i key={i}>{k}</i>)
                ) : (
                    <i className="vv-kbd-empty">Set keybind</i>
                )}
            </button>
        </div>
    );
};
