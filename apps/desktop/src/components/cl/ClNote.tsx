import React from 'react';

interface ClNoteProps {
    children: React.ReactNode;
    className?: string;
    /** Test hook. */
    'data-testid'?: string;
}

/**
 * Calm, informational inline note: a small Lume info glyph plus muted text on
 * a hairline-bordered, barely-tinted card. For "good to know" copy that is NOT
 * a warning - anything that needs attention keeps its own amber/coral styling.
 *
 * Hugs its content (`w-fit`) but never grows past its column (`max-w-full`),
 * so it lines up with the controls above it instead of spanning wider.
 * Tokens only (`cl-*` + white alpha, the same surface recipe as the picker's
 * other inline cards) - no hard-coded colours.
 */
export const ClNote: React.FC<ClNoteProps> = ({ children, className, 'data-testid': testId }) => (
    <div
        role="note"
        data-testid={testId}
        className={[
            'flex w-fit max-w-full items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2',
            className ?? '',
        ].filter(Boolean).join(' ')}
    >
        <svg
            className="mt-[1px] h-3.5 w-3.5 shrink-0 text-cl-lume/80"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
        </svg>
        <p className="m-0 text-[11px] leading-snug text-cl-muted">{children}</p>
    </div>
);
