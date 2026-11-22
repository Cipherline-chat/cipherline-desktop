/**
 * Hold keys (push-to-talk / push-to-mute): the renderer's half of the combo
 * vocabulary that electron/global-ptt.ts watches system-wide.
 *
 *  - recording: keys are stored by PHYSICAL position (lowercased
 *    KeyboardEvent.code: "numpad1", "capslock", "keyq", "shift+digit1"), so the
 *    system-wide watcher can read them on any keyboard layout; a lone RIGHT-side
 *    modifier is its own key ("altright" = Right Alt / AltGr); Mouse 4 / 5 and
 *    the middle button are bindable ("mouse4");
 *  - matching in the focused window: a tracker of what is held (keys AND mouse
 *    buttons), which also understands combos saved by older versions ("a",
 *    "ctrl+shift+v": KeyboardEvent.key-style tokens);
 *  - labels for every token, with the user's own keyboard layout where the
 *    browser can tell (navigator.keyboard.getLayoutMap);
 *  - what the watcher said, as the line Settings shows ("only while Cipherline
 *    is focused, because ...").
 *
 * Plain logic, no React and no stored state beyond the cached layout labels.
 */

// ── Tokens ───────────────────────────────────────────────────────────────────

export const GENERIC_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
type GenericModifier = typeof GENERIC_MODIFIERS[number];

/** Side-specific modifier codes and the generic modifier each one satisfies. */
const MODIFIER_CODES: Readonly<Record<string, GenericModifier>> = {
    controlleft: 'ctrl', controlright: 'ctrl', shiftleft: 'shift', shiftright: 'shift',
    altleft: 'alt', altright: 'alt', metaleft: 'meta', metaright: 'meta',
};

/** Fallback (US-position) label of every physical token the system-wide watcher knows. */
const PHYSICAL_LABELS: Readonly<Record<string, string>> = (() => {
    const t: Record<string, string> = {};
    for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); t[`key${c}`] = c.toUpperCase(); }
    for (let d = 0; d <= 9; d++) { t[`digit${d}`] = String(d); t[`numpad${d}`] = `Num ${d}`; }
    for (let f = 1; f <= 24; f++) t[`f${f}`] = `F${f}`;
    Object.assign(t, {
        minus: '-', equal: '=', bracketleft: '[', bracketright: ']', semicolon: ';', quote: "'",
        backquote: '`', backslash: '\\', comma: ',', period: '.', slash: '/', intlbackslash: '\\ (ISO)',
        intlro: 'Ro', intlyen: 'Yen',
        escape: 'Esc', backspace: 'Backspace', tab: 'Tab', enter: 'Enter', space: 'Space',
        capslock: 'Caps Lock', numlock: 'Num Lock', scrolllock: 'Scroll Lock', pause: 'Pause',
        printscreen: 'Print Screen', contextmenu: 'Menu',
        numpaddecimal: 'Num .', numpadmultiply: 'Num *', numpadsubtract: 'Num -', numpadadd: 'Num +',
        numpaddivide: 'Num /', numpadenter: 'Num Enter',
        home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down', insert: 'Insert', delete: 'Delete',
        arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
        controlleft: 'Left Ctrl', controlright: 'Right Ctrl', shiftleft: 'Left Shift', shiftright: 'Right Shift',
        altleft: 'Left Alt', altright: 'Right Alt', metaleft: 'Left Win', metaright: 'Right Win',
    });
    return t;
})();

export const MOUSE_TOKENS: Readonly<Record<string, string>> = { mouse3: 'Middle mouse', mouse4: 'Mouse 4', mouse5: 'Mouse 5' };
/** MouseEvent.button -> our token. 0 (left) and 2 (right) are never bindable. */
const MOUSE_BUTTON_TOKEN: Readonly<Record<number, string>> = { 1: 'mouse3', 3: 'mouse4', 4: 'mouse5' };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Every physical token (lowercased KeyboardEvent.code) the recorder stores. Exported for the cross-check test. */
export const PHYSICAL_TOKENS: readonly string[] = Object.keys(PHYSICAL_LABELS);

