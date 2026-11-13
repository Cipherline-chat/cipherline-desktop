/**
 * "Nothing changed" detection for the periodic share samples (share_rx_fps on
 * a viewer, share_net on a sharer), so a half-hour share does not push every
 * other call event out of the 500-event ring.
 *
 * Both are logged every ~10 s. Un-coalesced they would add 360 entries to a
 * 30-minute share on top of share_fps's 180 - the ring (MAX_EVENTS 500) would
 * be mostly samples and the report (newest 300) would lose the freezes,
 * fallbacks and codec decisions around them. Instead, a sample that matches the
 * run it follows (numbers within tolerance of the run's FIRST sample, strings
 * and booleans identical) updates that entry in place - latest values, a
 * `repeat` count (x ~10 s = how long it held) - and a sample that differs, or
 * a run that reached STEADY_MAX_REPEAT, starts a new entry. A share that holds
 * 70 fps for 20 minutes is ~10 entries; one that wanders is every wobble.
 *
 * Comparing against the run's first sample (not the previous one) means a slow
 * drift cannot creep a long way inside one entry.
 */

export const STEADY_KINDS: ReadonlySet<string> = new Set(['share_rx_fps', 'share_net']);
/** An entry stops absorbing samples after this many (12 x ~10 s = 2 min): a time anchor in the report. */
export const STEADY_MAX_REPEAT = 12;
/** A sample this long after the run's last update starts a new entry (a gap = a real pause). */
export const STEADY_WINDOW_MS = 25_000;

const EXACT_KEYS: ReadonlySet<string> = new Set(['share_ref', 'track', 'res', 'layer', 'focus']);
/** Small-number metrics where a few units IS a change. */
const TIGHT_KEYS: ReadonlySet<string> = new Set(['drop_fps', 'loss_pct']);

type Detail = Record<string, string | number | boolean>;

function numbersClose(key: string, a: number, b: number): boolean {
    const diff = Math.abs(a - b);
    if (TIGHT_KEYS.has(key)) return diff <= 1;
    return diff <= Math.max(3, 0.12 * Math.max(Math.abs(a), Math.abs(b)));
}

/** Is `next` just more of the run that began with `anchor`? */
export function isSteady(anchor: Detail | undefined, next: Detail | undefined): boolean {
    if (!anchor || !next) return false;
    const ka = Object.keys(anchor).filter(k => k !== 'repeat');
    const kn = Object.keys(next).filter(k => k !== 'repeat');
    if (ka.length !== kn.length) return false;
    for (const k of ka) {
        if (!(k in next)) return false;
        const a = anchor[k];
        const b = next[k];
        if (typeof a === 'number' && typeof b === 'number' && !EXACT_KEYS.has(k)) {
            if (!numbersClose(k, a, b)) return false;
        } else if (a !== b) {
            return false;
        }
    }
    return true;
}
