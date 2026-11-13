import React from 'react';
import { ActivityKindIcon } from './WatchingIcon';
import { platformLogo, type LogoDef } from './platformLogoData';

/**
 * The platform's mark beside "Listening to / Watching" (status lines, the
 * profile activity row, Settings > Connections). The marks, their sources and
 * licences: platformLogoData.tsx.
 */

/** One platform mark. Decorative unless `title` is given (the text beside it names the platform anyway). */
export const PlatformLogo: React.FC<{ logo: LogoDef; size?: number; className?: string; title?: string }> = ({ logo, size = 16, className, title }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        focusable="false"
        style={{ display: 'inline-block', verticalAlign: 'middle', flex: 'none' }}
        data-logo={logo.name}
    >
        {title ? <title>{title}</title> : null}
        {logo.under}
        <path d={logo.d} fill={logo.color} />
    </svg>
);

/**
 * The platform's logo when there is one, else the music note (listening) or
 * the TV (watching). `className` styles the fallback glyph (its colour); a
 * logo keeps its own colours.
 */
export const ActivitySourceIcon: React.FC<{ kind: 'listening' | 'watching'; source: string | null | undefined; size?: number; className?: string; title?: string }> = ({ kind, source, size = 16, className, title }) => {
    const logo = platformLogo(source);
    return logo
        ? <PlatformLogo logo={logo} size={size} className={className} title={title} />
        : <ActivityKindIcon kind={kind} size={size} className={className} title={title} />;
};

export default PlatformLogo;
