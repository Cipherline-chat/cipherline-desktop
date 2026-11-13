/**
 * Asks the session bus whether the desktop offers
 * `org.freedesktop.portal.GlobalShortcuts` (the Wayland-safe way to receive a
 * key while another window is focused). Read-only, bounded, asynchronous: it
 * never blocks the main process, never throws, and `unknown` (no answer in
 * time) is a result of its own so a stuck portal cannot stall startup or the
 * Keybinds sync.
 *
 * It reads the interface's `version` property. xdg-desktop-portal exports the
 * GlobalShortcuts interface only when a backend (xdg-desktop-portal-kde,
 * -gnome, -hyprland) implements it, so a successful read means "present" and
 * an UnknownInterface / UnknownProperty / ServiceUnknown error means "absent".
 */

import fs from 'node:fs';
import type { PortalProbeResult } from './global-shortcut-mode';

export const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
export const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
export const PORTAL_GLOBAL_SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
export const PORTAL_PROBE_TIMEOUT_MS = 2500;

/** The one D-Bus call the probe needs; dbus-native in the app, a fake in tests. */
export interface PortalProbeBus {
    /** Resolves with the interface version, rejects with an Error carrying the D-Bus error name in its message. */
    getVersion(): Promise<unknown>;
    close(): void;
}

/** Error names that mean "the portal answered and does not have it". */
const ABSENT_ERROR_RE = /UnknownInterface|UnknownProperty|UnknownObject|UnknownMethod|ServiceUnknown|NameHasNoOwner|NotSupported|InvalidArgs|NoReply.*activat|Spawn\.(ChildExited|ExecFailed|ServiceNotFound)/i;

export function classifyPortalError(message: string): PortalProbeResult {
    return ABSENT_ERROR_RE.test(message) ? 'absent' : 'unknown';
}

export async function probeGlobalShortcutsPortal(
    busFactory: () => PortalProbeBus | null = () => dbusPortalBus(),
    timeoutMs: number = PORTAL_PROBE_TIMEOUT_MS,
): Promise<PortalProbeResult> {
    let bus: PortalProbeBus | null = null;
    try {
        bus = busFactory();
        if (!bus) return 'absent'; // no session bus at all: no portal either
        const b = bus;
        const timeout = new Promise<PortalProbeResult>((resolve) => {
            const t = setTimeout(() => resolve('unknown'), timeoutMs);
            // Do not keep the process alive for a probe.
            (t as { unref?: () => void }).unref?.();
        });
        const ask = b.getVersion().then(
            (v): PortalProbeResult => (typeof v === 'number' || (Array.isArray(v) && v.length > 0) || v != null ? 'present' : 'absent'),
            (e: unknown): PortalProbeResult => classifyPortalError(e instanceof Error ? e.message : String(e)),
        );
        return await Promise.race([ask, timeout]);
    } catch {
        return 'unknown';
    } finally {
        try { bus?.close(); } catch { /* already gone */ }
    }
}

/** dbus-native session bus, or null when there is none. Linux only (lazy require). */
export function dbusPortalBus(env: NodeJS.ProcessEnv = process.env): PortalProbeBus | null {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!env.DBUS_SESSION_BUS_ADDRESS && !(uid >= 0 && fs.existsSync(`/run/user/${uid}/bus`))) return null;
    let bus: {
        invoke: (msg: Record<string, unknown>, cb: (err: unknown, res: unknown) => void) => void;
        connection?: { on?: (ev: string, cb: (e: unknown) => void) => void; end?: () => void };
    };
    let toPlain: (v: unknown) => unknown;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require so dbus-native stays out of the Windows/macOS dependency graph (Linux-only module)
        const dbus = require('dbus-native');
        bus = dbus.sessionBus({ timeout: PORTAL_PROBE_TIMEOUT_MS });
        toPlain = dbus.toPlain;
    } catch {
        return null;
    }
    bus.connection?.on?.('error', () => { /* the pending call fails on its own; never unhandled */ });
    return {
        getVersion: () => new Promise((resolve, reject) => {
            bus.invoke({
                destination: PORTAL_BUS_NAME, path: PORTAL_OBJECT_PATH,
                interface: 'org.freedesktop.DBus.Properties', member: 'Get',
                signature: 'ss', body: [PORTAL_GLOBAL_SHORTCUTS_IFACE, 'version'],
            }, (err, res) => {
                if (err) reject(new Error(typeof err === 'string' ? err : (err as { message?: string; name?: string }).message ?? (err as { name?: string }).name ?? String(err)));
                else resolve(toPlain(res));
            });
        }),
        close: () => { try { bus.connection?.end?.(); } catch { /* gone */ } },
    };
}
