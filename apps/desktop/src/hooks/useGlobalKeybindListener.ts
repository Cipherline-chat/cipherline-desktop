import { useCallback, useEffect, useRef } from 'react';
import { eventToCombo, GLOBAL_ACTIONS, type BindableAction, type KeybindHook } from './useKeybinds';

export interface KeybindActionHandlers {
    'toggle-mute'?:        () => void;
    'toggle-deafen'?:      () => void;
    'toggle-camera'?:      () => void;
    'toggle-screenshare'?: () => void;
    'leave-call'?:         () => void;
    'quick-screenshare'?:  () => void;
    'lock-screen'?:        () => void;
    'open-settings'?:      () => void;
    'close-panel'?:        () => void;
    'focus-chat-input'?:   () => void;
    'toggle-gif-picker'?:  () => void;
    'toggle-emoji-picker'?: () => void;
}

/** Two physical keypresses of the same action within this window count as one —
 *  wide enough to collapse a genuine double-delivery (Tier 1 + Tier 2 both
 *  catching the same press), narrow enough that an intentional fast double-tap
 *  still gets through. */
const DEDUP_MS = 400;

/**
 * Two-tier keybind listener — BOTH tiers always listen for every action, and
 * a shared dedup window collapses a double-delivery into one dispatch:
 *
 * 1. **Global shortcuts** — Electron's `globalShortcut` API, meant to fire
 *    even when Cipherline isn't focused. The main process sends
 *    `global-shortcut-fired` events via IPC; we listen here and dispatch.
 *
 * 2. **Local keydown** — a standard `keydown` listener that only fires when
 *    the window is focused.
 *
 * Earlier this only ran Tier 2 for actions whose Tier 1 registration had
 * reported failure (`globalShortcut.register()` returning false). That
 * doesn't actually cover the failure mode seen in practice on Linux: some
 * Wayland compositors have Electron report a SUCCESSFUL registration that
 * then never fires — there's no reliable signal to detect that from the
 * registration call alone. So instead of trying to pick a winner, both tiers
 * just always run; the dedup window makes it safe. Global (`controls`)
 * actions bypass the "skip while typing" guard that navigation actions get,
 * since they're meant to work regardless of focus/input state — including
 * while typing a message.
 */
export function useGlobalKeybindListener(
    keybinds: KeybindHook,
    handlers: KeybindActionHandlers,
) {
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    const comboMapRef = useRef(keybinds.comboToAction);
    comboMapRef.current = keybinds.comboToAction;

    const lastFiredAtRef = useRef<Map<BindableAction, number>>(new Map());

    const fire = useCallback((action: BindableAction) => {
        const handler = handlersRef.current[action];
        if (!handler) return;
        const now = Date.now();
        const last = lastFiredAtRef.current.get(action) ?? 0;
        if (now - last < DEDUP_MS) return; // duplicate delivery of the same physical press
        lastFiredAtRef.current.set(action, now);
        handler();
    }, []);

    // ── Tier 1: Electron global shortcut events ─────────────────────────────
    useEffect(() => {
        const api = (window as any).electronAPI;
        if (!api?.onGlobalShortcut) return;

        return api.onGlobalShortcut((actionId: string) => fire(actionId as BindableAction));
    }, [fire]);

    // ── Tier 2: Local keydown listener (only when focused) ─────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Modifier-only press — ignore
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            const combo = eventToCombo(e);
            if (!combo) return;

            const action = comboMapRef.current.get(combo);
            if (!action) return;

            // Navigation actions don't fire while typing (except close-panel /
            // Escape). Global (controls) actions skip this guard — muting or
            // locking while composing a message should still work.
            if (!GLOBAL_ACTIONS.has(action)) {
                const tag = (e.target as HTMLElement)?.tagName;
                const editable = (e.target as HTMLElement)?.isContentEditable;
                const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || editable;
                if (isInput && action !== 'close-panel') return;
            }

            if (!handlersRef.current[action]) return;
            e.preventDefault();
            e.stopPropagation();
            fire(action);
        };

        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [fire]);
}
