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
