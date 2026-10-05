/**
 * Strict recogniser for the signup-attribution links the landing pages hand off.
 *
 * Deliberately free of any `electron` import so it is unit-testable
 * (attribution-link.test.ts). The renderer has its own, more forgiving parser
 * for text a person pastes into the referral field (src/utils/signupAttribution.ts);
 * the two are separate on purpose: this one guards the CLIPBOARD, which holds
 * whatever the person last copied and is none of our business. It answers only
 * when the whole clipboard is exactly one of OUR links, and otherwise says
 * nothing — the renderer never receives clipboard text it did not ask about.
 *
 * (electron/ cannot be imported from src/ — doing so nests the compiled output
 * and breaks the packaged build — so the small amount of duplication is the
 * price of keeping the boundary clean.)
 */

export type AttributionLink =
  | { kind: 'ref'; code: string }
  | { kind: 'invite'; code: string };

// The landing pages copy `https://cipherline.chat/<ref|invite>/<code>`; the
// deep-link form is accepted too. Nothing else, no surrounding text.
const LINK_RE =
  /^(?:cipherline:\/\/|https:\/\/(?:www\.)?cipherline\.chat\/)(ref|invite)\/([A-Za-z0-9_-]{4,64})\/?$/i;

/** Anything longer than this cannot be one of our links; skip it unparsed. */
const MAX_CLIPBOARD_CHARS = 200;

/**
 * @param text raw clipboard text (may be null/empty/huge/anything)
 * @returns the link, or null when the clipboard is not exactly one of ours
 */
export function parseAttributionClipboard(text: string | null | undefined): AttributionLink | null {
  if (typeof text !== 'string') return null;
  if (text.length === 0 || text.length > MAX_CLIPBOARD_CHARS) return null;
  const m = text.trim().match(LINK_RE);
  if (!m) return null;
  const kind = m[1].toLowerCase() as 'ref' | 'invite';
  if (kind === 'ref') {
    const code = m[2].toUpperCase();
    return /^[A-F0-9]{8}$/.test(code) ? { kind, code } : null;
  }
  return { kind, code: m[2] };
}

/**
 * `--referral=<CODE>` / `--invite=<CODE>` on the command line.
 *
 * A hook for an installer or stub that wants to pass a code at first launch (the
 * same path a cold-start `cipherline://` URL takes). Nothing in the current
 * installers sets it; it exists so that wiring one up needs no new IPC.
 */
export function parseAttributionArgv(argv: readonly string[]): AttributionLink | null {
  for (const arg of argv) {
    const m = /^--(referral|invite)=([A-Za-z0-9_-]{4,64})$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'referral') {
      const code = m[2].toUpperCase();
      if (/^[A-F0-9]{8}$/.test(code)) return { kind: 'ref', code };
    } else {
      return { kind: 'invite', code: m[2] };
    }
  }
  return null;
}
