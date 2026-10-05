/**
 * tray.ts — System-tray icon with enhanced context menu.
 *
 * Menu structure:
 *   Show Cipherline
 *   ────────────────
 *   Status ▶  ● Online
 *             ○ Idle
 *             ○ Do Not Disturb
 *             ○ Invisible
 *   ☑ Pause notifications
 *   ────────────────
 *   Lock            (only when a Screen Lock PIN is configured)
 *   Quit Cipherline
 *
 * The tray object is kept as a module-level singleton so callers can call
 * updateTray() and updateTrayMenu() from main.ts without managing the ref.
 */

import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { showAndFocusWindow as raiseWindow } from './window-focus';

let tray: Tray | null = null;

// P2-ELEC-16: Keep a fresh reference to the current main window so that the
// tray double-click and menu-item callbacks always target the live BrowserWindow,
// not a stale reference captured at tray-creation time.
let _winRef: BrowserWindow | null = null;

function safeWin(): BrowserWindow | null {
    return _winRef && !_winRef.isDestroyed() ? _winRef : null;
}

/** Un-minimize, show, raise, and focus the live window — shared by the "Show
 *  Cipherline" menu item, a single click, and a double-click on the tray
 *  icon, so all three behave identically.
 *
 *  Delegates to the shared helper so a tray click and a second app launch use
 *  the exact same sequence. The local version used to stop at focus(), which
 *  on Windows restores the window *behind* whatever is in the foreground —
 *  clicking the tray icon appeared to do nothing. */
function showAndFocusWindow(): void {
    raiseWindow(safeWin());
}

// ── Tray icon builder ─────────────────────────────────────────────────────────
// Renders the mascot as a flat 1024×1024 SVG (pre-computed coordinates from
// translate(-82,15) scale(10.8) — no nested transforms, avoids renderer
// ambiguity) then scales to 22×22.  Six variants are lazy-cached:
//
//   clean          — mascot only, no indicator
//   unread         — mascot + red (#FF6B5E) dot
//   call-silent    — mascot + dim teal dot
//   call-speaking  — mascot + bright teal (#25E0C8) dot
//   call-muted     — amber mic-with-slash icon (NO mascot)
//   call-deafened  — purple headphone-with-slash icon (NO mascot)
//
// Priority (highest first):
//   call-deafened > call-muted > call-speaking > call-silent > unread > clean
//
// Dot geometry: cx=960,cy=960,r=130 in the 1024-unit space → ~2.8px radius at
// 22px; bottom-right corner, just outside the new larger bar footprint.
type TrayIconVariant = 'clean' | 'unread' | 'call-silent' | 'call-speaking' | 'call-muted' | 'call-deafened';

const _iconCache: Partial<Record<TrayIconVariant, Electron.NativeImage>> = {};

// Live state — updated by setTrayBadgeIcon / setTrayCallState.
let _unreadCount  = 0;
let _inCall       = false;
let _isSpeaking   = false;
let _isMuted      = false;
let _isDeafened   = false;

function resolveVariant(): TrayIconVariant {
    if (_inCall) {
        if (_isDeafened) return 'call-deafened';
        if (_isMuted)    return 'call-muted';
        return _isSpeaking ? 'call-speaking' : 'call-silent';
    }
    return _unreadCount > 0 ? 'unread' : 'clean';
}

// Two-tone slash: dark (#0B0F1E) border + white inner — reads on both light
// and dark menu bars / notification areas.
const SLASH_DARK = 115;
const SLASH_WHITE = 75;
const SLASH_PATH = 'x1="300" y1="100" x2="724" y2="950"';

function buildMicSlashSvg(): string {
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 1024 1024">' +
        // Amber mic body (centered capsule)
        '<rect x="387" y="175" width="250" height="380" rx="125" fill="#F59E0B"/>' +
        // Stand arc (U-shape below the mic)
        '<path d="M250 555 A262 262 0 0 1 774 555" fill="none" stroke="#F59E0B" stroke-width="80" stroke-linecap="round"/>' +
        // Post
        '<line x1="512" y1="817" x2="512" y2="905" stroke="#F59E0B" stroke-width="75" stroke-linecap="round"/>' +
        // Base
        '<line x1="340" y1="905" x2="684" y2="905" stroke="#F59E0B" stroke-width="75" stroke-linecap="round"/>' +
        // Slash: dark border then white inner
        `<line ${SLASH_PATH} stroke="#0B0F1E" stroke-width="${SLASH_DARK}" stroke-linecap="round"/>` +
        `<line ${SLASH_PATH} stroke="white" stroke-width="${SLASH_WHITE}" stroke-linecap="round"/>` +
        '</svg>'
    );
}

