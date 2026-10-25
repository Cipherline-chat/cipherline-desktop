import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
    | 'toggle-emoji-picker'
    | 'approve-annotation-request'
    | 'decline-annotation-request';

export type ActionCategory = 'controls' | 'annotation' | 'navigation';

export interface ActionMeta {
    id: BindableAction;
    label: string;
    category: ActionCategory;
    description: string;
    /** If true, this shortcut fires even when Cipherline is not focused (Electron globalShortcut). */
    global: boolean;
    /**
     * Only registered with the OS while the app says it is ARMED (see
     * buildGlobalShortcutMap). For a shortcut that is only meaningful for a
     * moment - answering a request to draw - so the combo is not taken from
     * every other app the rest of the time.
     */
    armedOnly?: boolean;
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
    // Drawing requests — global, but only registered while someone is waiting on an answer
    { id: 'approve-annotation-request', label: 'Allow drawing request',   category: 'annotation', description: 'Allow the oldest waiting request to draw on your screen or video', global: true, armedOnly: true },
    { id: 'decline-annotation-request', label: 'Decline drawing request', category: 'annotation', description: 'Decline the oldest waiting request to draw',                        global: true, armedOnly: true },
    // Navigation — local shortcuts (only when Cipherline is focused)
    { id: 'open-settings',      label: 'Open Settings',            category: 'navigation', description: 'Open the settings panel',                     global: false },
    { id: 'close-panel',        label: 'Close / Go Back',          category: 'navigation', description: 'Close the current modal or panel (Escape)',   global: false },
    { id: 'focus-chat-input',   label: 'Focus Chat Input',         category: 'navigation', description: 'Focus the message input box',                 global: false },
    { id: 'toggle-gif-picker',  label: 'GIF Picker',               category: 'navigation', description: 'Open or close the GIF picker',               global: false },
    { id: 'toggle-emoji-picker', label: 'Emoji Picker',            category: 'navigation', description: 'Open or close the emoji picker',             global: false },
];

export const ACTION_CATEGORIES: { id: ActionCategory; label: string; hint: string }[] = [
    { id: 'controls',   label: 'Controls',   hint: 'Work even when Cipherline is in the background' },
    { id: 'annotation', label: 'Drawing requests', hint: 'Work even when Cipherline is in the background, but only while someone is asking to draw on your share. The keys are left alone the rest of the time.' },
    { id: 'navigation', label: 'Navigation',  hint: 'Only work when Cipherline is focused' },
];

/** Set of action IDs that should be registered as Electron global shortcuts. */
export const GLOBAL_ACTIONS = new Set<BindableAction>(
    ACTIONS.filter(a => a.global).map(a => a.id),
);

/** Global actions that are registered only while armed. */
export const ARMED_ONLY_ACTIONS = new Set<BindableAction>(
    ACTIONS.filter(a => a.global && a.armedOnly).map(a => a.id),
);

/** The two drawing-request actions, armed together while a request is waiting. */
export const ANNOTATION_REQUEST_ACTIONS: readonly BindableAction[] = ['approve-annotation-request', 'decline-annotation-request'];

// ── Key combo representation ──────────────────────────────────────────────────

/** A key combo is stored as a sorted, lowercase string like "ctrl+shift+m" */
export type KeyCombo = string;

export type KeybindMap = Partial<Record<BindableAction, KeyCombo>>;

const STORAGE_KEY = 'cipherline_keybinds';

