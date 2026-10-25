/**
 * What the conversation list shows for an unsent draft (see composerDrafts.ts).
 *
 * Purely local presentation: the text comes from the in-memory / encrypted
 * draft store and is rendered by the sidebar row only. It must not be fed to
 * notifications, the window title, or anything that leaves the device.
 */
import { draftKey } from './composerDrafts';

/** Prefix shown (and styled) ahead of the draft text. */
export const DRAFT_PREVIEW_LABEL = 'Draft:';

/** The store key for a DM / group conversation's draft. */
export const dmDraftKey = (conversationId: string): string => draftKey('dm', conversationId);

/**
 * One-line form of a draft for the list: whitespace (newlines included)
 * collapsed so a multi-line draft reads as a single line. The row's CSS
 * truncates; this only normalises. '' when there is nothing to show.
 * The draft is stored in the composer's DISPLAY form (`@name`, `:party:`), so
 * unlike a sent message there are no wire mention tokens to resolve.
 */
export function draftPreviewText(draft: string | null | undefined): string {
    if (!draft) return '';
    return draft.replace(/\s+/g, ' ').trim();
}

/**
 * The draft to show for a row, or '' to show the normal last-message preview.
 * The conversation that is open never shows its own draft (it is in the
 * composer right there).
 */
export function listDraftFor(draft: string | null | undefined, isActive: boolean): string {
    return isActive ? '' : draftPreviewText(draft);
}
