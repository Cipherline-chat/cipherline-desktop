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
