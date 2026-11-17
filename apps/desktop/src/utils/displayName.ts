import {
    CHANNEL_NAME_MAX_GRAPHEMES,
    DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME,
    channelNameError,
} from '@cipherline/shared';

/**
 * Channel / category name inputs. The rule is `@cipherline/shared`'s
 * display-name rule, run live as the user types; the API runs the identical
 * function and is the only load-bearing check. Nothing is stripped on the
 * way in: a rejected character is reported inline, not silently deleted.
 */

/** Inline error for a channel or category name draft (null = fine, or empty:
 *  the submit button is what gates an empty name). Trailing/leading spaces are
 *  ignored here because the draft is trimmed before it is sent. */
export const channelNameDraftError = (draft: string): string | null => {
    const t = draft.trim();
    return t === '' ? null : channelNameError(t);
};

/** Browser-side cap on the input, in UTF-16 code units: a paste guard only
 *  (the real limit is in grapheme clusters, enforced by the validator). */
export const CHANNEL_NAME_INPUT_MAX_UNITS = CHANNEL_NAME_MAX_GRAPHEMES * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME;
