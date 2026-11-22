/**
 * Bot-token hygiene for the Discord importer. Pure (no electron import).
 *
 * The token is the user's own Discord bot credential. It lives only in
 * SecureStore and in the `Authorization` header of requests to discord.com.
 * It must never appear in a log line, an IPC error, a thrown message or a
 * stack trace that could be shown or reported. Two layers:
 *   1. errors are built from controlled text (status, Discord's numeric code),
 *      never from a header or URL that carried the token;
 *   2. anything that might embed text from elsewhere (a `fetch` exception, a
 *      response body) goes through `redactText` first.
 */

/** Discord bot token shape: <base64 id>.<timestamp>.<hmac>, url-safe base64 parts. */
const TOKEN_SHAPE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g;

export const REDACTED = '[redacted-token]';

/** Replace the exact token, any fragment of it, and anything token-shaped. */
export function redactText(text: string, token?: string | null): string {
    let out = text;
    if (token && token.length >= 8) {
        out = out.split(token).join(REDACTED);
        // Fragments: a client library may chop the token across a message.
        for (const part of token.split('.')) {
            if (part.length >= 8) out = out.split(part).join(REDACTED);
        }
    }
    return out.replace(TOKEN_SHAPE, REDACTED).replace(/Bot\s+[A-Za-z0-9._-]{8,}/g, `Bot ${REDACTED}`);
}

/** What the user may paste: a bare token, optionally with a "Bot " prefix and stray whitespace. */
export function normalizeBotToken(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    let t = input.trim();
    if (/^bot\s+/i.test(t)) t = t.replace(/^bot\s+/i, '').trim();
    // Strict: only the characters a Discord token can contain, a sane length.
    if (!/^[A-Za-z0-9._-]{20,200}$/.test(t)) return null;
    return t;
}

/** A Discord snowflake id (decimal string). Anything else is never put in a URL. */
export function isSnowflake(v: unknown): v is string {
    return typeof v === 'string' && /^[0-9]{15,25}$/.test(v);
}
