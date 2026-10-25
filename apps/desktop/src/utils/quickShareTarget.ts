/**
 * Which source the Quick Screen Share shortcut shares. Pure; the I/O (game
 * probe, source enumeration, asking main for the foreground window) is in
 * SidebarConference.tsx.
 *
 * Owner-decided order (2026-10-20):
 *   1. A detected game whose window is in the source list -> that window, no
 *      matter what is focused.
 *   2. Else the window that was in front when the shortcut was pressed.
 *      `foregroundSourceId` comes from MAIN (electron/quick-share-foreground.ts),
 *      which has already refused Cipherline itself, the desktop / shell, an
 *      unknown window and one missing from its own source list - so it is null in
 *      all of those cases and this function adds no check of its own for them.
 *   3. Else the primary screen (first `screen:` source), else the first source.
 */
export interface QuickShareSource { id: string; name: string }

export type QuickShareWhy = 'game' | 'foreground' | 'screen' | 'first';

export interface QuickShareChoice { id: string; why: QuickShareWhy }

/** The window source for a detected game: name match, case-insensitive, substring in either direction. */
export function pickGameWindow(sources: readonly QuickShareSource[], gameName: string | null | undefined): QuickShareSource | null {
    const needle = (gameName ?? '').toLowerCase();
    if (!needle) return null;
    return sources.find(s => {
        if (!s.id.startsWith('window:')) return false;
        const n = s.name.toLowerCase();
        return n.length > 0 && (n.includes(needle) || needle.includes(n));
    }) ?? null;
}

export function chooseQuickShareSource(o: {
    gameName: string | null | undefined;
    sources: readonly QuickShareSource[];
    foregroundSourceId: string | null | undefined;
}): QuickShareChoice | null {
    const game = pickGameWindow(o.sources, o.gameName);
    if (game) return { id: game.id, why: 'game' };
    if (typeof o.foregroundSourceId === 'string' && o.foregroundSourceId.startsWith('window:')) {
        return { id: o.foregroundSourceId, why: 'foreground' };
    }
    const screen = o.sources.find(s => s.id.startsWith('screen:'));
    if (screen) return { id: screen.id, why: 'screen' };
    return o.sources[0] ? { id: o.sources[0].id, why: 'first' } : null;
}
