import * as nodeFs from 'fs';
import * as nodePath from 'path';

/**
 * "The wallet already answered this boot": decides whether a launch needs the
 * pre-announcement window at all.
 *
 * That window has to be created and painted before the first, blocking,
 * safeStorage call (see keyring-notice.ts), which costs a renderer process and
 * ~150 ms on EVERY Linux launch. But the wallet only asks for its password
 * once per login: after it has answered "unlocked" the later launches of the
 * same boot get an instant answer. So after an unlocked first call we leave a
 * marker (the kernel's boot id, nothing else), and a launch that finds a marker
 * for THIS boot skips the window. A reboot changes the boot id; a refused or
 * missing wallet clears the marker, so the next launch announces again.
 *
 * The trade: a wallet that re-locks mid-boot (a KWallet idle-close timeout)
 * asks without our explanation once. The OS dialog still appears and a refusal
 * is still caught by the safeguards in keyring-prompt.ts; only the preamble is
 * skipped.
 *
 * Contains no secret, only the boot id. No `electron` import (unit-testable).
 */

const MARKER_FILE = 'keyring-unlocked.json';
const BOOT_ID = /^[0-9a-f-]{32,40}$/;

export interface KeyringMarker { bootId: string }

export function readBootId(read: (p: string) => string = p => nodeFs.readFileSync(p, 'utf8')): string | null {
    try {
        const id = read('/proc/sys/kernel/random/boot_id').trim().toLowerCase();
        return BOOT_ID.test(id) ? id : null;
    } catch {
        return null;
    }
}

export function parseMarker(text: string | null): KeyringMarker | null {
    if (!text) return null;
    try {
        const v = JSON.parse(text) as unknown;
        if (typeof v !== 'object' || v === null) return null;
        const id = (v as { bootId?: unknown }).bootId;
        return typeof id === 'string' && BOOT_ID.test(id) ? { bootId: id } : null;
    } catch {
        return null;
    }
}

/** Announce unless we KNOW this boot's wallet already answered. Unknown boot id = announce. */
export function shouldPreannounce(bootId: string | null, marker: KeyringMarker | null): boolean {
    if (!bootId) return true;
    return !(marker && marker.bootId === bootId);
}

export function readMarker(dir: string, fs: Pick<typeof nodeFs, 'readFileSync'> = nodeFs): KeyringMarker | null {
    try { return parseMarker(fs.readFileSync(nodePath.join(dir, MARKER_FILE), 'utf8')); } catch { return null; }
}

export function writeMarker(dir: string, bootId: string | null, fs: Pick<typeof nodeFs, 'writeFileSync'> = nodeFs): void {
    if (!bootId) return;
    try { fs.writeFileSync(nodePath.join(dir, MARKER_FILE), JSON.stringify({ bootId }), { mode: 0o600 }); } catch { /* cosmetic: worst case we announce again */ }
}

export function clearMarker(dir: string, fs: Pick<typeof nodeFs, 'rmSync'> = nodeFs): void {
    try { fs.rmSync(nodePath.join(dir, MARKER_FILE), { force: true }); } catch { /* same */ }
}
