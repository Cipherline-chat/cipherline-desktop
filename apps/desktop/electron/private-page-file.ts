/**
 * A short-lived local HTML page for a window that must load from `file://`
 * (the installer/update splash needs a real origin for its font @import; the
 * annotation overlay page is generated at runtime).
 *
 * These used to be written to a PREDICTABLE name directly in the shared temp
 * directory (`<tmp>/cipherline-installer-<pid>.html`), with default
 * permissions and no exclusive-create flag. On a multi-user machine another
 * local user could pre-create or swap that file and have their HTML loaded
 * into one of our windows. Now each page lives in its own freshly created
 * private directory (mkdtemp: random name, mode 0700), is created exclusively
 * (`wx`, 0600), and the whole directory is removed once the page has loaded.
 *
 * No `electron` import (unit-testable).
 */

import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';

export interface PrivatePage {
    /** Absolute path of the page, for `loadFile`. */
    filePath: string;
    /** Remove the page and its directory. Idempotent, never throws. */
    cleanup(): void;
}

export interface PrivatePageDeps {
    fs?: Pick<typeof nodeFs, 'mkdtempSync' | 'writeFileSync' | 'rmSync' | 'chmodSync'>;
    tmpdir?: () => string;
}

export function writePrivatePage(prefix: string, html: string, deps: PrivatePageDeps = {}): PrivatePage {
    const fs = deps.fs ?? nodeFs;
    const tmp = (deps.tmpdir ?? nodeOs.tmpdir)();
    const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'cl-page';
    const dir = fs.mkdtempSync(nodePath.join(tmp, `${safePrefix}-`));
    let done = false;
    const cleanup = () => {
        if (done) return;
        done = true;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
    try {
        // mkdtemp already creates 0700 on POSIX; make it explicit regardless of umask.
        try { fs.chmodSync(dir, 0o700); } catch { /* Windows: ACLs, not modes */ }
        const filePath = nodePath.join(dir, 'page.html');
        fs.writeFileSync(filePath, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return { filePath, cleanup };
    } catch (e) {
        cleanup();
        throw e;
    }
}
