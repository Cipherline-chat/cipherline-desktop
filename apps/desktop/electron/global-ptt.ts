/**
 * System-wide HOLD keys: push-to-talk and push-to-mute (work while Cipherline is
 * unfocused, minimized or in the tray).
 *
 * The renderer owns WHAT the key is (voice settings `pushToTalkKey` /
 * `pushToMuteKey`, combo strings such as "alt", "ctrl+shift+v", "numpad1" or
 * "mouse4" - the vocabulary of src/utils/holdKeys.ts) and what the mic does; main
 * owns only "is that combination physically held right now", because only main
 * can ask the OS. It never reports which key was pressed, only whether the one
 * combination the user chose is held, and it never intercepts a key or a click:
 * Alt+Tab, a game's own use of Mouse 4 and every other use keep working in
 * whatever app has focus.
 *
 * Three backends, chosen once from the session (`holdKeyBackend`):
 *   win32 / x11  the native addon (src-native/key_state.cc) polls the physical key
 *                and mouse-button state (GetAsyncKeyState / XQueryKeymap +
 *                XQueryPointer / XIQueryPointer). Works for a bare modifier.
 *   portal       native Wayland: the desktop's GlobalShortcuts portal sends
 *                Activated (press) and Deactivated (release)
 *                (wayland-global-shortcuts.ts). The portal cannot bind a bare
 *                modifier or a mouse button, so there the key must include a
 *                letter / digit / F-key style key.
 *   none         macOS, XWayland (the X11 poll cannot see other windows' keys on
 *                Wayland), or a native build without the watcher: the renderer's
 *                focused-window listener is the only path.
 *
 * COMBO VOCABULARY. Tokens joined by '+', at most one of them a non-modifier:
 *   modifiers   ctrl alt shift meta (either side) and the side-specific
 *               controlleft/right altleft/right shiftleft/right metaleft/right
 *               (Right Alt is AltGr on many layouts)
 *   physical    the lowercased KeyboardEvent.code of the key: keya, digit1,
 *               numpad1, capslock, bracketleft, intlbackslash, f13, ... Mapped by
 *               POSITION: on Windows to a scan code that the addon turns into this
 *               keyboard layout's virtual key (or to a fixed virtual key where the
 *               key has one), on X11 to the raw X keycode (evdev + 8: the very
 *               keycode Chromium derived `code` from). So numpad keys, Caps Lock,
 *               Right Alt / AltGr and the punctuation keys of a non-US layout all
 *               work, and Shift+1 is "shift+digit1", never "shift+!".
 *   mouse       mouse3 (middle) mouse4 (back) mouse5 (forward)
 *   legacy      what older recorders stored from KeyboardEvent.key: a-z, 0-9,
 *               f1-f24, space, enter, arrowleft, ';', ... still accepted as before.
 *
 * Pure and dependency-free (no `electron`, nothing from src/ - see the rootDir
 * note in CLAUDE.md) so it is unit-testable outside Electron.
 */

export type HoldSlot = 'push-to-talk' | 'push-to-mute';
export const HOLD_SLOTS: readonly HoldSlot[] = ['push-to-talk', 'push-to-mute'];
const SLOT_INDEX: Readonly<Record<HoldSlot, number>> = { 'push-to-talk': 0, 'push-to-mute': 1 };
export function isHoldSlot(v: unknown): v is HoldSlot { return v === 'push-to-talk' || v === 'push-to-mute'; }

export type KeyCodeKind = 'win32' | 'x11';

/** The addon's code flags (src-native/key_state.cc). */
export const WIN_SCAN_CODE = 0x10000;
export const X11_KEYCODE = 0x40000000;
export const X11_BUTTON = 0x20000000;

/** "Any of these codes" per group; every group must have a key down. */
type CodeTable = { mod: Readonly<Record<string, number[]>>; named: Readonly<Record<string, number>>; letter: (c: string) => number; digit: (c: string) => number; fn: (n: number) => number };

