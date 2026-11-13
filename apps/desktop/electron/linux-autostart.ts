/**
 * linux-autostart.ts — one XDG autostart entry, whichever packaging wrote it.
 *
 * The bug: the AppImage and the .deb are separate installs, and an entry the
 * AppImage wrote (Exec = /home/u/Cipherline-x.AppImage, or an older filename)
 * stayed behind when the .deb took over, so the app launched twice at login.
 * Every write now finds the entries OUR app wrote under any other filename and
 * folds them into the single `cipherline.desktop` pointing at the running
 * install. No `electron` import: the fs is injected, see linux-autostart.test.ts.
 *
 * "Ours" is deliberately narrow: the `X-Cipherline-Managed` key, or an Exec whose
 * program is our .deb binary (`cipherline`) or a `cipherline*.AppImage`. A user's
 * own entry for some other program is never read as ours.
 */
import path from 'node:path';
import {
    XDG_AUTOSTART_FILENAME, MANAGED_KEY, buildXdgDesktopEntry, desktopEntryValue,
    interpretXdgEntry, xdgEntryNeedsRewrite,
} from './login-item';

export interface AutostartFs {
    readdirSync(dir: string): string[];
    readFileSync(file: string, enc: 'utf8'): string;
    writeFileSync(file: string, data: string, opts?: { mode?: number }): void;
    renameSync(from: string, to: string): void;
    unlinkSync(file: string): void;
    mkdirSync(dir: string, opts?: { recursive: boolean }): void;
}

/** First word of an Exec= value (honours the spec's double quoting). */
export function execProgram(exec: string | undefined): string | null {
    if (!exec) return null;
    const t = exec.trim();
    if (t.startsWith('"')) {
        let out = '';
        for (let i = 1; i < t.length; i++) {
            if (t[i] === '\\' && i + 1 < t.length) { out += t[++i]; continue; }
            if (t[i] === '"') return out;
            out += t[i];
        }
        return null;
    }
    return t.split(/\s+/)[0] || null;
}

/** Is this autostart file one this app wrote (under any name)? */
export function isOurAutostartEntry(content: string): boolean {
    if ((desktopEntryValue(content, MANAGED_KEY) ?? '').toLowerCase() === 'true') return true;
    const prog = execProgram(desktopEntryValue(content, 'Exec'));
    if (!prog) return false;
    const base = path.posix.basename(prog).toLowerCase();
    return base === 'cipherline' || /^cipherline[^/]*\.appimage$/.test(base);
}

function safeRead(fsApi: AutostartFs, file: string): string | null {
    try { return fsApi.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Autostart files of ours other than `ownFile` (name -> content). */
export function findOtherOwnEntries(fsApi: AutostartFs, dir: string, ownFile = XDG_AUTOSTART_FILENAME): Map<string, string> {
    const found = new Map<string, string>();
    let names: string[] = [];
    try { names = fsApi.readdirSync(dir); } catch { return found; }
    for (const name of names) {
        if (name === ownFile || !name.endsWith('.desktop')) continue;
        const content = safeRead(fsApi, path.join(dir, name));
        if (content !== null && isOurAutostartEntry(content)) found.set(name, content);
    }
    return found;
}

function removeQuiet(fsApi: AutostartFs, file: string): void {
    try { fsApi.unlinkSync(file); } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
}

function writeOwn(fsApi: AutostartFs, dir: string, exec: string[]): void {
    const file = path.join(dir, XDG_AUTOSTART_FILENAME);
    fsApi.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fsApi.writeFileSync(tmp, buildXdgDesktopEntry(exec), { mode: 0o644 });
    fsApi.renameSync(tmp, file);
}

/** The Settings toggle: ON writes our entry and removes our others; OFF removes all of ours. */
export function setXdgAutostart(fsApi: AutostartFs, dir: string, exec: string[], enabled: boolean): void {
    for (const name of findOtherOwnEntries(fsApi, dir).keys()) removeQuiet(fsApi, path.join(dir, name));
    if (enabled) writeOwn(fsApi, dir, exec);
    else removeQuiet(fsApi, path.join(dir, XDG_AUTOSTART_FILENAME));
}

/**
 * Boot reconcile (retrofit, never create from nothing): fold entries of ours under
 * other names into the one canonical file and fix a stale Exec. The user's choice
 * wins: if our canonical file exists and is switched off, it stays off.
 * Returns true if anything changed.
 */
export function reconcileXdgAutostart(fsApi: AutostartFs, dir: string, exec: string[]): boolean {
    const own = safeRead(fsApi, path.join(dir, XDG_AUTOSTART_FILENAME));
    const others = findOtherOwnEntries(fsApi, dir);
    if (others.size === 0) {
        if (xdgEntryNeedsRewrite(own, exec)) { writeOwn(fsApi, dir, exec); return true; }
        return false;
    }
    const enabled = own !== null
        ? interpretXdgEntry(own).enabled
        : [...others.values()].some((c) => interpretXdgEntry(c).enabled);
    for (const name of others.keys()) removeQuiet(fsApi, path.join(dir, name));
    if (enabled && (own === null || xdgEntryNeedsRewrite(own, exec))) writeOwn(fsApi, dir, exec);
    return true;
}
