/**
 * System-wide HOLD keys: push-to-talk and push-to-mute (work while Cipherline is
 * unfocused, minimized or in the tray).
 *
 * The renderer owns WHAT the key is (voice settings `pushToTalkKey` /
 * `pushToMuteKey`, combo strings such as "alt" or "ctrl+shift+v" in useKeybinds'
 * vocabulary) and what the mic does; main owns only "is that combination
 * physically held right now", because only main can ask the OS. It never reports
 * which key was pressed, only whether the one combination the user chose is held,
 * and it never intercepts a key: Alt+Tab and every other use of the key keep
 * working in whatever app has focus.
 *
 * Three backends, chosen once from the session (`holdKeyBackend`):
 *   win32 / x11  the native addon (src-native/key_state.cc) polls the physical key
 *                state (GetAsyncKeyState / XQueryKeymap). Works for a bare modifier.
 *   portal       native Wayland: the desktop's GlobalShortcuts portal sends
 *                Activated (press) and Deactivated (release)
 *                (wayland-global-shortcuts.ts). The portal cannot bind a bare
 *                modifier, so there the key must include a non-modifier key.
 *   none         macOS, XWayland (the X11 poll cannot see other windows' keys on
 *                Wayland), or a native build without the watcher: the renderer's
 *                focused-window listener is the only path.
 *
 * Pure and dependency-free (no `electron`, nothing from src/ - see the rootDir
 * note in CLAUDE.md) so it is unit-testable outside Electron.
 */

export type HoldSlot = 'push-to-talk' | 'push-to-mute';
export const HOLD_SLOTS: readonly HoldSlot[] = ['push-to-talk', 'push-to-mute'];
const SLOT_INDEX: Readonly<Record<HoldSlot, number>> = { 'push-to-talk': 0, 'push-to-mute': 1 };
export function isHoldSlot(v: unknown): v is HoldSlot { return v === 'push-to-talk' || v === 'push-to-mute'; }

export type KeyCodeKind = 'win32' | 'x11';

/** "Any of these codes" per group; every group must have a key down. */
type CodeTable = { mod: Readonly<Record<string, number[]>>; named: Readonly<Record<string, number>>; letter: (c: string) => number; digit: (c: string) => number; fn: (n: number) => number };

const TABLES: Readonly<Record<KeyCodeKind, CodeTable>> = {
    // Win32 virtual keys (winuser.h). VK_MENU / VK_CONTROL / VK_SHIFT = either side.
    win32: {
        mod: { ctrl: [0x11], alt: [0x12], shift: [0x10] },
        named: {
            space: 0x20, enter: 0x0d, tab: 0x09, backspace: 0x08, escape: 0x1b,
            pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, insert: 0x2d, delete: 0x2e,
            arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
            ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
            '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
        },
        letter: (c) => c.charCodeAt(0) - 97 + 0x41,
        digit: (c) => c.charCodeAt(0) - 48 + 0x30,
        fn: (n) => 0x70 + n - 1,
    },
    // X11 keysyms (keysymdef.h). Left or right modifier.
    x11: {
        mod: { ctrl: [0xffe3, 0xffe4], alt: [0xffe9, 0xffea], shift: [0xffe1, 0xffe2] },
        named: {
            space: 0x20, enter: 0xff0d, tab: 0xff09, backspace: 0xff08, escape: 0xff1b,
            pageup: 0xff55, pagedown: 0xff56, end: 0xff57, home: 0xff50, insert: 0xff63, delete: 0xffff,
            arrowleft: 0xff51, arrowup: 0xff52, arrowright: 0xff53, arrowdown: 0xff54,
            ';': 0x3b, '=': 0x3d, ',': 0x2c, '-': 0x2d, '.': 0x2e, '/': 0x2f, '`': 0x60,
            '[': 0x5b, '\\': 0x5c, ']': 0x5d, "'": 0x27,
        },
        letter: (c) => c.charCodeAt(0),   // lowercase ASCII keysym = the character
        digit: (c) => c.charCodeAt(0),
        fn: (n) => 0xffbe + n - 1,
    },
};

/**
 * The key groups that must ALL have a key down for `combo` to count as held, or
 * null when the combo cannot be watched (unknown key, malformed, too long). A bare
 * modifier ("alt") is valid: it is one group. Case-insensitive.
 */
export function comboToKeyGroups(combo: unknown, kind: KeyCodeKind): number[][] | null {
    if (typeof combo !== 'string' || combo.length === 0 || combo.length > 64) return null;
    const t = TABLES[kind];
    const parts = combo.toLowerCase().split('+');
    if (parts.length === 0 || parts.length > 4 || parts.some(p => p.length === 0)) return null;
    const out: number[][] = [];
    const seen = new Set<string>();
    let mainKeys = 0;
    for (const part of parts) {
        if (seen.has(part)) return null;
        seen.add(part);
        let group: number[] | undefined;
        if (Object.prototype.hasOwnProperty.call(t.mod, part)) {
            group = t.mod[part];
        } else {
            mainKeys += 1;
            let code: number | undefined;
            if (/^[a-z]$/.test(part)) code = t.letter(part);
            else if (/^[0-9]$/.test(part)) code = t.digit(part);
            else if (/^f([1-9]|1\d|2[0-4])$/.test(part)) code = t.fn(Number(part.slice(1)));
            else if (Object.prototype.hasOwnProperty.call(t.named, part)) code = t.named[part];
            if (code !== undefined) group = [code];
        }
        if (!group) return null;
        out.push(group);
    }
    // At most one non-modifier key: two letters at once is not a combo the recorder can produce.
    return mainKeys <= 1 ? out : null;
}

