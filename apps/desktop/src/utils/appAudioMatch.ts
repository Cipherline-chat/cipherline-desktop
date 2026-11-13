/**
 * Which app's audio goes with a window? (Linux Wayland window shares, "Share audio from: [app]".)
 *
 * The desktop's portal hands over a window with no owning process, so the picker offers the apps that are
 * playing audio (electron/app-audio.ts) and pre-selects the one that clearly belongs to the window - when
 * the portal gave the window a title or app id to go on. "Clearly" is the point: a title that names no app,
 * or names two equally well, selects NOTHING. The picker never guesses silently; an unmatched window starts
 * on "None" and the list is one click away.
 *
 * Pure and renderer-side: this only chooses a default among entries main already issued. It decides nothing
 * about what may be captured (main does, from the handle and the share grant).
 */

export interface AudioApp { handle: string; name: string; binary: string }

/** Lower case, accents folded, everything but letters and digits turned to single spaces. */
export function normalizeForMatch(s: string): string {
    return s
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Too short or too generic to prove a window belongs to an app. */
const GENERIC = new Set(['app', 'apps', 'audio', 'sound', 'player', 'media', 'window', 'main', 'the', 'electron']);

function terms(app: AudioApp): string[] {
    const out = new Set<string>();
    for (const raw of [app.name, app.binary]) {
        const t = normalizeForMatch(raw ?? '');
        if (t.length >= 3 && !GENERIC.has(t)) out.add(t);
    }
    return [...out];
}

/** Does `needle` (already normalized) occur in `hay` (already normalized) on word boundaries? */
function hasWords(hay: string, needle: string): boolean {
    return (' ' + hay + ' ').includes(' ' + needle + ' ');
}

/**
 * The app whose name or executable appears, as whole words, in the window's title / app id; the one with the
 * longest such term wins. Two different apps tying for the longest, or no app named at all, gives null.
 */
export function bestAppForWindow(windowTitle: string | null | undefined, apps: readonly AudioApp[]): AudioApp | null {
    const hay = normalizeForMatch(windowTitle ?? '');
    if (!hay) return null;
    let best: { app: AudioApp; len: number } | null = null;
    let tie = false;
    for (const app of apps) {
        let len = 0;
        for (const t of terms(app)) if (hasWords(hay, t)) len = Math.max(len, t.length);
        if (len === 0) continue;
        if (!best || len > best.len) { best = { app, len }; tie = false; }
        else if (len === best.len && best.app.handle !== app.handle) tie = true;
    }
    return best && !tie ? best.app : null;
}
