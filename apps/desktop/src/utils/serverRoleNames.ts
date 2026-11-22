import {
    DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME,
    ROLE_NAME_MAX_GRAPHEMES,
    SERVER_NAME_MAX_GRAPHEMES,
    graphemeLength,
    roleNameError,
    serverNameError,
} from '@cipherline/shared';

/**
 * Server-name and role-name inputs. Both follow `@cipherline/shared`'s
 * display-name rule (emoji, symbols, decorative / "fancy font" letters, any
 * script), run live as the user types. The API runs the identical function and
 * is the only load-bearing check. Nothing is stripped on the way in: a
 * rejected character is reported inline, not silently deleted.
 */

/** Inline error for a server-name draft (null = fine, or empty: the submit
 *  button gates an empty name). The draft is trimmed before it is sent. */
export const serverNameDraftError = (draft: string): string | null => {
    const t = draft.trim();
    return t === '' ? null : serverNameError(t);
};

/** Inline error for a role-name draft (same contract). */
export const roleNameDraftError = (draft: string): string | null => {
    const t = draft.trim();
    return t === '' ? null : roleNameError(t);
};

/** Browser-side paste guard in UTF-16 code units (the real limit is graphemes). */
export const SERVER_NAME_INPUT_MAX_UNITS = SERVER_NAME_MAX_GRAPHEMES * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME;
export const ROLE_NAME_INPUT_MAX_UNITS = ROLE_NAME_MAX_GRAPHEMES * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME;

/** Characters used, as "n/50" counter text (graphemes, like the validator). */
export const nameCounter = (draft: string, max: number): string => `${graphemeLength(draft.trim())}/${max}`;
