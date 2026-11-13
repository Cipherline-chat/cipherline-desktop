/**
 * What Settings → Keybinds says about system-wide (works-while-unfocused)
 * shortcuts. The main process decides how global keys can reach us on this
 * session (electron/global-shortcut-mode.ts) and returns that with the sync
 * result; this turns it into words. Fixed vocabulary only: the reason is one
 * of a closed set of codes, the desktop name is already sanitised by main.
 */

export interface GlobalShortcutStatus {
    mode: 'native' | 'portal' | 'unavailable';
    reason: string;
    /** "KDE", "GNOME"... or '' when unknown. */
    desktop: string;
    /**
     * Wayland portal only: which actions the desktop really bound (ids), and which it did not; the desktop's own
     * name for each bound key; and the bound actions whose key is NOT the one set here (KDE keeps the key it first
     * accepted for a shortcut and ignores a later one, so the key shown in Settings may not be the live one).
     */
    portal?: { bound: string[]; notBound: string[]; desktopKeys?: Record<string, string>; elsewhere?: string[] };
    /** The id the portal knows Cipherline by (what a compositor config refers to). */
    appId?: string;
}

const REASON_TEXT: Record<string, (where: string) => string> = {
    'wayland-no-portal': (where) => `${where} does not offer the global-shortcuts service these keys need.`,
    'wayland-portal-unanswered': () => 'The desktop did not answer the global-shortcuts request in time.',
    'wayland-portal-error': (where) => `${where} refused to set up global shortcuts for Cipherline.`,
    'wayland-portal-declined': () => 'The desktop asked for permission and it was not granted. Restart Cipherline to be asked again.',
};

/** The notice to show, or null when system-wide shortcuts work as the user expects (or main has not answered yet). */
export function globalShortcutNotice(status: GlobalShortcutStatus | null | undefined): string | null {
    if (!status || status.mode !== 'unavailable') return null;
    const where = status.desktop ? `${status.desktop} on Wayland` : 'Wayland';
    const why = (REASON_TEXT[status.reason] ?? REASON_TEXT['wayland-no-portal'])(where);
    return `Global shortcuts aren't available on this desktop; they work while Cipherline is focused. ${why}`;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;
const APP_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

function readIdList(raw: unknown): string[] | null {
    if (!Array.isArray(raw) || raw.length > 32) return null;
    return raw.every((x) => typeof x === 'string' && ID_RE.test(x)) ? (raw as string[]) : null;
}

/** Tolerant reader for the IPC result: anything that is not a well-formed status is "unknown" (null). */
export function readGlobalShortcutStatus(raw: unknown): GlobalShortcutStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.mode !== 'native' && r.mode !== 'portal' && r.mode !== 'unavailable') return null;
    const out: GlobalShortcutStatus = {
        mode: r.mode,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 40) : '',
        desktop: typeof r.desktop === 'string' ? r.desktop.slice(0, 24) : '',
    };
    const p = r.portal as Record<string, unknown> | undefined;
    if (p && typeof p === 'object') {
        const bound = readIdList(p.bound);
        const notBound = readIdList(p.notBound);
        if (bound && notBound) {
            out.portal = { bound, notBound };
            const elsewhere = readIdList(p.elsewhere);
            if (elsewhere) out.portal.elsewhere = elsewhere;
            const dk = p.desktopKeys;
            if (dk && typeof dk === 'object' && !Array.isArray(dk)) {
                const keys: Record<string, string> = {};
                for (const [id, v] of Object.entries(dk as Record<string, unknown>)) {
                    if (ID_RE.test(id) && typeof v === 'string' && v.length > 0 && v.length <= 48) keys[id] = v;
                }
                out.portal.desktopKeys = keys;
            }
        }
    }
    if (typeof r.appId === 'string' && APP_ID_RE.test(r.appId)) out.appId = r.appId;
    return out;
}

// ── The portal answered, but did it assign keys? ─────────────────────────────

/** How many of the keys the user set are really system-wide on this session. */
export type GlobalShortcutCoverage = 'all' | 'some' | 'none' | 'unknown';

/**
 * 'unknown' = main has not answered (or this is not a portal session, where `globalShortcutNotice` already
 * covers it). 'none' for an unavailable session too: nothing is system-wide there.
 */
export function globalShortcutCoverage(status: GlobalShortcutStatus | null | undefined): GlobalShortcutCoverage {
    if (!status) return 'unknown';
    if (status.mode === 'unavailable') return 'none';
    if (status.mode !== 'portal' || !status.portal) return status.mode === 'native' ? 'all' : 'unknown';
    const { bound, notBound } = status.portal;
    if (notBound.length === 0) return 'all';
    return bound.length === 0 ? 'none' : 'some';
}

export interface PortalBindingNotice {
    title: string;
    text: string;
    /** Names of the shortcuts that are NOT system-wide, in the order given. */
    notBound: string[];
    /** True on Hyprland: its portal binds nothing until the user adds lines to hyprland.conf. */
    hyprland: boolean;
    /** Action ids to show hyprland.conf lines for (the ones the desktop did not bind). */
    hyprlandIds: string[];
    /** Action ids bound system-wide to a different key than the one set here (see `portal.elsewhere`). */
    elsewhere?: string[];
}