/** Windows virtual keys, one per group (kept for callers/tests that only need the single-key form). */
export function comboToVirtualKeys(combo: unknown): number[] | null {
    const g = comboToKeyGroups(combo, 'win32');
    return g ? g.map(x => x[0]) : null;
}

/** Our combo string to an Electron-style accelerator ("ctrl+shift+v" -> "CmdOrCtrl+Shift+V"), the input of the portal trigger converter. */
export function comboToAccelerator(combo: string): string {
    return combo.split('+').map(p => {
        switch (p) {
            case 'ctrl': return 'CmdOrCtrl';
            case 'alt': return 'Alt';
            case 'shift': return 'Shift';
            case 'arrowup': return 'Up';
            case 'arrowdown': return 'Down';
            case 'arrowleft': return 'Left';
            case 'arrowright': return 'Right';
            default: return p.toUpperCase();
        }
    }).join('+');
}

export type HoldBackend =
    | { kind: 'native'; codes: KeyCodeKind }
    | { kind: 'portal' }
    | { kind: 'none'; reason: 'unsupported-os' | 'xwayland' };

/**
 * Which way hold keys can be delivered on this session.
 * `nativeWayland`: the app runs as a native Wayland client (capture-flags.isNativeWaylandClient).
 */
export function holdKeyBackend(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, nativeWayland: boolean): HoldBackend {
    if (platform === 'win32') return { kind: 'native', codes: 'win32' };
    if (platform === 'linux') {
        if (nativeWayland) return { kind: 'portal' };
        // An X11 client on a Wayland session (XWayland) only sees keys while an X11 window has focus.
        if ((env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland') return { kind: 'none', reason: 'xwayland' };
        return { kind: 'native', codes: 'x11' };
    }
    return { kind: 'none', reason: 'unsupported-os' };
}

/** The slice of the native addon this module uses (src-native/key_state.cc). Absent on an older build / other OS. */
export interface KeyStateNative {
    watchKeys?(slot: number, groups: number[][], callback: (down: boolean) => void): boolean;
    stopWatchingKeys?(slot?: number): void;
}

export type GlobalPttResult =
    | { ok: true; watching: boolean }
    | { ok: false; reason: 'unsupported' | 'bad-key' | 'failed' };

/** Wayland: bind (or clear, combo null) a hold key through the portal; resolves once the desktop answered. */
export type PortalHoldSetter = (slot: HoldSlot, combo: string | null) => Promise<GlobalPttResult>;

/** Owns one watch per slot. `getNative` is lazy: the addon loads after app.whenReady(). */
export class GlobalHoldKeyWatcher {
    private readonly active = new Set<HoldSlot>();

    constructor(
        private readonly getNative: () => KeyStateNative | null | undefined,
        private readonly backend: () => HoldBackend,
        private readonly onState: (slot: HoldSlot, down: boolean) => void,
        private readonly portal?: PortalHoldSetter,
    ) {}

    /** Start watching `combo` for `slot`; null/'' stops. Replaces that slot's previous watch. */
    async setKey(slot: HoldSlot, combo: unknown): Promise<GlobalPttResult> {
        const b = this.backend();
        if (combo === null || combo === undefined || combo === '') {
            this.stopSlot(slot);
            if (b.kind === 'portal') await this.portal?.(slot, null).catch(() => undefined);
            return { ok: true, watching: false };
        }
        if (b.kind === 'none') { this.stopSlot(slot); return { ok: false, reason: 'unsupported' }; }
        if (typeof combo !== 'string') { this.stopSlot(slot); return { ok: false, reason: 'bad-key' }; }
        if (b.kind === 'portal') {
            if (!this.portal) return { ok: false, reason: 'unsupported' };
            try { return await this.portal(slot, combo); } catch { return { ok: false, reason: 'failed' }; }
        }
        const native = this.getNative();
        if (!native || typeof native.watchKeys !== 'function') { this.stopSlot(slot); return { ok: false, reason: 'unsupported' }; }
        const groups = comboToKeyGroups(combo, b.codes);
        if (!groups) { this.stopSlot(slot); return { ok: false, reason: 'bad-key' }; }
        let started = false;
        try { started = native.watchKeys(SLOT_INDEX[slot], groups, (down) => this.onState(slot, down === true)); } catch { started = false; }
        if (started) this.active.add(slot); else this.active.delete(slot);
        return started ? { ok: true, watching: true } : { ok: false, reason: 'failed' };
    }

    private stopSlot(slot: HoldSlot): void {
        if (!this.active.delete(slot)) return;
        try { this.getNative()?.stopWatchingKeys?.(SLOT_INDEX[slot]); } catch { /* already stopped */ }
    }

    stop(): void { for (const s of [...this.active]) this.stopSlot(s); }
}
