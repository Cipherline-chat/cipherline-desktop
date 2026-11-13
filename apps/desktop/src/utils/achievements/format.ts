/** Display helpers for the achievements / most-played panels (pure; kept out of the component files). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM' -> 'Oct 2026'. Anything malformed is shown as-is rather than guessed at. */
export function formatUnlockMonth(m: string): string {
    const r = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(m);
    return r ? `${MONTHS[Number(r[2]) - 1]} ${r[1]}` : m;
}

/** 90 min -> "1.5 h"; under an hour -> "45 min". */
export function formatPlayTime(minutes: number): string {
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
    const h = minutes / 60;
    return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
}

/** What the unlock toast says. Several unlocks that land together share ONE toast. */
export function unlockToastText(defs: ReadonlyArray<{ name: string; description: string }>): { title: string; message: string } | null {
    if (defs.length === 0) return null;
    if (defs.length === 1) return { title: `Achievement unlocked: ${defs[0].name}`, message: defs[0].description };
    return { title: `${defs.length} achievements unlocked`, message: defs.map(d => d.name).join(' · ') };
}

/** Unlocks this close together share one toast. */
export const UNLOCK_TOAST_GATHER_MS = 1500;
/** Right after launch the window is longer, so everything the tracker settles at boot shares ONE toast. */
export const BOOT_TOAST_GATHER_MS = 6000;

/** How long to wait before showing the toast for an unlock that starts a gather now (`bootEnd` = launch + BOOT_TOAST_GATHER_MS). */
export const unlockToastDelayMs = (now: number, bootEnd: number): number => Math.max(UNLOCK_TOAST_GATHER_MS, bootEnd - now);