function buildHeadphoneSlashSvg(): string {
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 1024 1024">' +
        // Headband arc (inverted U over the head)
        '<path d="M170 560 A342 342 0 0 0 854 560" fill="none" stroke="#A855F7" stroke-width="90" stroke-linecap="round"/>' +
        // Left ear cup
        '<rect x="100" y="510" width="175" height="270" rx="88" fill="#A855F7"/>' +
        // Right ear cup
        '<rect x="749" y="510" width="175" height="270" rx="88" fill="#A855F7"/>' +
        // Slash: dark border then white inner
        `<line ${SLASH_PATH} stroke="#0B0F1E" stroke-width="${SLASH_DARK}" stroke-linecap="round"/>` +
        `<line ${SLASH_PATH} stroke="white" stroke-width="${SLASH_WHITE}" stroke-linecap="round"/>` +
        '</svg>'
    );
}

function makeTrayIcon(variant: TrayIconVariant): Electron.NativeImage {
    let svg: string;
    if (variant === 'call-muted') {
        svg = buildMicSlashSvg();
    } else if (variant === 'call-deafened') {
        svg = buildHeadphoneSlashSvg();
    } else {
        let dot = '';
        if (variant === 'unread') {
            dot = '<circle cx="960" cy="960" r="130" fill="#FF6B5E"/>';
        } else if (variant === 'call-speaking') {
            dot = '<circle cx="960" cy="960" r="130" fill="#25E0C8"/>';
        } else if (variant === 'call-silent') {
            dot = '<circle cx="960" cy="960" r="130" fill="#25E0C8" fill-opacity="0.22"/>';
        }
        svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 1024 1024">' +
            '<rect x="89.5" y="486" width="169" height="442" rx="84.5" fill="#25E0C8"/>' +
            '<rect x="314.4" y="486" width="169" height="442" rx="84.5" fill="#25E0C8"/>' +
            '<rect x="539.3" y="486" width="169" height="442" rx="84.5" fill="#25E0C8"/>' +
            '<rect x="764.2" y="486" width="169" height="442" rx="84.5" fill="#25E0C8"/>' +
            '<path d="M70 538 A442 442 0 0 1 954 538 L954 603 L70 603 Z" fill="#25E0C8"/>' +
            dot +
            '</svg>';
    }
    try {
        const img = nativeImage.createFromDataURL(
            'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
        );
        if (!img.isEmpty()) return img;
    } catch { /* fall through */ }
    return nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
}

/** Read the current call state — used by badge.ts to gate the Windows overlay. */
export function getCallState(): { inCall: boolean; isSpeaking: boolean; isMuted: boolean; isDeafened: boolean } {
    return { inCall: _inCall, isSpeaking: _isSpeaking, isMuted: _isMuted, isDeafened: _isDeafened };
}

function buildTrayIcon(variant: TrayIconVariant): Electron.NativeImage {
    if (!_iconCache[variant]) _iconCache[variant] = makeTrayIcon(variant);
    return _iconCache[variant]!;
}

function resolveTip(): string {
    if (_inCall) {
        if (_isDeafened) return 'Cipherline · Deafened';
        if (_isMuted)    return 'Cipherline · Muted';
        return _isSpeaking ? 'Cipherline · Speaking' : 'Cipherline · In a call';
    }
    return _unreadCount > 0 ? `Cipherline · ${_unreadCount} unread` : 'Cipherline';
}

function applyTrayIcon(): void {
    if (!tray) return;
    try {
        tray.setImage(buildTrayIcon(resolveVariant()));
        tray.setToolTip(resolveTip());
    } catch {}
}

/** Called by badge.ts whenever the unread count changes. */
export function setTrayBadgeIcon(count: number): void {
    _unreadCount = count;
    applyTrayIcon();
}

/**
 * Called by the main-process IPC handler for 'tray:call-speaking'.
 * Drives all six tray icon variants: deafened > muted > speaking > silent > unread > clean.
 */
export function setTrayCallState(
    inCall: boolean,
    isSpeaking: boolean,
    isMuted: boolean,
    isDeafened: boolean,
): void {
    _inCall      = inCall;
    _isSpeaking  = isSpeaking;
    _isMuted     = isMuted;
    _isDeafened  = isDeafened;
    applyTrayIcon();
}

