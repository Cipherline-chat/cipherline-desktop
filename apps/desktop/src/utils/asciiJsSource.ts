/**
 * Make JavaScript SOURCE TEXT pure ASCII without changing what it does.
 *
 * WHY (renderer memory): V8 and Blink store a string in one of two layouts —
 * one byte per character when every character is Latin-1, two bytes per
 * character otherwise. A single non-Latin-1 character anywhere (an em dash in a
 * comment, a Japanese JSDoc line) doubles the size of the WHOLE string. The
 * RNNoise worklet source is a ~4.8 MB string held for the whole session once it
 * is prefetched, and the vendored glue it embeds carries Japanese doc comments,
 * so it was being held at ~9.2 MB instead of ~4.8 MB (measured in a renderer
 * heap snapshot). Escaping those characters keeps it one-byte.
 *
 * WHAT IS SAFE: every non-ASCII UTF-16 code unit becomes `\uXXXX`. In comments
 * that is inert text; in string, template and regular-expression literals and in
 * identifiers it is the escape for the very same code unit, so the program means
 * exactly what it meant before (surrogate pairs become two escapes, which string
 * and regex literals — including `u`-mode regexes — read back as the same code
 * point).
 *
 * WHAT IS NOT, and is therefore left alone: a character that directly follows an
 * odd number of backslashes. `"\é"` is an identity escape for `é`; turning it
 * into `"\\u00e9"` would change the string. Such a character is kept verbatim
 * (the result is then simply not pure ASCII, which costs memory, never
 * correctness). Tagged templates that read `.raw` would also see the escape
 * rather than the character; none of the sources this is applied to use one,
 * and the smoke test evaluates the escaped worklet source to prove it still
 * registers its processor.
 *
 * Only for JavaScript source. Applying it to arbitrary text (Markdown, legal
 * copy) would change that text's VALUE.
 */
export function escapeNonAsciiJs(source: string): string {
    // Fast path: already ASCII (the common case for our own kernels).
    // eslint-disable-next-line no-control-regex
    if (!/[^\x00-\x7f]/.test(source)) return source;
    // eslint-disable-next-line no-control-regex
    return source.replace(/(\\*)([^\x00-\x7f])/g, (_m, slashes: string, ch: string) => {
        // An odd run of backslashes escapes the character itself — keep it.
        if (slashes.length % 2 === 1) return slashes + ch;
        return slashes + '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
}

/** True when every character is 7-bit ASCII (so V8 can store it one byte per char). */
export function isAscii(s: string): boolean {
    // eslint-disable-next-line no-control-regex
    return !/[^\x00-\x7f]/.test(s);
}