const DEFAULT_KEYBINDS: KeybindMap = {
    'toggle-mute':        'ctrl+shift+m',
    'toggle-deafen':      'ctrl+shift+d',
    'toggle-camera':      'ctrl+shift+v',
    // Not Ctrl+Shift+S: as a GLOBAL shortcut it took "Save As" away from every
    // other app (and AMD's overlay) while Cipherline ran. See migrateKeybinds.
    'toggle-screenshare': 'ctrl+shift+f9',
    'leave-call':         'ctrl+shift+h',
    'quick-screenshare':  'ctrl+shift+q',
    'lock-screen':        'ctrl+shift+l',
    'open-settings':      'ctrl+,',
    'close-panel':        'escape',
    'focus-chat-input':   'ctrl+l',
    'toggle-gif-picker':  'ctrl+shift+g',
    'toggle-emoji-picker': 'ctrl+.',
    // Ctrl+Shift like every other global default (games rarely bind three-key
    // chords; plain letters and F-keys are exactly what they DO bind), Y for
    // "yes", and clear of the combos already taken above and of the usual
    // overlay hotkeys (Steam Shift+Tab, GeForce Alt+Z / Alt+F*, AMD
    // Ctrl+Shift+S/R/E/O/X, Xbox Game Bar Win+*). It is also only registered
    // while a request is actually waiting. Decline is unbound by default:
    // a second reserved chord costs more than letting a request lapse does.
    'approve-annotation-request': 'ctrl+shift+y',
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

/** Explicitly unbound. Persisted as '' (not by deleting the key) so a cleared
 *  binding survives a restart instead of the default merging back in. */
export const UNBOUND: KeyCombo = '';

const KNOWN_ACTIONS = new Set<string>(ACTIONS.map(a => a.id));

/**
 * Saved binds over the defaults. A saved key - including an explicit UNBOUND -
 * always wins. A default only fills an action the user has never saved, and
 * never onto a combo the user already uses for something else: that is how a
 * newly added action's default (an existing user's first launch after it
 * ships) is kept from silently colliding with a combo they chose themselves.
 */
export function mergeKeybinds(saved: unknown, defaults: KeybindMap = DEFAULT_KEYBINDS): KeybindMap {
    const out: KeybindMap = {};
    const taken = new Set<string>();
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [action, combo] of Object.entries(saved as Record<string, unknown>)) {
            if (!KNOWN_ACTIONS.has(action) || typeof combo !== 'string') continue;
            out[action as BindableAction] = combo;
            if (combo) taken.add(combo);
        }
    }
    for (const [action, combo] of Object.entries(defaults) as [BindableAction, KeyCombo | undefined][]) {
        if (action in out || !combo || taken.has(combo)) continue;
        out[action] = combo;
        taken.add(combo);
    }
    return out;
}

const MIGRATION_KEY = 'cipherline_keybinds_migrated_v1';

/**
 * One-time fixes to SAVED binds. The whole map is persisted, so a changed
 * default never reaches an existing user on its own. v1: Screen Share's old
 * default Ctrl+Shift+S (a global shortcut that swallowed "Save As" in every
 * app) moves to the new default, unless that combo is already in use. Runs
 * once per account; a user who re-binds Ctrl+Shift+S afterwards keeps it.
 */
export function migrateKeybinds(saved: unknown, alreadyMigrated: boolean): unknown {
    if (alreadyMigrated || !saved || typeof saved !== 'object' || Array.isArray(saved)) return saved;
    const out = { ...(saved as Record<string, unknown>) };
    const next = DEFAULT_KEYBINDS['toggle-screenshare']!;
    if (out['toggle-screenshare'] === 'ctrl+shift+s') {
        const taken = Object.entries(out).some(([a, c]) => a !== 'toggle-screenshare' && c === next);
        out['toggle-screenshare'] = taken ? UNBOUND : next;
    }
    return out;
}

function loadKeybinds(): KeybindMap {
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_KEYBINDS };
        const migrated = secureLocalStore.getItem(MIGRATION_KEY) === '1';
        const merged = mergeKeybinds(migrateKeybinds(JSON.parse(raw), migrated));
        if (!migrated) {
            try { secureLocalStore.setItem(MIGRATION_KEY, '1'); } catch { /* retried next launch; the fix is idempotent for the old default */ }
        }
        return merged;
    } catch {
        return { ...DEFAULT_KEYBINDS };
    }
}

/**
 * The { accelerator: actionId } map handed to the main process. Every bound
 * global action, except that an `armedOnly` action is included only while it
 * is in `armed` - which is what registers it when the first request arrives
 * and unregisters it when none remain (the main process replaces its whole
 * registration set on every sync).
 */
export function buildGlobalShortcutMap(binds: KeybindMap, armed: ReadonlySet<BindableAction>): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [action, combo] of Object.entries(binds) as [BindableAction, KeyCombo | undefined][]) {
        if (!combo || !GLOBAL_ACTIONS.has(action)) continue;
        if (ARMED_ONLY_ACTIONS.has(action) && !armed.has(action)) continue;
        map[comboToAccelerator(combo)] = action;
    }
    return map;
}

/**
 * Which drawing-request actions to arm. Nothing unless a request is waiting,
 * an action must actually be bound, and never a combo that is the user's
 * push-to-talk key: an OS-level registration would swallow that key before the
 * window's own push-to-talk listener ever saw it.
 */
