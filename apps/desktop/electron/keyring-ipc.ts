/**
 * IPC contract for the Linux wallet prompt. Pure (no `electron` import): the
 * validation and the relaunch recipe are unit-tested; main.ts only wires them.
 *
 * Nothing secret crosses this boundary. The renderer asks "what did the wallet
 * do" and gets enums and booleans (keyring-prompt.ts `KeyringStatus`); it can
 * ask for ONE action, "try again", which is a relaunch of the whole app
 * (a refused wallet is cached by Chromium for the life of the process, so a
 * second in-process attempt does nothing, measured).
 */

export const KEYRING_STATUS_CHANNEL = 'secure:get-keyring-status';
export const KEYRING_ACTION_CHANNEL = 'secure:keyring-action';

export type KeyringAction = 'retry';

const ACTIONS: ReadonlySet<string> = new Set<KeyringAction>(['retry']);

/**
 * Strict: a plain object whose only own key is `action`, and an allow-listed
 * value. Anything else (wrong type, extra keys, prototype tricks, unknown
 * action) is null: never coerced, never "close enough".
 */
export function parseKeyringAction(input: unknown): { action: KeyringAction } | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== 'action') return null;
    const action = (input as Record<string, unknown>).action;
    if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
    return { action: action as KeyringAction };
}

/** Whatever the renderer sends is allowed at most this often: a relaunch is not a toy. */
export const KEYRING_RETRY_COOLDOWN_MS = 3_000;

export interface RelaunchOptions {
    execPath?: string;
    args: string[];
}

/**
 * `app.relaunch()` options. An AppImage mounts itself, and `process.execPath`
 * lives inside that mount, which is gone by the time the relaunched process
 * would start: relaunch the `.AppImage` file itself, as the AppImage runtime
 * tells us via `$APPIMAGE`. Every other install relaunches `process.execPath`.
 * Arguments are carried over (dev: the app path and flags).
 */
export function relaunchOptions(env: { APPIMAGE?: string }, argv: readonly string[], extraArgs: readonly string[] = []): RelaunchOptions {
    // The loop-guard flag of an automatic relaunch is dropped here: a relaunch
    // the person asks for (or a fresh automatic one) must start clean.
    const args = [...argv.slice(1).filter(a => a !== '--keyring-auto-retry'), ...extraArgs];
    const appImage = typeof env.APPIMAGE === 'string' && env.APPIMAGE.startsWith('/') ? env.APPIMAGE : null;
    return appImage ? { execPath: appImage, args } : { args };
}