const TABLES: Readonly<Record<KeyCodeKind, CodeTable>> = {
    // Win32 virtual keys (winuser.h). VK_MENU / VK_CONTROL / VK_SHIFT = either side.
    win32: {
        mod: { ctrl: [0x11], alt: [0x12], shift: [0x10], meta: [0x5b, 0x5c] },
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
        mod: { ctrl: [0xffe3, 0xffe4], alt: [0xffe9, 0xffea], shift: [0xffe1, 0xffe2], meta: [0xffeb, 0xffec] },
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
 * Physical keys by lowercased KeyboardEvent.code.
 *   win  a fixed virtual key, or WIN_SCAN_CODE | set-1 scan code for a key whose
 *        virtual key depends on the layout (letters, the digit row, punctuation).
 *        Extra alternatives: the numpad digits also count under their NumLock-off
 *        virtual key (End, Down, ...), which is what Windows reports for them then.
 *   x11  the X keycode (evdev code + 8).
 */
interface PhysKey { win: number[]; x11: number; modifier?: boolean }
const sc = (n: number) => WIN_SCAN_CODE | n;
const PHYSICAL: Readonly<Record<string, PhysKey>> = (() => {
    const t: Record<string, PhysKey> = {};
    // Main block: set-1 scan code == evdev code, so x11 = scan code + 8.
    const main = (code: string, scan: number, vk?: number) => { t[code] = { win: [vk ?? sc(scan)], x11: scan + 8 }; };
    const letters: Record<string, number> = {
        a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32,
        n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15, z: 0x2c,
    };
    for (const [l, s] of Object.entries(letters)) main(`key${l}`, s);
    for (let d = 1; d <= 9; d++) main(`digit${d}`, 0x01 + d);
    main('digit0', 0x0b);
    main('minus', 0x0c); main('equal', 0x0d); main('bracketleft', 0x1a); main('bracketright', 0x1b);
    main('semicolon', 0x27); main('quote', 0x28); main('backquote', 0x29); main('backslash', 0x2b);
    main('comma', 0x33); main('period', 0x34); main('slash', 0x35); main('intlbackslash', 0x56);
    main('escape', 0x01, 0x1b); main('backspace', 0x0e, 0x08); main('tab', 0x0f, 0x09); main('enter', 0x1c, 0x0d);
    main('space', 0x39, 0x20); main('capslock', 0x3a, 0x14); main('numlock', 0x45, 0x90); main('scrolllock', 0x46, 0x91);
    for (let f = 1; f <= 10; f++) main(`f${f}`, 0x3a + f, 0x70 + f - 1);
    main('f11', 0x57, 0x7a); main('f12', 0x58, 0x7b);
    for (let f = 13; f <= 24; f++) t[`f${f}`] = { win: [0x70 + f - 1], x11: 183 + (f - 13) + 8 };
    t.intlro = { win: [sc(0x73)], x11: 89 + 8 };
    t.intlyen = { win: [sc(0x7d)], x11: 124 + 8 };
    // Numpad: VK_NUMPADn, or (NumLock off) the navigation key it then sends.
    const numNav = [0x2d, 0x23, 0x28, 0x22, 0x25, 0x0c, 0x27, 0x24, 0x26, 0x21];
    const numScan = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];
    for (let n = 0; n <= 9; n++) t[`numpad${n}`] = { win: [0x60 + n, numNav[n]], x11: numScan[n] + 8 };
    t.numpaddecimal = { win: [0x6e, 0x2e], x11: 0x53 + 8 };
    t.numpadmultiply = { win: [0x6a], x11: 0x37 + 8 };
    t.numpadsubtract = { win: [0x6d], x11: 0x4a + 8 };
    t.numpadadd = { win: [0x6b], x11: 0x4e + 8 };
    t.numpaddivide = { win: [0x6f], x11: 98 + 8 };
    t.numpadenter = { win: [0x0d], x11: 96 + 8 };   // Windows: the same VK_RETURN as Enter
    // Extended keys (evdev codes differ from the scan codes).
    const ext: [string, number, number][] = [
        ['home', 0x24, 102], ['arrowup', 0x26, 103], ['pageup', 0x21, 104], ['arrowleft', 0x25, 105],
        ['arrowright', 0x27, 106], ['end', 0x23, 107], ['arrowdown', 0x28, 108], ['pagedown', 0x22, 109],
        ['insert', 0x2d, 110], ['delete', 0x2e, 111], ['pause', 0x13, 119], ['printscreen', 0x2c, 99],
        ['contextmenu', 0x5d, 127],
    ];
    for (const [code, vk, ev] of ext) t[code] = { win: [vk], x11: ev + 8 };
    // Side-specific modifiers (GetAsyncKeyState knows left from right).
    const mods: [string, number, number][] = [
        ['controlleft', 0xa2, 29], ['controlright', 0xa3, 97], ['shiftleft', 0xa0, 42], ['shiftright', 0xa1, 54],
        ['altleft', 0xa4, 56], ['altright', 0xa5, 100], ['metaleft', 0x5b, 125], ['metaright', 0x5c, 126],
    ];
    for (const [code, vk, ev] of mods) t[code] = { win: [vk], x11: ev + 8, modifier: true };
    return t;
})();

/** Mouse buttons: Win32 VK_MBUTTON / VK_XBUTTON1 / VK_XBUTTON2, X11 pointer buttons 2 / 8 / 9. */
const MOUSE: Readonly<Record<string, { win: number; x11: number }>> = {
    mouse3: { win: 0x04, x11: 2 },
    mouse4: { win: 0x05, x11: 8 },
    mouse5: { win: 0x06, x11: 9 },
};

export const GENERIC_MODIFIERS: readonly string[] = ['ctrl', 'alt', 'shift', 'meta'];
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Is `token` a modifier (generic or side-specific)? */
export function isModifierToken(token: string): boolean {
    return GENERIC_MODIFIERS.includes(token) || (has(PHYSICAL, token) && PHYSICAL[token].modifier === true);
}
export function isMouseToken(token: string): boolean { return has(MOUSE, token); }
/** Physical (KeyboardEvent.code) token known to the watcher. */
export function isPhysicalToken(token: string): boolean { return has(PHYSICAL, token); }

function legacyCode(part: string, t: CodeTable): number | undefined {
    if (/^[a-z]$/.test(part)) return t.letter(part);
    if (/^[0-9]$/.test(part)) return t.digit(part);
    if (/^f([1-9]|1\d|2[0-4])$/.test(part)) return t.fn(Number(part.slice(1)));
    if (has(t.named, part)) return t.named[part];
    return undefined;
}

/** The addon codes for one non-generic token, or null when the watcher cannot read it. */
function tokenGroup(part: string, kind: KeyCodeKind): number[] | null {
    if (has(MOUSE, part)) return [kind === 'win32' ? MOUSE[part].win : X11_BUTTON | MOUSE[part].x11];
    // Legacy first: for a token both vocabularies share ("space", "f5", "arrowup") the
    // old mapping is kept, so a combo saved by an older build is watched exactly as before.
    const legacy = legacyCode(part, TABLES[kind]);
    if (legacy !== undefined) return [legacy];
    if (has(PHYSICAL, part)) {
        const p = PHYSICAL[part];
        return kind === 'win32' ? [...p.win] : [X11_KEYCODE | p.x11];
    }
    return null;
}

/**
 * The key groups that must ALL have a key down for `combo` to count as held, or
 * null when the combo cannot be watched (unknown key, malformed, too long). A bare
 * modifier ("alt", "altright") is valid: it is one group. Case-insensitive.
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
        let group: number[] | null;
        if (has(t.mod, part)) {
            group = [...t.mod[part]];
        } else {
            if (!isModifierToken(part)) mainKeys += 1;
            group = tokenGroup(part, kind);
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

/** Physical tokens with a legacy (US-position) equivalent, for the portal and accelerator forms. */
const PHYSICAL_TO_LEGACY: Readonly<Record<string, string>> = {
    minus: '-', equal: '=', bracketleft: '[', bracketright: ']', semicolon: ';', quote: "'",
    backquote: '`', backslash: '\\', comma: ',', period: '.', slash: '/',
};
/** A combo token in the legacy (KeyboardEvent.key-style) vocabulary where one exists: keyv -> v, digit1 -> 1. */
export function legacyTokenOf(token: string): string {
    const t = token.toLowerCase();
    const m = /^key([a-z])$/.exec(t) ?? /^digit([0-9])$/.exec(t);
    if (m) return m[1];
    return PHYSICAL_TO_LEGACY[t] ?? t;
}

/** Our combo string to an Electron-style accelerator ("ctrl+shift+v" -> "CmdOrCtrl+Shift+V"), the input of the portal trigger converter. */
export function comboToAccelerator(combo: string): string {
    return combo.split('+').map(legacyTokenOf).map(p => {
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

/** Short name of a backend, for the settings UI and diagnostics. */
export function backendName(b: HoldBackend): 'win32' | 'x11' | 'portal' | 'none' {
    return b.kind === 'native' ? b.codes : b.kind;
}

/**
 * Why a hold key works only while Cipherline is the focused window.
 *   unsupported-os      macOS (no system-wide path)
 *   xwayland            X11 app on a Wayland session: it cannot see other windows' keys
 *   no-watcher          the native addon is missing or predates the watcher
 *   unmapped-key        a key the watcher cannot read (saved by an older version, e.g. a shifted symbol)
 *   wayland-modifier    the desktop's shortcut portal cannot bind a bare modifier
 *   wayland-mouse       ... nor a mouse button
 *   wayland-key         ... nor this key (its trigger syntax has no name for it)
 *   wayland-not-bound   the desktop did not bind it (declined, or no portal)
 *   failed              the OS refused (no X display, no XInput 2 for Mouse 4/5)
 */
export type HoldKeyFocusReason =
    | 'unsupported-os' | 'xwayland' | 'no-watcher' | 'unmapped-key'
    | 'wayland-modifier' | 'wayland-mouse' | 'wayland-key' | 'wayland-not-bound' | 'failed';

/** Keys the portal trigger converter (wayland-global-shortcuts.ts acceleratorToPortalTrigger) can name. */
function portalCanName(token: string): boolean {
    const l = legacyTokenOf(token);
    return /^[a-z0-9]$/.test(l) || /^f([1-9]|[12]\d|3[0-5])$/.test(l)
        || ['escape', 'space', ',', '.', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(l);
}

/** Why the GlobalShortcuts portal cannot take `combo`, or null when it can (subject to the desktop agreeing). */
export function portalHoldIssue(combo: string): HoldKeyFocusReason | null {
    const parts = combo.toLowerCase().split('+');
    if (parts.some(isMouseToken)) return 'wayland-mouse';
    const main = parts.filter(p => !GENERIC_MODIFIERS.includes(p));
    if (main.length === 0 || main.every(isModifierToken)) return 'wayland-modifier';
    // The trigger syntax has CTRL / ALT / SHIFT only (no Super), and no side-specific modifiers.
    if (parts.includes('meta') || main.length > 1 || !portalCanName(main[0])) return 'wayland-key';
    return null;
}

/** The slice of the native addon this module uses (src-native/key_state.cc). Absent on an older build / other OS. */
export interface KeyStateNative {
    watchKeys?(slot: number, groups: number[][], callback: (down: boolean) => void): boolean;
    stopWatchingKeys?(slot?: number): void;
    getForegroundElevation?(): unknown;
}

export type GlobalPttResult =
    | { ok: true; watching: boolean }
    | { ok: false; reason: 'unsupported' | 'bad-key' | 'failed'; detail?: HoldKeyFocusReason };

/** What the settings UI shows for a key: works everywhere, or only while Cipherline is focused and why. */
export type HoldKeySupport =
    | { status: 'ok'; backend: 'win32' | 'x11' | 'portal' }
    | { status: 'focused-only'; backend: 'win32' | 'x11' | 'portal' | 'none'; reason: HoldKeyFocusReason };

/**
 * Would `combo` be watched system-wide on this session? A dry run of setKey's
 * decision (no watch is started): for the settings row, the keybinds list and the
 * diagnostic report. On the portal, 'ok' still depends on the desktop agreeing
 * when the key is bound.
 */
export function holdKeySupport(combo: unknown, backend: HoldBackend, hasNativeWatcher: boolean): HoldKeySupport | null {
    if (typeof combo !== 'string' || combo === '') return null;
    const name = backendName(backend);
    if (backend.kind === 'none') return { status: 'focused-only', backend: name, reason: backend.reason };
    if (backend.kind === 'portal') {
        const issue = portalHoldIssue(combo);
        return issue ? { status: 'focused-only', backend: 'portal', reason: issue } : { status: 'ok', backend: 'portal' };
    }
    if (!hasNativeWatcher) return { status: 'focused-only', backend: name, reason: 'no-watcher' };
    if (!comboToKeyGroups(combo, backend.codes)) return { status: 'focused-only', backend: name, reason: 'unmapped-key' };
    return { status: 'ok', backend: backend.codes };
}

/** A live setKey result as a support value (what actually happened, not the dry run). */
export function supportFromResult(r: GlobalPttResult, backend: HoldBackend): HoldKeySupport {
    const name = backendName(backend);
    if (r.ok && r.watching) return { status: 'ok', backend: name === 'none' ? 'win32' : name };
    if (r.ok) return { status: 'focused-only', backend: name, reason: 'failed' };
    if (r.detail) return { status: 'focused-only', backend: name, reason: r.detail };
    if (r.reason === 'bad-key') return { status: 'focused-only', backend: name, reason: 'unmapped-key' };
    if (r.reason === 'unsupported') return { status: 'focused-only', backend: name, reason: backend.kind === 'none' ? backend.reason : 'no-watcher' };
    return { status: 'focused-only', backend: name, reason: 'failed' };
}

/** Wayland: bind (or clear, combo null) a hold key through the portal; resolves once the desktop answered. */
export type PortalHoldSetter = (slot: HoldSlot, combo: string | null) => Promise<GlobalPttResult>;

/** Owns one watch per slot. `getNative` is lazy: the addon loads after app.whenReady(). */
export class GlobalHoldKeyWatcher {
    private readonly active = new Set<HoldSlot>();
    private readonly last: Partial<Record<HoldSlot, GlobalPttResult>> = {};

    constructor(
        private readonly getNative: () => KeyStateNative | null | undefined,
        private readonly backend: () => HoldBackend,
        private readonly onState: (slot: HoldSlot, down: boolean) => void,
        private readonly portal?: PortalHoldSetter,
    ) {}

    /** Start watching `combo` for `slot`; null/'' stops. Replaces that slot's previous watch. */
    async setKey(slot: HoldSlot, combo: unknown): Promise<GlobalPttResult> {
        const r = await this.apply(slot, combo);
        if (combo === null || combo === undefined || combo === '') delete this.last[slot];
        else this.last[slot] = r;
        return r;
    }

    private async apply(slot: HoldSlot, combo: unknown): Promise<GlobalPttResult> {
        const b = this.backend();
        if (combo === null || combo === undefined || combo === '') {
            this.stopSlot(slot);
            if (b.kind === 'portal') await this.portal?.(slot, null).catch(() => undefined);
            return { ok: true, watching: false };
        }
        if (b.kind === 'none') { this.stopSlot(slot); return { ok: false, reason: 'unsupported', detail: b.reason }; }
        if (typeof combo !== 'string') { this.stopSlot(slot); return { ok: false, reason: 'bad-key', detail: 'unmapped-key' }; }
        if (b.kind === 'portal') {
            const issue = portalHoldIssue(combo);
            if (issue) {
                // Clear any earlier binding of this slot: the old key must not keep working through the portal.
                await this.portal?.(slot, null).catch(() => undefined);
                return { ok: false, reason: 'bad-key', detail: issue };
            }
            if (!this.portal) return { ok: false, reason: 'unsupported', detail: 'wayland-not-bound' };
            try {
                const r = await this.portal(slot, combo);
                return r.ok || r.detail ? r : { ...r, detail: r.reason === 'bad-key' ? 'wayland-key' : 'wayland-not-bound' };
            } catch { return { ok: false, reason: 'failed', detail: 'wayland-not-bound' }; }
        }
        const native = this.getNative();
        if (!native || typeof native.watchKeys !== 'function') { this.stopSlot(slot); return { ok: false, reason: 'unsupported', detail: 'no-watcher' }; }
        const groups = comboToKeyGroups(combo, b.codes);
        if (!groups) { this.stopSlot(slot); return { ok: false, reason: 'bad-key', detail: 'unmapped-key' }; }
        let started = false;
        try { started = native.watchKeys(SLOT_INDEX[slot], groups, (down) => this.onState(slot, down === true)); } catch { started = false; }
        if (started) this.active.add(slot); else this.active.delete(slot);
        return started ? { ok: true, watching: true } : { ok: false, reason: 'failed', detail: 'failed' };
    }

    private stopSlot(slot: HoldSlot): void {
        if (!this.active.delete(slot)) return;
        try { this.getNative()?.stopWatchingKeys?.(SLOT_INDEX[slot]); } catch { /* already stopped */ }
    }

    /** Is any slot watched through the native poll right now? */
    get watchingNatively(): boolean { return this.active.size > 0; }

    /** The last result per slot (absent = no key set), for diagnostics. */
    results(): Partial<Record<HoldSlot, GlobalPttResult>> { return { ...this.last }; }

    stop(): void {
        for (const s of [...this.active]) this.stopSlot(s);
        for (const s of HOLD_SLOTS) delete this.last[s];
    }
}

// ── Elevated foreground window (Windows) ─────────────────────────────────────

export type ForegroundKind = 'none' | 'self' | 'higher' | 'same' | 'denied' | 'unknown';
export interface ForegroundElevation { foreground: ForegroundKind; selfElevated: boolean }

/** The addon's getForegroundElevation() reply, validated. null = unreadable. */
export function parseForegroundElevation(raw: unknown): ForegroundElevation | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const kinds: ForegroundKind[] = ['none', 'self', 'higher', 'same', 'denied', 'unknown'];
    if (typeof r.foreground !== 'string' || !kinds.includes(r.foreground as ForegroundKind)) return null;
    return { foreground: r.foreground as ForegroundKind, selfElevated: r.selfElevated === true };
}

/**
 * Does the focused window run as administrator while we do not?
 *   'yes'      POSITIVELY confirmed: its token's integrity level is above ours.
 *              Windows' UIPI then makes GetAsyncKeyState read nothing while it has focus.
 *   'no'       confirmed not (same or lower level, or we are elevated ourselves).
 *   'unknown'  Windows would not tell us ('denied': token or process hidden, common with
 *              anti-cheat; 'unknown'). NEVER treated as admin: no hint is shown for it, it
 *              is only reported in diagnostics.
 *   null       not a game window (one of ours, or none) / unreadable reply.
 */
export type AdminGameState = 'yes' | 'no' | 'unknown';
export function adminGameState(e: ForegroundElevation | null): AdminGameState | null {
    if (!e || e.foreground === 'self' || e.foreground === 'none') return null;
    if (e.selfElevated) return 'no';
    if (e.foreground === 'higher') return 'yes';
    if (e.foreground === 'same') return 'no';
    return 'unknown';
}

/** Is the focused window hidden from our key poll? Only when that is positively confirmed (adminGameState 'yes'). */
export function foregroundBlocksKeyPoll(e: ForegroundElevation | null): boolean {
    return adminGameState(e) === 'yes';
}

/**
 * Polls the foreground window's elevation while a native watch is running and
 * reports CHANGES of "the key poll is blocked" (debounced to a change only).
 * Also remembers the last answer about a game window (`lastGame`, for the
 * problem report: at report time Cipherline itself has focus).
 * Timers are injected so the logic is testable.
 */
export class ForegroundElevationMonitor {
    private timer: ReturnType<typeof setInterval> | null = null;
    private blocked = false;
    private game: AdminGameState | null = null;

    constructor(
        private readonly read: () => unknown,
        private readonly onChange: (blocked: boolean) => void,
        private readonly intervalMs = 1500,
        private readonly timers: { set: typeof setInterval; clear: typeof clearInterval } = { set: setInterval, clear: clearInterval },
    ) {}

    get isBlocked(): boolean { return this.blocked; }
    get running(): boolean { return this.timer !== null; }
    /** The last confirmed / unknown answer about a game window since start, null if none seen. */
    get lastGame(): AdminGameState | null { return this.game; }

    /** One sample; exposed for tests and for an immediate answer on start. */
    tick(): void {
        let state: AdminGameState | null = null;
        try { state = adminGameState(parseForegroundElevation(this.read())); } catch { state = null; }
        if (state) this.game = state;
        const now = state === 'yes';
        if (now !== this.blocked) { this.blocked = now; this.onChange(now); }
    }

    /** Run while `on`; turning off reports "not blocked" if it was. */
    setRunning(on: boolean): void {
        if (on && !this.timer) {
            this.tick();
            this.timer = this.timers.set(() => this.tick(), this.intervalMs);
            (this.timer as { unref?: () => void }).unref?.();
        } else if (!on && this.timer) {
            this.timers.clear(this.timer);
            this.timer = null;
            if (this.blocked) { this.blocked = false; this.onChange(false); }
        }
    }
}
