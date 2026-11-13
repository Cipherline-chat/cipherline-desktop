import React from 'react';

interface ClNoteProps {
    children: React.ReactNode;
    className?: string;
    /**
     * `info` (default): calm "good to know" copy - Lume info glyph on a hairline card.
     * `warn`: something is limited or off and the reader should know - the same box with a
     * Glow triangle and a faintly warm tint. Same padding, radius, icon size and type scale.
     */
    tone?: 'info' | 'warn';
    /** Trailing control (a dismiss button). The note then spans its column so the control sits at the far edge. */
    action?: React.ReactNode;
    /** Test hook. */
    'data-testid'?: string;
}

const TONE = {
    info: { box: 'border-white/[0.06] bg-white/[0.02]', icon: 'text-cl-lume/80' },
    warn: { box: 'border-cl-glow/25 bg-cl-glow/[0.06]', icon: 'text-cl-glow' },
} as const;

/**
 * Calm inline note: a small glyph plus muted text on a hairline-bordered,
 * barely-tinted card. `info` is for "good to know" copy; `warn` is the same
 * card with a warm tint for a limit the reader can't change from here (a
 * display's refresh rate, the OS capturer's fps ceiling). Tokens only
 * (`cl-*` + alpha) - no hard-coded colours.
 *
 * Hugs its content (`w-fit`) but never grows past its column (`max-w-full`),
 * so it lines up with the controls above it instead of spanning wider.
 *
 * The text is a <div>, NOT a <p>, on purpose. Inside a kit modal the kit's own
 * `@scope (.cl-kit) .mcard p { margin: 0 0 22px; font-size: 14px }` outranks
 * both Tailwind's `m-0` and `text-[12px]`, so a <p> here grew a 22px bottom
 * margin (the empty strip under the text) and a 14px font. A <div> is out of
 * that rule's reach everywhere.
 */
export const ClNote: React.FC<ClNoteProps> = ({ children, className, tone = 'info', action, 'data-testid': testId }) => (
    <div
        role="note"
        data-testid={testId}
        data-tone={tone}
        className={[
            'flex max-w-full items-start gap-2 rounded-lg border px-3 py-2',
            action ? 'w-full' : 'w-fit',
            TONE[tone].box,
            className ?? '',
        ].filter(Boolean).join(' ')}
    >
        <svg
            className={`mt-px h-4 w-4 shrink-0 ${TONE[tone].icon}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
            {tone === 'warn' ? (
                <>
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                </>
            ) : (
                <>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                </>
            )}
        </svg>
        <div className="m-0 min-w-0 flex-1 text-[12px] leading-[1.45] text-cl-muted [text-wrap:pretty]">{children}</div>
        {action ? <div className="-my-1 -mr-1.5 shrink-0">{action}</div> : null}
    </div>
);
