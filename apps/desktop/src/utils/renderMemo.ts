/**
 * Small, dependency-free helpers for skipping React work in the chat feed.
 *
 * Why this exists: ChatPane renders every visible message row inline, and the
 * pane re-renders for things that have nothing to do with the rows — each
 * composer keystroke, the hover timer, every Dashboard state change (presence,
 * typing, unread counts). Each of those re-ran the whole row body for every
 * row on screen: mention/emoji/URL parsing, `toLocale*` formatting, reply
 * lookups. `MemoRow` (components/MemoRow.tsx) lets a row skip all of that
 * when nothing it draws has changed, and the helpers here are what make "has
 * anything changed" cheap and honest.
 */

/** Same length and every element `Object.is`-equal. */
export function shallowArrayEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) return false;
    }
    return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

/** Equality for the value shapes props arrive in: arrays, Sets, plain
 *  objects; anything else falls back to `Object.is`. `depth` 1 compares
 *  elements/values with `Object.is`; depth 2 compares them with depth 1
 *  (e.g. a policy object whose fields are freshly rebuilt id arrays). */
export function shallowValueEqual(a: unknown, b: unknown, depth = 1): boolean {
    if (Object.is(a, b)) return true;
    if (depth <= 0) return false;
    const inner = (x: unknown, y: unknown) => (depth > 1 ? shallowValueEqual(x, y, depth - 1) : Object.is(x, y));
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!inner(a[i], b[i])) return false;
        return true;
    }
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const ka = Object.keys(a);
        if (ka.length !== Object.keys(b).length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k) || !inner(a[k], b[k])) return false;
        }
        return true;
    }
    return false;
}

/** `{ ...prev, ...patch }`, or `prev` itself when the patch changes nothing —
 *  for state merges whose result feeds identity-based memoisation. */
export function mergeIfChanged<T>(prev: Record<string, T>, patch: Record<string, T>): Record<string, T> {
    for (const k in patch) {
        if (!(k in prev) || !Object.is(prev[k], patch[k])) return { ...prev, ...patch };
    }
    return prev;
}

/** `prev` when it already holds exactly these values, else a new Set. */
export function setIfChanged<T>(prev: Set<T>, values: Iterable<T>): Set<T> {
    const next = new Set(values);
    if (next.size !== prev.size) return next;
    for (const v of next) if (!prev.has(v)) return next;
    return prev;
}
