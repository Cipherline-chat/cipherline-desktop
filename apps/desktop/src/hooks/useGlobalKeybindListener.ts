import { useCallback, useEffect, useRef } from 'react';
import { eventToCombo, GLOBAL_ACTIONS, type BindableAction, type KeybindHook } from './useKeybinds';
import { isKeyComboClaimed } from '../utils/keyClaims';
import { isScreenLockEngaged } from '../utils/screenLockEngaged';

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
    /**
     * Pass these two ONLY while a drawing request is waiting (Dashboard does).
     * An action with no handler is ignored by both tiers before anything else
     * happens - in particular Tier 2 returns before preventDefault, so the
     * combo reaches the focused app untouched the rest of the time.
     */
    'approve-annotation-request'?: () => void;
    'decline-annotation-request'?: () => void;
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
 *
 * LOCKED: while the Screen Lock is up NO action fires, from either tier
 * (`fire` is the one choke point, plus both tiers return before consuming the
 * key). Hotkeys act on the app behind the lock — leave the call, share the
 * screen, turn the camera on, open settings, focus the composer — and the lock
 * exists so a person at the machine cannot do that. Mute/deafen are blocked
 * too: a toggle can OPEN the mic of an unattended machine. The one audio
 * control that stays live is push-to-talk (SidebarConference's own hold-to-talk
 * listener, not this dispatcher): it needs the key physically held, so someone
 * is present on purpose, and it only ever opens the mic of a call that is
 * already running — it reads nothing and changes nothing in the app.
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
        if (isScreenLockEngaged()) return;
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const api = (window as any).electronAPI;
        if (!api?.onGlobalShortcut) return;

        return api.onGlobalShortcut((actionId: string) => {
            // A surface that owns the keyboard (the Home game, utils/keyClaims)
            // has taken this action's combo: the OS-level shortcut must not
            // fire underneath it either.
            for (const [combo, action] of comboMapRef.current) {
                if (action === actionId && isKeyComboClaimed(combo)) return;
            }
            fire(actionId as BindableAction);
        });
    }, [fire]);

    // ── Tier 2: Local keydown listener (only when focused) ─────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Screen Lock up: the press is not a hotkey (and is left alone).
            if (isScreenLockEngaged()) return;
            // Modifier-only press — ignore
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            const combo = eventToCombo(e);
            if (!combo) return;

            const action = comboMapRef.current.get(combo);
            if (!action) return;
            // Claimed by an open surface (the Home game plays on Space; see
            // utils/keyClaims): the press is that surface's, not a hotkey.
            if (isKeyComboClaimed(combo)) return;

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
