/**
 * Validation for the `keybinds:sync-global-shortcuts` IPC payload - the
 * renderer's { accelerator: actionId } map that main registers as OS-level
 * shortcuts. Pure and dependency-free so it is unit-testable outside Electron.
 *
 * Two shapes of bad input, handled differently on purpose:
 *  - A payload that is not a plain object, or is absurdly large, is malformed:
 *    `validateGlobalShortcutMap` returns `ok: false` and main rejects the
 *    call WITHOUT touching what is currently registered.
 *  - A well-formed map with an individual bad entry (an unknown action id, an
 *    accelerator outside the vocabulary the renderer produces) drops just that
 *    entry and REPORTS it in `rejected`, which main returns as failed - never
 *    registered, never silently coerced into something else. Rejecting the
 *    whole map there instead would let one odd custom binding take every other
 *    global shortcut down with it.
 *
 * The action allow-list must match the renderer's global actions
 * (src/hooks/useKeybinds.ts ACTIONS with `global: true`);
 * src/hooks/globalShortcutPayload.contract.test.ts fails if they drift.
 */

export const KNOWN_GLOBAL_SHORTCUT_ACTIONS: ReadonlySet<string> = new Set([
    'toggle-mute',
    'toggle-deafen',
    'toggle-camera',
    'toggle-screenshare',
    'leave-call',
    'quick-screenshare',
    'lock-screen',
    'approve-annotation-request',
    'decline-annotation-request',
]);

/** More entries than there are actions is already wrong; this is a backstop. */
export const MAX_GLOBAL_SHORTCUTS = 32;
const MAX_ACCELERATOR_LENGTH = 64;

/**
 * What comboToAccelerator (useKeybinds.ts) can produce: up to three of our
 * modifier tokens, then exactly one key token with no whitespace, no '+' and no
 * control characters.
 */
const ACCELERATOR_RE = /^(?:(?:CmdOrCtrl|Alt|Shift)\+){0,3}[^\s+\p{Cc}]{1,24}$/u;

export function isValidAccelerator(accelerator: unknown): accelerator is string {
    return typeof accelerator === 'string'
        && accelerator.length > 0
        && accelerator.length <= MAX_ACCELERATOR_LENGTH
        && ACCELERATOR_RE.test(accelerator);
}

export type GlobalShortcutMapResult =
    | { ok: true; map: Record<string, string>; rejected: string[] }
    | { ok: false; reason: string };

export function validateGlobalShortcutMap(raw: unknown): GlobalShortcutMapResult {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'not a plain object' };
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_GLOBAL_SHORTCUTS) return { ok: false, reason: 'too many entries' };

    const map: Record<string, string> = {};
    const rejected: string[] = [];
    const seenActions = new Set<string>();
    for (const [accelerator, actionId] of entries) {
        if (typeof actionId !== 'string' || !KNOWN_GLOBAL_SHORTCUT_ACTIONS.has(actionId)) {
            // Unknown action: nothing the renderer could act on. Reported by a
            // fixed marker rather than echoing arbitrary renderer input to logs.
            rejected.push('unknown-action');
            continue;
        }
        if (!isValidAccelerator(accelerator) || seenActions.has(actionId)) {
            rejected.push(actionId);
            continue;
        }
        seenActions.add(actionId);
        map[accelerator] = actionId;
    }
    return { ok: true, map, rejected };
}