export function isModifierToken(t: string): boolean { return (GENERIC_MODIFIERS as readonly string[]).includes(t) || has(MODIFIER_CODES, t); }
export function isMouseToken(t: string): boolean { return has(MOUSE_TOKENS, t); }

/** Our token for a KeyboardEvent.code we can watch, else null. */
export function physicalTokenOfCode(code: string | undefined): string | null {
    if (!code) return null;
    const t = code.toLowerCase();
    return has(PHYSICAL_LABELS, t) ? t : null;
}

/** The legacy (KeyboardEvent.key-style) token for an event: what older builds stored. */
function legacyTokenOfKey(key: string): string {
    const k = key.toLowerCase();
    if (k === 'control' || k === 'meta') return 'ctrl';
    if (k === ' ') return 'space';
    return k;
}

/** keyv -> v, digit1 -> 1, comma -> ',': the legacy spelling of a physical token, where it has one. */
export function legacyTokenOf(token: string): string {
    const t = token.toLowerCase();
    const m = /^key([a-z])$/.exec(t) ?? /^digit([0-9])$/.exec(t);
    if (m) return m[1];
    const punct: Record<string, string> = {
        minus: '-', equal: '=', bracketleft: '[', bracketright: ']', semicolon: ';', quote: "'",
        backquote: '`', backslash: '\\', comma: ',', period: '.', slash: '/',
    };
    return punct[t] ?? t;
}

/** The combo in the general keybinds' vocabulary (for "is the PTT key also a keybind" checks). */
export function holdComboAsKeybind(combo: string): string {
    return combo.toLowerCase().split('+').map(legacyTokenOf).join('+');
}

export type HoldKeyKind = 'none' | 'modifier' | 'key' | 'combo' | 'mouse' | 'mouse-combo';
/** What kind of key a combo is, for diagnostics (never the key itself). */
export function holdKeyKind(combo: string | null | undefined): HoldKeyKind {
    if (!combo) return 'none';
    const parts = combo.toLowerCase().split('+');
    const mouse = parts.some(isMouseToken);
    if (mouse) return parts.length > 1 ? 'mouse-combo' : 'mouse';
    if (parts.every(isModifierToken)) return parts.length === 1 ? 'modifier' : 'combo';
    return parts.length === 1 ? 'key' : 'combo';
}

/** A diagnostics-safe spelling of the combo: tokens joined by '_' (only [a-z0-9_-]), or null for anything else. */
export function holdKeyReportName(combo: string | null | undefined): string | null {
    if (!combo) return null;
    const s = combo.toLowerCase().split('+').join('_');
    return /^[a-z0-9_-]{1,32}$/.test(s) ? s : 'other';
}

// ── Labels ───────────────────────────────────────────────────────────────────

let layoutLabels: Map<string, string> | null = null;

/**
 * Load the user's keyboard layout labels once (Chromium's navigator.keyboard),
 * so a physical key shows what is printed on THEIR key ("Ö", "Ä", "Z" on QWERTZ).
 * Best-effort: without it the US-position label is shown.
 */
export function primeKeyboardLayoutLabels(): void {
    if (layoutLabels) return;
    try {
        const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
        kb?.getLayoutMap?.().then((m) => {
            const out = new Map<string, string>();
            m.forEach((v, k) => { if (v && v.trim()) out.set(k.toLowerCase(), v.toUpperCase()); });
            layoutLabels = out;
        }).catch(() => undefined);
    } catch { /* not available */ }
}

/** Test seam. */
export function __setLayoutLabels(m: Map<string, string> | null): void { layoutLabels = m; }

function platformName(): 'mac' | 'win' | 'other' {
    const p = typeof navigator !== 'undefined' ? navigator.platform ?? '' : '';
    return p.includes('Mac') ? 'mac' : p.startsWith('Win') ? 'win' : 'other';
}

export function isWindowsPlatform(): boolean { return platformName() === 'win'; }