export function armedAnnotationActions(
    binds: KeybindMap,
    pending: boolean,
    pushToTalkKey?: string | null,
): Set<BindableAction> {
    const out = new Set<BindableAction>();
    if (!pending) return out;
    for (const action of ANNOTATION_REQUEST_ACTIONS) {
        const combo = binds[action];
        if (!combo) continue;
        if (pushToTalkKey && combo === pushToTalkKey) continue;
        out.add(action);
    }
    return out;
}

export interface UseKeybindsOptions {
    /** A drawing request is waiting on us (arms the drawing-request actions). */
    annotationRequestPending?: boolean;
    /** The push-to-talk combo while push-to-talk is on, else null. */
    pushToTalkKey?: string | null;
}

export function useKeybinds(opts: UseKeybindsOptions = {}) {
    const [binds, setBinds] = useState<KeybindMap>(loadKeybinds);
    const pending = !!opts.annotationRequestPending;
    const pttKey = opts.pushToTalkKey ?? null;
    const armed = useMemo(() => armedAnnotationActions(binds, pending, pttKey), [binds, pending, pttKey]);
    // Global-category actions whose OS-level registration failed (e.g.
    // unsupported under Wayland, or the combo is already grabbed by another
    // app). useGlobalKeybindListener falls back to a focused-window-only
    // local listener for these instead of going silent.
    const [failedGlobalActions, setFailedGlobalActions] = useState<Set<BindableAction>>(new Set());

    // Persist to localStorage
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(binds)); } catch { /* persisting a UI preference is best-effort; a failed write must not break the UI */ }
    }, [binds]);

    // Sync global shortcuts to the Electron main process whenever binds change.
    // Sends a map of { accelerator: actionId } for all global-category actions.
    // Keyed on the armed set's CONTENT, so arming re-syncs exactly when what
    // is armed changes (first request arrives / last one goes), and only then.
    const armedKey = [...armed].sort().join(',');
    // Main answers syncs asynchronously (its KDE half awaits D-Bus), and arming
    // makes back-to-back syncs normal: only the latest reply may set state.
    const syncSeqRef = useRef(0);
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const api = (window as any).electronAPI;
        if (!api?.syncGlobalShortcuts) return;

        const armedNow = new Set((armedKey ? armedKey.split(',') : []) as BindableAction[]);
        const globalMap = buildGlobalShortcutMap(binds, armedNow);
        const seq = ++syncSeqRef.current;
        api.syncGlobalShortcuts(globalMap).then((result: { failed?: string[] } | void) => {
            if (seq !== syncSeqRef.current) return;
            setFailedGlobalActions(new Set((result?.failed ?? []) as BindableAction[]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
        }).catch((e: any) => {
            if (seq !== syncSeqRef.current) return;
            console.warn('[keybinds] Failed to sync global shortcuts:', e);
            // Unknown state — assume every global action needs the local fallback.
            setFailedGlobalActions(new Set(Object.values(globalMap) as BindableAction[]));
        });
    }, [binds, armedKey]);

    const setBind = useCallback((action: BindableAction, combo: KeyCombo | null) => {
        setBinds(prev => {
            const next = { ...prev };
            if (combo === null || combo === '') {
                next[action] = UNBOUND;
            } else {
                // Move the combo off any other action that currently uses it
                // (one combo, one action). That action is now explicitly
                // unbound, so its default cannot merge back onto the same
                // combo after a restart.
                for (const key of Object.keys(next) as BindableAction[]) {
                    if (key !== action && next[key] === combo) next[key] = UNBOUND;
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
        setBinds(prev => {
            const next = { ...prev };
            const combo = DEFAULT_KEYBINDS[action];
            if (!combo) { delete next[action]; return next; }
            // Same one-combo-one-action rule as setBind: the default may have
            // been reassigned to another action since.
            for (const key of Object.keys(next) as BindableAction[]) {
                if (key !== action && next[key] === combo) next[key] = UNBOUND;
            }
            next[action] = combo;
            return next;
        });
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
        /** Armed-only actions currently registered (see armedAnnotationActions). */
        armed,
    }), [binds, setBind, resetAll, resetOne, comboToAction, failedGlobalActions, armed]);
}

export type KeybindHook = ReturnType<typeof useKeybinds>;