export interface TrayMenuState {
    unreadCount: number;
    /** Computed DND (manual + schedule + auto-triggers) — for tooltip / future use. */
    dndActive: boolean;
    /** The manual "pause notifications" toggle specifically — drives the checkbox. */
    dndManual: boolean;
    status: 'online' | 'away' | 'dnd' | 'offline';
    /** True when a Screen Lock PIN is set, so "Lock" is worth offering.
     *  Pushed from the renderer — see the menu comment for why. */
    screenLockAvailable?: boolean;
}

function getIconPath(): string {
    const devPath = path.join(__dirname, '../build-assets/icon.png');
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath, 'icon.png');
}

function buildMenu(
    state: TrayMenuState,
    isQuittingRef: { value: boolean },
): Electron.Menu {
    const { dndManual, status, screenLockAvailable } = state;

    const STATUS_LABELS: Record<string, string> = {
        online:  'Online',
        away:    'Idle / Away',
        dnd:     'Do Not Disturb',
        offline: 'Invisible',
    };

    const statusItems: Electron.MenuItemConstructorOptions[] =
        (['online', 'away', 'dnd', 'offline'] as const).map(s => ({
            label: STATUS_LABELS[s],
            type: 'radio' as const,
            checked: status === s,
            click: () => {
                safeWin()?.webContents.send('tray:set-status', s);
            },
        }));

    return Menu.buildFromTemplate([
        {
            label: 'Show Cipherline',
            click: showAndFocusWindow,
        },
        { type: 'separator' },
        {
            label: 'Status',
            submenu: statusItems,
        },
        {
            label: 'Pause notifications',
            type: 'checkbox',
            checked: dndManual,
            click: (menuItem) => {
                safeWin()?.webContents.send('tray:toggle-dnd', menuItem.checked);
            },
        },
        // "Lock" only appears when a Screen Lock PIN is actually configured —
        // an always-present Lock that silently did nothing would be worse than
        // no entry at all. The main process can't check for itself: the PIN
        // verifier lives in secureLocalStore, which is the renderer's
        // encrypted IndexedDB, so the renderer pushes this flag in with the
        // rest of the tray state.
        //
        // Sign out used to sit here. It was one unguarded click away from
        // dropping the session, right next to Quit — and unlike Quit it isn't
        // recoverable by reopening the app. Signing out lives in Settings,
        // where it can ask.
        ...(screenLockAvailable ? [
            { type: 'separator' as const },
            {
                label: 'Lock',
                click: () => {
                    safeWin()?.webContents.send('tray:lock');
                },
            },
        ] : []),
        {
            label: 'Quit Cipherline',
            click: () => {
                isQuittingRef.value = true;
                app.quit();
            },
        },
    ]);
}

/** Create or destroy the tray icon based on the `enabled` flag. */
export function setupTray(
    enabled: boolean,
    win: BrowserWindow,
    isQuittingRef: { value: boolean },
    initialState: TrayMenuState = { unreadCount: 0, dndActive: false, dndManual: false, status: 'online' },
): void {
    _winRef = win; // keep the module-level ref fresh for menu callbacks
    if (enabled && !tray) {
        try {
            _unreadCount = initialState.unreadCount;
            tray = new Tray(buildTrayIcon(resolveVariant()));
            tray.setToolTip(resolveTip());
            tray.setContextMenu(buildMenu(initialState, isQuittingRef));
            // A left-click with setContextMenu() active would otherwise just pop
            // the menu (Windows convention) — registering 'click' here makes a
            // single click show the window instead, matching Discord/Slack.
            // Right-click still opens the context menu (setContextMenu's own
            // default binding, independent of 'click'). 'double-click' is kept
            // too since some platforms/users still double-click tray icons out
            // of habit — both call the same handler.
            tray.on('click', showAndFocusWindow);
            tray.on('double-click', showAndFocusWindow);
        } catch (err) {
            console.warn('[Tray] Failed to create tray icon:', err);
        }
    } else if (!enabled && tray) {
        tray.destroy();
        tray = null;
    }
}

/**
 * Rebuild the context menu with fresh state. Called whenever unread count,
 * DND state, or user status changes.
 */
export function updateTrayMenu(
    state: TrayMenuState,
    win: BrowserWindow,
    isQuittingRef: { value: boolean },
): void {
    _winRef = win; // keep the ref fresh so menu callbacks always reach the live window
    if (!tray) return;
    try {
        tray.setContextMenu(buildMenu(state, isQuittingRef));
        _unreadCount = state.unreadCount;
        applyTrayIcon();
    } catch {}
}

export function getTray(): Tray | null {
    return tray;
}

export function destroyTray(): void {
    if (tray) { tray.destroy(); tray = null; }
}
