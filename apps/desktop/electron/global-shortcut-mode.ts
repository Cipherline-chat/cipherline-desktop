/**
 * Which way a global (works-while-unfocused) shortcut can be delivered on THIS
 * session, decided once, purely, from facts main already has.
 *
 * Why this exists: "leave call" and "toggle camera" must work while another
 * window has focus (a game, a browser). How an app asks the OS for that depends
 * on the display server, and on Linux Wayland it depends on a desktop service
 * Electron cannot assume:
 *
 *   native       Windows (RegisterHotKey), macOS (Carbon) and Linux X11
 *                (XGrabKey). Electron's `globalShortcut` is the whole story and
 *                nothing here changes it. `register()` returning false means the
 *                combo is taken by another app, and the renderer's focused-window
 *                listener covers that action.
 *   portal       Linux, native Wayland client, and the desktop answers
 *                `org.freedesktop.portal.GlobalShortcuts` (KDE Plasma 5.27+/6,
 *                GNOME 48+, Hyprland). Delivered by wayland-global-shortcuts.ts,
 *                NOT by Electron's `globalShortcut`: Chromium's own portal
 *                backend is already compiled in and active in Electron 43.8.1
 *                (no feature switch is needed or added), but it never gets an
 *                application id from xdg-desktop-portal, so the portal refuses
 *                it ("An app id is required") while `register()` still returns
 *                true. On Wayland `globalShortcut` is therefore never called.
 *   unavailable  Linux, native Wayland client, no GlobalShortcuts portal (older
 *                GNOME, sway, most wlroots compositors). Wayland has no way for
 *                a client to grab a key globally, so `globalShortcut` silently
 *                does nothing. The honest outcome is to say so in Settings and
 *                keep the focused-window listener working.
 *
 * The portal can only be asked at runtime (a D-Bus read, bounded by a timeout,
 * never on the main thread's critical path): global-shortcut-portal.ts.
 */

import { isNativeWaylandClient } from './capture-flags';

export type GlobalShortcutMode = 'native' | 'portal' | 'unavailable';

/** What the portal probe found. `unknown` = no answer in time (treated as absent: never block on it). */
export type PortalProbeResult = 'present' | 'absent' | 'unknown';

/** Reason vocabulary shown in Settings (fixed strings only: nothing from the environment is copied into it). */
export type GlobalShortcutReason =
    | 'native-os'            // Windows / macOS
    | 'x11'                  // Linux X11 (or XWayland: an X11 client)
    | 'wayland-portal'       // Wayland + GlobalShortcuts portal
    | 'wayland-no-portal'    // Wayland, the desktop has no GlobalShortcuts portal
    | 'wayland-portal-unanswered' // Wayland, the portal probe timed out
    | 'wayland-portal-error'      // Wayland, the portal is there but would not set up a session
    | 'wayland-portal-declined';  // Wayland, the user cancelled the desktop's permission dialog

export interface GlobalShortcutDecision {
    mode: GlobalShortcutMode;
    reason: GlobalShortcutReason;
}

export interface GlobalShortcutStatus extends GlobalShortcutDecision {
    /** Linux desktop name for the message ("KDE", "GNOME"...), sanitised; '' when unknown. */
    desktop: string;
    /**
     * Wayland portal sessions only: what the desktop REALLY bound once the session was set up. "The
     * portal answered" is not "keys are assigned": xdg-desktop-portal-hyprland accepts the request and
     * assigns nothing until the user binds the shortcut in hyprland.conf (log: `bound 0, not granted 7`),
     * and a KDE/GNOME dialog lets the user clear individual keys. Settings tells the truth from this.
     * Action ids only (our own fixed vocabulary), never anything from the environment.
     */
    portal?: {
        bound: string[]; notBound: string[];
        /** The desktop's own name for each bound key (trigger_description), and the bound actions whose key is NOT the one asked for. */
        desktopKeys?: Record<string, string>; elsewhere?: string[];
    };
    /** The id the portal knows us by (what a compositor config refers to). Only with `portal`. */
    appId?: string;
}

/** Adds the portal's real result to a status; unchanged when the session never got that far. */
export function withPortalResult(
    status: GlobalShortcutStatus,
    setup: { ok: true; granted: string[]; denied: string[]; triggers?: Record<string, string>; elsewhere?: string[] } | { ok: false },
    appId: string,
): GlobalShortcutStatus {
    if (status.mode !== 'portal' || !setup.ok) return status;
    return {
        ...status, appId,
        portal: { bound: [...setup.granted], notBound: [...setup.denied], desktopKeys: { ...(setup.triggers ?? {}) }, elsewhere: [...(setup.elsewhere ?? [])] },
    };
}

export function decideGlobalShortcutMode(
    platform: string,
    env: Readonly<Record<string, string | undefined>>,
    ozonePlatform: string,
    portal: PortalProbeResult,
): GlobalShortcutDecision {
    if (platform !== 'linux') return { mode: 'native', reason: 'native-os' };
    if (!isNativeWaylandClient(env, ozonePlatform)) return { mode: 'native', reason: 'x11' };
    if (portal === 'present') return { mode: 'portal', reason: 'wayland-portal' };
    return {
        mode: 'unavailable',
        reason: portal === 'unknown' ? 'wayland-portal-unanswered' : 'wayland-no-portal',
    };
}

/** The decision, corrected by what actually happened when the portal session was set up. */
export function statusAfterPortalSetup(
    decision: GlobalShortcutDecision,
    setup: { ok: true } | { ok: false; reason: 'unavailable' | 'declined' | 'error' },
): GlobalShortcutDecision {
    if (decision.mode !== 'portal' || setup.ok) return decision;
    if (setup.reason === 'declined') return { mode: 'unavailable', reason: 'wayland-portal-declined' };
    return { mode: 'unavailable', reason: 'wayland-portal-error' };
}

/** "KDE", "GNOME"... from XDG_CURRENT_DESKTOP, letters only, first entry, 24 chars. */
export function sanitizeDesktopName(raw: string | undefined): string {
    const first = (raw ?? '').split(':')[0] ?? '';
    return first.replace(/[^A-Za-z-]/g, '').slice(0, 24);
}
