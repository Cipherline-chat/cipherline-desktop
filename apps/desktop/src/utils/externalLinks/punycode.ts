/**
 * Punycode (RFC 3492) DECODING of one hostname label, for display only.
 *
 * The browser's URL parser already does the security-relevant half: it turns
 * any internationalised host into its ASCII `xn--` form (UTS #46 mapping +
 * validation), and that ASCII form is what we compare, store and hand to the
 * OS. There is no browser API for the reverse, and the only npm punycode in
 * the tree is a transitive dependency of something else, so this file decodes
 * a label back to Unicode purely so the leaving-Cipherline dialog can decide
 * whether to SHOW it (utils/externalLinks/idnDisplay.ts).
 *
 * It is not crypto and it guards nothing on its own: a decode that fails, or
 * whose result does not re-encode to exactly the same label through the URL
 * parser (non-canonical input), returns null and the caller keeps showing the
 * ASCII form. Showing the ASCII form is always the safe direction.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;
/** A DNS label is at most 63 octets; refuse anything longer before looping. */
const MAX_LABEL = 63;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
    let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
    d += Math.floor(d / numPoints);
    let k = 0;
    while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
        d = Math.floor(d / (BASE - T_MIN));
        k += BASE;
    }
    return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitOf(code: number): number {
    if (code >= 0x30 && code <= 0x39) return code - 0x16; // '0'-'9' → 26-35
    if (code >= 0x41 && code <= 0x5a) return code - 0x41; // 'A'-'Z' → 0-25
    if (code >= 0x61 && code <= 0x7a) return code - 0x61; // 'a'-'z' → 0-25
    return BASE;
}

/** Decode the part AFTER `xn--`. Returns null on any malformed input. */
export function decodePunycode(input: string): string | null {
    if (input.length === 0 || input.length > MAX_LABEL) return null;
    const output: number[] = [];
    const basicEnd = input.lastIndexOf('-');
    for (let j = 0; j < Math.max(basicEnd, 0); j++) {
        const c = input.charCodeAt(j);
        if (c >= 0x80) return null;
        output.push(c);
    }
    let n = INITIAL_N;
    let bias = INITIAL_BIAS;
    let i = 0;
    for (let idx = basicEnd > 0 ? basicEnd + 1 : 0; idx < input.length;) {
        const oldI = i;
        let w = 1;
        for (let k = BASE; ; k += BASE) {
            if (idx >= input.length) return null;
            const digit = digitOf(input.charCodeAt(idx++));
            if (digit >= BASE) return null;
            if (digit > Math.floor((MAX_INT - i) / w)) return null;
            i += digit * w;
            const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
            if (digit < t) break;
            if (w > Math.floor(MAX_INT / (BASE - t))) return null;
            w *= BASE - t;
        }
        const out = output.length + 1;
        bias = adapt(i - oldI, out, oldI === 0);
        if (Math.floor(i / out) > MAX_INT - n) return null;
        n += Math.floor(i / out);
        i %= out;
        if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
        output.splice(i++, 0, n);
    }
    try {
        return String.fromCodePoint(...output);
    } catch {
        return null;
    }
}

/**
 * One ASCII hostname label → its Unicode form, or null when it is not a valid,
 * canonical `xn--` label. Plain ASCII labels come back unchanged.
 */
export function labelToUnicode(asciiLabel: string): string | null {
    const lower = asciiLabel.toLowerCase();
    if (!lower.startsWith('xn--')) return lower;
    const decoded = decodePunycode(lower.slice(4));
    if (decoded === null || decoded.length === 0) return null;
    // Canonical check: the URL parser must map the decoded text straight back
    // to the very label we started from. Catches non-canonical encodings and
    // anything UTS #46 would have mapped or refused.
    try {
        const reEncoded = new URL(`https://${decoded}.invalid/`).hostname.split('.')[0];
        return reEncoded === lower ? decoded : null;
    } catch {
        return null;
    }
}
