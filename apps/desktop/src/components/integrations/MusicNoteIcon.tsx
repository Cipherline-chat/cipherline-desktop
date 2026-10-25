import React from 'react';

/**
 * Filled beamed-notes glyph for "Listening to ...": the music counterpart of
 * GameControllerIcon (same filled weight, same baseline alignment), so a
 * listening line sits in exactly the place and colour a playing line does.
 */
export const MusicNoteIcon: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 16, className = '', title }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        fill="currentColor"
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        {title ? <title>{title}</title> : null}
        {/* Beam across both stems, slanted up to the right. */}
        <path d="M9 5.6 20 3v3.4L9 9z" />
        <rect x="8" y="6" width="2" height="11.4" rx="1" />
        <rect x="19" y="3.4" width="2" height="11.2" rx="1" />
        <ellipse cx="6.4" cy="17.6" rx="3.4" ry="2.7" transform="rotate(-18 6.4 17.6)" />
        <ellipse cx="17.4" cy="14.8" rx="3.4" ry="2.7" transform="rotate(-18 17.4 14.8)" />
    </svg>
);

export default MusicNoteIcon;
