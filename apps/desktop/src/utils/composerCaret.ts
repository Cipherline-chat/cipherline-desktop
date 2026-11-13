/**
 * Composer caret placement.
 *
 * Opening a message for edit swaps the composer's contents for that message's
 * text. A plain `focus()` on the textarea leaves the caret wherever the browser
 * decides — in practice the START of the text on a freshly focused field — so
 * the user had to hit End/Ctrl+End before they could keep typing. An edit is
 * almost always "add to / fix the tail", so the caret belongs at the end, and a
 * long message must also be scrolled so that end is actually in view.
 */
export function placeCaretAtEnd(ta: HTMLTextAreaElement | null | undefined, opts: { focus?: boolean } = {}): void {
    if (!ta) return;
    // Size first: the composer auto-grows to a cap (260px), and only past that
    // cap does the box scroll — scrollHeight must be read after the resize.
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
    if (opts.focus !== false) ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    ta.scrollTop = ta.scrollHeight;
}

/**
 * Replace [start, end) of the composer with `text` AS A TYPING EDIT, so one
 * Ctrl+Z puts back what was there (`:red_heart:` after a conversion). The
 * browser only keeps undo history for edits it made itself, so this selects the
 * range and lets `execCommand('insertText')` do the replacement; the textarea
 * then fires its normal `input` event, which the controlled React field turns
 * into state (React does not rewrite the DOM value when it already matches,
 * which is what keeps the undo stack alive). The caret ends directly after
 * `text`. Returns false when the browser would not (no execCommand, e.g. jsdom,
 * or it refused) - the caller then falls back to setting state, which works but
 * is not undoable.
 */
export function replaceRangeUndoable(ta: HTMLTextAreaElement, start: number, end: number, text: string): boolean {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const expected = ta.value.slice(0, start) + text + ta.value.slice(end);
    try {
        if (document.activeElement !== ta) ta.focus();
        ta.setSelectionRange(start, end);
        document.execCommand('insertText', false, text);
    } catch { return false; }
    return ta.value === expected;
}
