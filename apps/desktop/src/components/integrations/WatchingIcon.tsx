import React from 'react';
import { MusicNoteIcon } from './MusicNoteIcon';

/**
 * Filled TV glyph for "Watching ...": the video counterpart of MusicNoteIcon
 * (same filled weight and baseline alignment), so a watching line sits in
 * exactly the place a listening or playing line does.
 */
export const WatchingIcon: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 16, className = '', title }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        fill="currentColor"
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
        data-icon="watching"
    >
        {title ? <title>{title}</title> : null}
        {/* Antenna, then the screen with a play mark knocked out of it. */}
        <rect x="9.6" y="1.45" width="1.8" height="4.6" rx="0.9" transform="rotate(-40 10.5 3.75)" />
        <rect x="12.6" y="1.45" width="1.8" height="4.6" rx="0.9" transform="rotate(40 13.5 3.75)" />
        <path fillRule="evenodd" d="M4.5 6h15A2.5 2.5 0 0 1 22 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-9A2.5 2.5 0 0 1 4.5 6zm5.5 4.2v5.6a.6.6 0 0 0 .9.5l4.6-2.8a.6.6 0 0 0 0-1l-4.6-2.8a.6.6 0 0 0-.9.5z" />
    </svg>
);

/** The note for listening, the TV for watching. */
export const ActivityKindIcon: React.FC<{ kind: 'listening' | 'watching'; size?: number; className?: string; title?: string }> = ({ kind, ...rest }) =>
    kind === 'watching' ? <WatchingIcon {...rest} /> : <MusicNoteIcon {...rest} />;

export default WatchingIcon;
