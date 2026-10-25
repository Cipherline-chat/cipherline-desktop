/**
 * The keyboard shortcuts cheat sheet (components/ShortcutsSheet.tsx): when `?`
 * opens it, and what it lists.
 *
 * Pure and DOM-light so the interesting rules are testable:
 *   - `?` opens it only when you are NOT typing: never inside a text field, a
 *     content-editable, a select, or anything with a text-entry ARIA role, and
 *     never with Ctrl/Cmd/Alt held (those are other shortcuts) or on key repeat.
 *   - What it lists is read from the live keybind map, so a rebound key shows
 *     the new combo and a cleared one shows "Not bound". Nothing is hard-coded
 *     that Settings -> Keybinds can change; the fixed rows are the keys that
 *     are not configurable (Enter, Esc...).
 */
import { ACTIONS, ACTION_CATEGORIES, type BindableAction, type KeybindMap } from '../hooks/useKeybinds';

/** Fired to open the sheet from anywhere (Settings -> Keybinds uses it). */
export const OPEN_SHORTCUTS_EVENT = 'cipherline:open-shortcuts';

export interface KeyLike {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
}

/** Whether keystrokes at `el` are text being typed. */
export function isTypingTarget(el: EventTarget | null): boolean {
    const t = el as (Partial<HTMLElement> & { closest?: (s: string) => Element | null }) | null;
    if (!t || typeof t.tagName !== 'string') return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        // A checkbox or button is not text entry, but `?` there is harmless and
        // still the wrong moment to hijack a key: treat every input as typing.
        return true;
    }
    const role = typeof t.getAttribute === 'function' ? t.getAttribute('role') : null;
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** Should this keydown open the sheet? */
export function shouldOpenShortcutsSheet(e: KeyLike, target: EventTarget | null): boolean {
    if (e.key !== '?') return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented || e.isComposing) return false;
    return !isTypingTarget(target);
}

export interface ShortcutRow {
    id: string;
    label: string;
    /** One keycap per entry ("Ctrl", "Shift", "M"); empty = not bound. */
    keys: string[];
    /** Short qualifier shown under the label. */
    note?: string;
}

export interface ShortcutGroup {
    id: string;
    title: string;
    hint: string;
    rows: ShortcutRow[];
}

/** 'ctrl+shift+m' through the app's display formatter -> ['Ctrl', 'Shift', 'M']. */
export function comboCaps(combo: string | undefined, format: (c: string) => string): string[] {
    if (!combo) return [];
    return format(combo).split(' + ').filter(Boolean);
}

/** Actions the sheet leaves out: the drawing-request pair only matters while one is waiting. */
const SKIP: ReadonlySet<BindableAction> = new Set(['approve-annotation-request', 'decline-annotation-request']);

/**
 * The groups, from the live keybinds.
 *
 * @param binds         the current keybind map (useKeybinds().binds)
 * @param format        formatCombo
 * @param pushToTalkKey the push-to-talk key, when PTT is on (a hold, not a toggle)
 */
export function buildShortcutGroups(
    binds: KeybindMap,
    format: (combo: string) => string,
    pushToTalkKey?: string | null,
): ShortcutGroup[] {
    const groups: ShortcutGroup[] = [];
    for (const cat of ACTION_CATEGORIES) {
        if (cat.id === 'annotation') continue;
        const rows: ShortcutRow[] = ACTIONS
            .filter(a => a.category === cat.id && !SKIP.has(a.id))
            .map(a => ({ id: a.id, label: a.label, keys: comboCaps(binds[a.id], format), note: a.description }));
        if (cat.id === 'controls' && pushToTalkKey) {
            rows.push({ id: 'push-to-talk', label: 'Push to talk', keys: comboCaps(pushToTalkKey, format), note: 'Hold to speak' });
        }
        if (rows.length) groups.push({ id: cat.id, title: cat.label, hint: cat.hint, rows });
    }
    groups.push({
        id: 'writing',
        title: 'Writing',
        hint: 'In the message box',
        rows: [
            { id: 'send', label: 'Send message', keys: ['Enter'] },
            { id: 'newline', label: 'New line', keys: ['Shift', 'Enter'] },
            { id: 'edit-last', label: 'Edit your last message', keys: ['↑'], note: 'When the box is empty' },
            { id: 'pick', label: 'Choose a suggestion', keys: ['Tab'], note: 'For @mentions, #channels and :emoji:' },
        ],
    });
    groups.push({
        id: 'anywhere',
        title: 'Anywhere',
        hint: 'These cannot be changed',
        rows: [
            { id: 'esc', label: 'Close what is on top', keys: ['Esc'] },
            { id: 'sheet', label: 'Show this sheet', keys: ['?'], note: 'When you are not typing' },
        ],
    });
    return groups;
}