/** The label of a hold-key token, or undefined for a token this module does not know. */
export function holdTokenLabel(token: string): string | undefined {
    const t = token.toLowerCase();
    const plat = platformName();
    if (t === 'meta') return plat === 'win' ? 'Win' : plat === 'mac' ? '⌘' : 'Super';
    if (t === 'metaleft' || t === 'metaright') {
        const side = t === 'metaleft' ? 'Left' : 'Right';
        return `${side} ${plat === 'win' ? 'Win' : plat === 'mac' ? '⌘' : 'Super'}`;
    }
    if (has(MOUSE_TOKENS, t)) return MOUSE_TOKENS[t];
    if (has(PHYSICAL_LABELS, t)) {
        // The user's layout for the keys that change with it (letters, digit row, punctuation).
        const fromLayout = /^(key[a-z]|digit\d|minus|equal|bracket|semicolon|quote|backquote|backslash|comma|period|slash|intl)/.test(t)
            ? layoutLabels?.get(t) : undefined;
        return fromLayout ?? PHYSICAL_LABELS[t];
    }
    return undefined;
}

// ── Recording ────────────────────────────────────────────────────────────────

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string };
type MouseLike = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

const MODIFIER_KEY_NAMES = ['control', 'meta', 'alt', 'shift', 'altgraph'];
function isModifierEvent(e: KeyLike): boolean {
    return MODIFIER_KEY_NAMES.includes(e.key.toLowerCase()) || (!!e.code && has(MODIFIER_CODES, e.code.toLowerCase()));
}

/** Generic modifier tokens from an event's flags (mac: Cmd is our 'ctrl', as it always was). */
function flagModifiers(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, isMac: boolean): string[] {
    const out: string[] = [];
    if (e.ctrlKey || (isMac && e.metaKey)) out.push('ctrl');
    if (e.altKey) out.push('alt');
    if (e.shiftKey) out.push('shift');
    if (!isMac && e.metaKey) out.push('meta');
    return out;
}

/**
 * Key + mouse recorder for a hold key. A modifier press only ARMS a candidate; it
 * is committed when a modifier is released with nothing else pressed in between
 * (so Ctrl+K does not bind "ctrl"). Any other key, or Mouse 4 / 5 / middle,
 * commits at once with the modifiers held. A lone LEFT modifier records as the
 * generic one ("alt": either Alt, as before); a lone RIGHT one as itself
 * ("altright"), which is also what AltGr records as (Windows sends a fake Left
 * Ctrl with it; that is dropped).
 */
