import { callNameError } from '@cipherline/shared';

/**
 * Call names (rename dialog). The rule is `@cipherline/shared`'s display-name
 * rule (any script, punctuation, emoji; no control / hidden characters; 60
 * characters counted as grapheme clusters), the same function the API
 * enforces. Nothing is stripped: a rejected character is reported, not deleted.
 */

/** What is sent: the draft, trimmed. */
export const cleanCallName = (raw: string): string => raw.trim();

/** Inline error for a call-name draft, or null when it is fine. An empty draft
 *  is not an error here (the submit button is simply disabled). */
export const callNameDraftError = (raw: string): string | null => {
    const t = raw.trim();
    return t === '' ? null : callNameError(t);
};
