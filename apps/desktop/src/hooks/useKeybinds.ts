import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ── Bindable actions ──────────────────────────────────────────────────────────

export type BindableAction =
    | 'toggle-mute'
    | 'toggle-deafen'
    | 'toggle-camera'
    | 'toggle-screenshare'
    | 'leave-call'
    | 'quick-screenshare'
    | 'lock-screen'
    | 'open-settings'
    | 'close-panel'
    | 'focus-chat-input'
    | 'toggle-gif-picker'
    | 'toggle-emoji-picker';

export type ActionCategory = 'controls' | 'navigation';

export interface ActionMeta {
    id: BindableAction;
    label: string;
    category: ActionCategory;
    description: string;
    /** If true, this shortcut fires even when Cipherline is not focused (Electron globalShortcut). */
    global: boolean;
}

export const ACTIONS: ActionMeta[] = [
    // Controls — global shortcuts (work even when Cipherline is not focused)
    { id: 'toggle-mute',        label: 'Mute / Unmute',            category: 'controls', description: 'Toggle your microphone',                        global: true },
    { id: 'toggle-deafen',      label: 'Deafen / Undeafen',       category: 'controls', description: 'Toggle deafen (mutes audio from others)',       global: true },
    { id: 'toggle-camera',      label: 'Camera On / Off',          category: 'controls', description: 'Toggle your camera',                            global: true },
    { id: 'toggle-screenshare', label: 'Screen Share',             category: 'controls', description: 'Open the screen share picker',                  global: true },
    { id: 'leave-call',         label: 'Leave Call',               category: 'controls', description: 'Leave the current call',                        global: true },
    { id: 'quick-screenshare',  label: 'Quick Screen Share',       category: 'controls', description: 'Share the active window with audio (default quality)', global: true },
    { id: 'lock-screen',       label: 'Lock Cipherline',          category: 'controls', description: 'Instantly lock the app (requires your PIN to reopen)', global: true },
    // Navigation — local shortcuts (only when Cipherline is focused)
    { id: 'open-settings',      label: 'Open Settings',            category: 'navigation', description: 'Open the settings panel',                     global: false },
    { id: 'close-panel',        label: 'Close / Go Back',          category: 'navigation', description: 'Close the current modal or panel (Escape)',   global: false },
    { id: 'focus-chat-input',   label: 'Focus Chat Input',         category: 'navigation', description: 'Focus the message input box',                 global: false },
    { id: 'toggle-gif-picker',  label: 'GIF Picker',               category: 'navigation', description: 'Open or close the GIF picker',               global: false },
    { id: 'toggle-emoji-picker', label: 'Emoji Picker',            category: 'navigation', description: 'Open or close the emoji picker',             global: false },
];

export const ACTION_CATEGORIES: { id: ActionCategory; label: string; hint: string }[] = [
    { id: 'controls',   label: 'Controls',   hint: 'Work even when Cipherline is in the background' },
    { id: 'navigation', label: 'Navigation',  hint: 'Only work when Cipherline is focused' },
];

/** Set of action IDs that should be registered as Electron global shortcuts. */
export const GLOBAL_ACTIONS = new Set<BindableAction>(
    ACTIONS.filter(a => a.global).map(a => a.id),
);

// ── Key combo representation ──────────────────────────────────────────────────

/** A key combo is stored as a sorted, lowercase string like "ctrl+shift+m" */
export type KeyCombo = string;

export type KeybindMap = Partial<Record<BindableAction, KeyCombo>>;

const STORAGE_KEY = 'cipherline_keybinds';

const DEFAULT_KEYBINDS: KeybindMap = {
    'toggle-mute':        'ctrl+shift+m',
    'toggle-deafen':      'ctrl+shift+d',
    'toggle-camera':      'ctrl+shift+v',
    'toggle-screenshare': 'ctrl+shift+s',
    'leave-call':         'ctrl+shift+h',
    'quick-screenshare':  'ctrl+shift+q',
    'lock-screen':        'ctrl+shift+l',
    'open-settings':      'ctrl+,',
    'close-panel':        'escape',
    'focus-chat-input':   'ctrl+l',
    'toggle-gif-picker':  'ctrl+shift+g',
    'toggle-emoji-picker': 'ctrl+.',
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Convert a raw KeyboardEvent into a normalised combo string. */
export function eventToCombo(e: KeyboardEvent): KeyCombo {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey)              parts.push('alt');
    if (e.shiftKey)            parts.push('shift');

    // Normalise the actual key
    let key = e.key.toLowerCase();
    // Don't double-add modifier-only presses
    if (['control', 'meta', 'alt', 'shift'].includes(key)) return parts.join('+');
    // Normalise common aliases
    if (key === ' ') key = 'space';
    if (key === ',') key = ',';
    parts.push(key);
    return parts.join('+');
}