export function createHoldKeyRecorder(onDone: (combo: string) => void, opts: { isMac?: boolean } = {}) {
    const isMac = opts.isMac ?? platformName() === 'mac';
    const held = new Set<string>();    // modifier codes down (lowercased)
    let altGr = false;
    let pending: string | null = null;

    const heldModifierTokens = (): string[] => {
        const codes = [...held].filter(c => !(altGr && c === 'controlleft'));
        const generic = new Set<string>();
        for (const c of codes) {
            const g = MODIFIER_CODES[c];
            if (!g) continue;
            if (altGr && c === 'altright') continue;
            generic.add(isMac && g === 'meta' ? 'ctrl' : g);
        }
        const out = GENERIC_MODIFIERS.filter(m => generic.has(m)) as string[];
        if (altGr && held.has('altright')) out.push('altright');
        return out;
    };
    const bareToken = (): string | null => {
        const codes = [...held].filter(c => !(altGr && c === 'controlleft'));
        if (codes.length !== 1) { const m = heldModifierTokens(); return m.length ? m.join('+') : null; }
        const c = codes[0];
        if (c.endsWith('right')) return isMac && c === 'metaright' ? 'ctrl' : c;
        const g = MODIFIER_CODES[c];
        return g ? (isMac && g === 'meta' ? 'ctrl' : g) : null;
    };

    return {
        keydown(e: KeyLike): void {
            const code = e.code?.toLowerCase();
            if (isModifierEvent(e)) {
                if (!code) { pending = flagModifiers(e, isMac).join('+') || null; return; }   // no code: the old rule
                if (e.key === 'AltGraph') altGr = true;
                held.add(e.key === 'AltGraph' ? 'altright' : code);
                pending = bareToken();
                return;
            }
            pending = null;
            const main = physicalTokenOfCode(e.code) ?? legacyTokenOfKey(e.key);
            const mods = held.size ? heldModifierTokens() : flagModifiers(e, isMac);
            if (!main) return;
            onDone([...mods, main].join('+'));
        },
        keyup(e: Pick<KeyboardEvent, 'key'> & { code?: string }): void {
            const code = e.code?.toLowerCase();
            const wasModifier = isModifierEvent({ ...e, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
            if (wasModifier && pending) {
                const c = pending;
                pending = null;
                held.clear(); altGr = false;
                onDone(c);
                return;
            }
            if (code) held.delete(e.key === 'AltGraph' ? 'altright' : code);
            if (e.key === 'AltGraph') altGr = false;
        },
        /** true when the click was taken as the key (the caller then stops it from doing anything else). */
        mousedown(e: MouseLike): boolean {
            const token = MOUSE_BUTTON_TOKEN[e.button];
            if (!token) return false;
            pending = null;
            const mods = held.size ? heldModifierTokens() : flagModifiers(e, isMac);
            onDone([...mods, token].join('+'));
            return true;
        },
    };
}

// ── Matching in the focused window ───────────────────────────────────────────

/** The tracker's id for a key event: its code (AltGr = altright), or a stand-in when the event has none. */
function inputCodeOf(e: Pick<KeyboardEvent, 'key'> & { code?: string }): string {
    if (e.key === 'AltGraph') return 'altright';
    if (e.code) return e.code.toLowerCase();
    const k = e.key.toLowerCase();
    if (k === 'control') return 'controlleft';
    if (k === 'alt' || k === 'shift' || k === 'meta') return `${k}left`;
    return `key:${k}`;
}

/**
 * What is held right now, from the window's key and mouse events, and whether a
 * combo (either vocabulary) is satisfied. Fed by keydown/keyup/mousedown/mouseup;
 * clear() on blur (a release in another window is never seen here).
 */
export class HeldInputs {
    private readonly codes = new Set<string>();          // physical tokens / mouse tokens
    private readonly legacy = new Map<string, string>(); // code -> the legacy token its key produced

    private readonly isMac: boolean;
    constructor(isMac = platformName() === 'mac') { this.isMac = isMac; }

    keydown(e: KeyLike): void {
        const k = inputCodeOf(e);
        this.codes.add(k);
        if (!isModifierEvent(e)) this.legacy.set(k, legacyTokenOfKey(e.key));
    }
    keyup(e: Pick<KeyboardEvent, 'key'> & { code?: string }): void {
        const k = inputCodeOf(e);
        this.codes.delete(k);
        this.legacy.delete(k);
        // The key that went down may have been spelled differently (Shift released first: "!" down, "1" up).
        if (!e.code) { for (const [c, t] of this.legacy) if (t === legacyTokenOfKey(e.key)) this.legacy.delete(c); }
    }
    mousedown(e: Pick<MouseEvent, 'button'>): void { const t = MOUSE_BUTTON_TOKEN[e.button]; if (t) this.codes.add(t); }
    mouseup(e: Pick<MouseEvent, 'button'>): void { const t = MOUSE_BUTTON_TOKEN[e.button]; if (t) this.codes.delete(t); }
    clear(): void { this.codes.clear(); this.legacy.clear(); }

    private genericHeld(m: string): boolean {
        for (const c of this.codes) {
            const g = MODIFIER_CODES[c];
            if (!g) continue;
            if (g === m || (this.isMac && m === 'ctrl' && g === 'meta')) return true;
        }
        return false;
    }

    /** Is every token of `combo` held? Extra keys held as well do not matter (a game's WASD while talking). */
    isHeld(combo: string | null | undefined): boolean {
        if (!combo) return false;
        const parts = combo.toLowerCase().split('+');
        if (parts.length === 0) return false;
        const legacyHeld = new Set(this.legacy.values());
        return parts.every((p) => {
            if ((GENERIC_MODIFIERS as readonly string[]).includes(p)) return this.genericHeld(p);
            if (this.codes.has(p)) return true;
            return legacyHeld.has(p);
        });
    }
}

// ── What the watcher said, for the user ──────────────────────────────────────

export type HoldKeyFocusReason =
    | 'unsupported-os' | 'xwayland' | 'no-watcher' | 'unmapped-key'
    | 'wayland-modifier' | 'wayland-mouse' | 'wayland-key' | 'wayland-not-bound' | 'failed';
const REASONS: readonly HoldKeyFocusReason[] = ['unsupported-os', 'xwayland', 'no-watcher', 'unmapped-key', 'wayland-modifier', 'wayland-mouse', 'wayland-key', 'wayland-not-bound', 'failed'];

export type HoldKeySupport =
    | { status: 'ok'; backend: string }
    | { status: 'focused-only'; backend: string; reason: HoldKeyFocusReason };

/** Main's hold-key:check reply (electron/global-ptt.ts holdKeySupport), validated. */
export function parseHoldKeySupport(raw: unknown): HoldKeySupport | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const backend = typeof r.backend === 'string' && /^[a-z0-9]{1,12}$/.test(r.backend) ? r.backend : 'none';
    if (r.status === 'ok') return { status: 'ok', backend };
    if (r.status === 'focused-only' && typeof r.reason === 'string' && (REASONS as readonly string[]).includes(r.reason)) {
        return { status: 'focused-only', backend, reason: r.reason as HoldKeyFocusReason };
    }
    return null;
}

/** A live hold-key:set result as a support value (mirrors global-ptt.ts supportFromResult). */
export function supportFromSetResult(r: { ok: boolean; watching?: boolean; reason?: string; detail?: string } | null | undefined): HoldKeySupport | null {
    if (!r) return null;
    if (r.ok && r.watching) return { status: 'ok', backend: 'native' };
    const detail = r.detail && (REASONS as readonly string[]).includes(r.detail) ? r.detail as HoldKeyFocusReason : null;
    const reason: HoldKeyFocusReason = detail ?? (r.reason === 'bad-key' ? 'unmapped-key' : r.reason === 'unsupported' ? 'no-watcher' : 'failed');
    return { status: 'focused-only', backend: 'unknown', reason };
}

/** The sentence after "Only works while Cipherline is focused:". */
const REASON_COPY: Readonly<Record<HoldKeyFocusReason, string>> = {
    'unsupported-os': 'macOS does not let Cipherline watch keys while another app is in front.',
    xwayland: 'on this Wayland desktop Cipherline runs through XWayland, which cannot see keys pressed in other windows.',
    'no-watcher': 'this version of Cipherline cannot watch keys in the background. Updating should fix it.',
    'unmapped-key': 'this key was set by an older version and cannot be watched in the background. Click the key and press it again.',
    'wayland-modifier': 'your desktop’s shortcut system cannot use a modifier on its own. Pick a key, or a combo such as Ctrl+Space.',
    'wayland-mouse': 'your desktop’s shortcut system cannot use mouse buttons. Pick a keyboard key.',
    'wayland-key': 'your desktop’s shortcut system cannot use this key. Pick a letter, a number or an F key (with Ctrl, Alt or Shift if you like).',
    'wayland-not-bound': 'your desktop has not allowed this shortcut. Allow it when your desktop asks, or set it in your desktop’s shortcut settings.',
    failed: 'Cipherline could not watch keys in the background on this system.',
};

export const HOLD_KEY_FOCUSED_ONLY_TITLE = 'Only works while Cipherline is focused';

/** The settings / keybinds line for a support value, or null when the key works everywhere. */
export function holdKeyFocusNote(s: HoldKeySupport | null): string | null {
    if (!s || s.status === 'ok') return null;
    return `${HOLD_KEY_FOCUSED_ONLY_TITLE}: ${REASON_COPY[s.reason]}`;
}

/** Shown (Windows) when the focused game runs as administrator and Cipherline does not. */
export const ELEVATED_GAME_HINT = 'This game runs as administrator — start Cipherline as administrator too for push to talk to work in it.';

/** Static help line for the push-to-talk row on Windows (the detection needs a call to be running). */
export const ELEVATED_GAME_HELP = 'If a game runs as administrator, Windows hides your key presses from Cipherline while it is in front: start Cipherline as administrator too.';