export function isHyprland(desktop: string): boolean {
    return desktop.toLowerCase() === 'hyprland';
}

function joinNames(names: string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The notice for a portal session that accepted Cipherline but bound fewer keys than the user set, or null
 * when every key is system-wide (or there is nothing to say). `labelOf` turns an action id into its name.
 */
export function portalBindingNotice(
    status: GlobalShortcutStatus | null | undefined,
    labelOf: (id: string) => string,
): PortalBindingNotice | null {
    if (!status || status.mode !== 'portal' || !status.portal) return null;
    const { bound, notBound } = status.portal;
    const where = status.desktop ? `${status.desktop} on Wayland` : 'Wayland';
    const elsewhere = (status.portal.elsewhere ?? []).filter((id) => status.portal?.desktopKeys?.[id]);
    if (notBound.length === 0 && elsewhere.length > 0) {
        // Every shortcut is system-wide, but not all on the keys shown below: the desktop kept the key it was
        // first given (KDE ignores a later one). Name the live key; the desktop's settings are where to change it.
        const desktopKeys = status.portal.desktopKeys ?? {};
        return {
            title: elsewhere.length === 1 ? 'One shortcut uses a different key system-wide' : 'Some shortcuts use different keys system-wide',
            text: `${where} kept the key it was first given for ${joinNames(elsewhere.map((id) => `${labelOf(id)} (${desktopKeys[id]})`))}. `
                + `Outside Cipherline that key works, not the one shown below. Change it in your desktop's shortcut settings to use the key set here.`,
            notBound: [], hyprland: false, hyprlandIds: [], elsewhere: [...elsewhere],
        };
    }
    if (notBound.length === 0) return null;
    const hyprland = isHyprland(status.desktop);
    const missing = notBound.map(labelOf);
    if (bound.length === 0) {
        return {
            title: 'System-wide shortcuts are not set up',
            text: hyprland
                ? `${where} accepted Cipherline's request but assigned no keys: Hyprland leaves that to you. Until you bind them, these shortcuts only work while Cipherline is focused.`
                : `${where} accepted Cipherline's request but assigned no keys, so these shortcuts only work while Cipherline is focused. If a shortcut dialog was cancelled or a key cleared, the desktop remembers that and will not ask again: set the keys in its shortcut settings.`,
            notBound: missing, hyprland, hyprlandIds: [...notBound],
        };
    }
    return {
        title: 'Some shortcuts are not system-wide',
        text: `${where} assigned keys for ${joinNames(bound.map(labelOf))}. ${joinNames(missing)} only ${missing.length === 1 ? 'works' : 'work'} while Cipherline is focused`
            + (hyprland ? '.' : `: the desktop has no key for ${missing.length === 1 ? 'it' : 'them'} (a cleared key or a cancelled dialog is remembered). Set ${missing.length === 1 ? 'it' : 'them'} in your desktop's shortcut settings.`),
        notBound: missing, hyprland, hyprlandIds: [...notBound],
    };
}

// ── Hyprland: the lines the user has to add ──────────────────────────────────

const HYPR_KEYS: Record<string, string> = {
    escape: 'Escape', space: 'space', ',': 'comma', '.': 'period',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
};

/**
 * One of our key combos ("ctrl+shift+m") as Hyprland's `MODS, KEY` pair ("CTRL SHIFT", "M"), or null for a key
 * outside the vocabulary the portal path accepts (the same set electron/wayland-global-shortcuts.ts allows).
 */
export function comboToHyprlandKey(combo: string): { mods: string; key: string } | null {
    const parts = combo.split('+');
    const rawKey = parts[parts.length - 1] ?? '';
    const mods: string[] = [];
    for (const m of parts.slice(0, -1)) {
        if (m === 'ctrl') mods.push('CTRL');
        else if (m === 'alt') mods.push('ALT');
        else if (m === 'shift') mods.push('SHIFT');
        else return null;
    }
    let key = HYPR_KEYS[rawKey];
    if (!key) {
        if (/^f([1-9]|[12]\d|3[0-5])$/.test(rawKey)) key = rawKey.toUpperCase();
        else if (/^[a-z0-9]$/.test(rawKey)) key = rawKey.toUpperCase();
        else return null;
    }
    return { mods: mods.join(' '), key };
}

/**
 * The hyprland.conf lines that make xdg-desktop-portal-hyprland deliver each shortcut:
 * `bind = MODS, KEY, global, <appid>:<shortcut-id>`. `entries` are the user's current combos.
 */
export function hyprlandBindLines(entries: ReadonlyArray<{ id: string; combo: string }>, appId: string): string[] {
    const lines: string[] = [];
    for (const e of entries) {
        const k = comboToHyprlandKey(e.combo);
        if (!k) continue;
        lines.push(`bind = ${k.mods}, ${k.key}, global, ${appId}:${e.id}`);
    }
    return lines;
}
