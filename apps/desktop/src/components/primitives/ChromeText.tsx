import React from 'react';

/**
 * Message-row CHROME text: a status label that sits inside the message markup
 * but is not the message — the disappearing-message expiry ("· 3d", "Deletes
 * in 3 days") and the "(edited)" marker.
 *
 * Why not just `select-none`: the text must also stay out of what a drag
 * selection COPIES, and `user-select: none` alone has been inconsistent about
 * that across engines (WebKit has copied it). So the characters never exist in
 * the DOM at all: they are painted by `.cl-chrome-text::before`
 * (`content: attr(data-chrome-text)`, src/index.css), and generated content is
 * never part of a selection or of `textContent`. `user-select: none` is also set
 * inline as belt and braces (and so it cannot be lost with the stylesheet).
 *
 * Accessibility: generated text is not reliable for assistive tech, so when
 * the label carries information (`label`) the element is a `role="img"` with
 * that as its accessible name; a purely visual duplicate (a tooltip repeating
 * the badge) omits `label` and is `aria-hidden`.
 */
export interface ChromeTextProps {
    /** What is painted. */
    text: string;
    /** Accessible name announced by screen readers; omit for decorative duplicates. */
    label?: string;
    className?: string;
}

export const ChromeText: React.FC<ChromeTextProps> = ({ text, label, className }) => (
    <span
        className={`cl-chrome-text${className ? ` ${className}` : ''}`}
        data-chrome-text={text}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
);