/** Pretty-print a combo for display. */
export function formatCombo(combo: KeyCombo): string {
    if (!combo) return 'None';
    return combo
        .split('+')
        .map(part => {
            switch (part) {
                case 'ctrl':  return navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
                case 'alt':   return navigator.platform.includes('Mac') ? '⌥' : 'Alt';
                case 'shift': return 'Shift';
                case 'escape': return 'Esc';
                case 'space': return 'Space';
                case 'arrowup': return '↑';
                case 'arrowdown': return '↓';
                case 'arrowleft': return '←';
                case 'arrowright': return '→';
                default:      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
            }
        })
        .join(' + ');
}

/**
 * Convert our internal combo string to an Electron accelerator string.
 * e.g. "ctrl+shift+m" → "CmdOrCtrl+Shift+M"
 */
export function comboToAccelerator(combo: KeyCombo): string {
    return combo
        .split('+')
        .map(part => {
            switch (part) {
                case 'ctrl':  return 'CmdOrCtrl';
                case 'alt':   return 'Alt';
                case 'shift': return 'Shift';
                case 'escape': return 'Escape';
                case 'space': return 'Space';
                case 'arrowup': return 'Up';
                case 'arrowdown': return 'Down';
                case 'arrowleft': return 'Left';
                case 'arrowright': return 'Right';
                case ',':     return ',';
                case '.':     return '.';
                default:      return part.toUpperCase();
            }
        })
        .join('+');
}

// ── Hook ──────────────────────────────────────────────────────────────────────

function loadKeybinds(): KeybindMap {
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_KEYBINDS };
        return { ...DEFAULT_KEYBINDS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_KEYBINDS };
    }
}

export function useKeybinds() {
    const [binds, setBinds] = useState<KeybindMap>(loadKeybinds);
    // Global-category actions whose OS-level registration failed (e.g.
    // unsupported under Wayland, or the combo is already grabbed by another
    // app). useGlobalKeybindListener falls back to a focused-window-only
    // local listener for these instead of going silent.
    const [failedGlobalActions, setFailedGlobalActions] = useState<Set<BindableAction>>(new Set());

    // Persist to localStorage
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(binds)); } catch {}
    }, [binds]);

    // Sync global shortcuts to the Electron main process whenever binds change.
    // Sends a map of { accelerator: actionId } for all global-category actions.
    useEffect(() => {
        const api = (window as any).electronAPI;
        if (!api?.syncGlobalShortcuts) return;

        const globalMap: Record<string, string> = {};
        for (const [action, combo] of Object.entries(binds)) {
            if (combo && GLOBAL_ACTIONS.has(action as BindableAction)) {
                globalMap[comboToAccelerator(combo)] = action;
            }
        }
        api.syncGlobalShortcuts(globalMap).then((result: { failed?: string[] } | void) => {
            setFailedGlobalActions(new Set((result?.failed ?? []) as BindableAction[]));
        }).catch((e: any) => {
            console.warn('[keybinds] Failed to sync global shortcuts:', e);
            // Unknown state — assume every global action needs the local fallback.
            setFailedGlobalActions(new Set(Object.values(globalMap) as BindableAction[]));
        });
    }, [binds]);

    const setBind = useCallback((action: BindableAction, combo: KeyCombo | null) => {
        setBinds(prev => {
            const next = { ...prev };
            if (combo === null || combo === '') {
                delete next[action];
            } else {
                // Remove the combo from any other action that currently uses it
                for (const key of Object.keys(next) as BindableAction[]) {
                    if (next[key] === combo) delete next[key];
                }
                next[action] = combo;
            }
            return next;
        });
    }, []);

    const resetAll = useCallback(() => {
        setBinds({ ...DEFAULT_KEYBINDS });
    }, []);

    const resetOne = useCallback((action: BindableAction) => {
        setBinds(prev => ({
            ...prev,
            [action]: DEFAULT_KEYBINDS[action] ?? undefined,
        }));
    }, []);

    /** Reverse lookup: combo → action */
    const comboToAction = useMemo(() => {
        const map = new Map<KeyCombo, BindableAction>();
        for (const [action, combo] of Object.entries(binds)) {
            if (combo) map.set(combo, action as BindableAction);
        }
        return map;
    }, [binds]);

    return useMemo(() => ({
        binds,
        setBind,
        resetAll,
        resetOne,
        comboToAction,
        defaults: DEFAULT_KEYBINDS,
        failedGlobalActions,
    }), [binds, setBind, resetAll, resetOne, comboToAction, failedGlobalActions]);
}

export type KeybindHook = ReturnType<typeof useKeybinds>;
