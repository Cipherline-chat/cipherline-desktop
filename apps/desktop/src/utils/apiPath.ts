/**
 * Safe construction of API URLs from ids that came from somewhere else
 * (a server response, a route, a deep link, a peer's message).
 *
 *     axios.get(apiUrl`/conversations/${conversationId}/messages`)
 *
 * Every interpolated value goes through `encodeURIComponent`, so an id such as
 * `abc/../../auth/me` or `x?admin=1` can only ever be ONE path segment / ONE
 * query value; it cannot climb out of the segment it was placed in, add a query
 * string, or smuggle a fragment. The static text of the template is passed
 * through untouched, so the route shape (including a literal `?claim_otp=1`)
 * stays exactly as written.
 *
 * For a normal id (UUID, integer, `[A-Za-z0-9_-]` code) encodeURIComponent is
 * the identity, so the resulting URL is byte-for-byte what the old raw
 * interpolation produced (pinned by apiPath.test.ts).
 *
 * Do NOT interpolate a value that is meant to span several segments or to carry
 * its own `?query` (it would be encoded into one segment). Put the segments in
 * the template, and pass query values through the template or axios `params`.
 * Do NOT pre-encode the value yourself: it would be double-encoded.
 */
import { API_BASE } from '../constants';

export type ApiPathValue = string | number | boolean | null | undefined;

/** Tagged template: returns the path with every interpolated value URI-encoded. */
export function apiPath(strings: TemplateStringsArray, ...values: ApiPathValue[]): string {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        out += encodeURIComponent(String(values[i])) + strings[i + 1];
    }
    return out;
}

/** `apiPath`, prefixed with the configured API origin (`API_BASE`). */
export function apiUrl(strings: TemplateStringsArray, ...values: ApiPathValue[]): string {
    return API_BASE + apiPath(strings, ...values);
}
