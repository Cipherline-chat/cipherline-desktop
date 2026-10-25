import React from 'react';
import { Github, Twitch, Youtube, Instagram, Gamepad2 } from 'lucide-react';
import type { LinkPlatform } from '../utils/profileLinks';

/**
 * Platform glyphs for profile links. lucide has Github / Twitch / Youtube /
 * Instagram; the rest are small inline SVG marks (no new dependency, no
 * network). Decorative: the chip carries the platform name as text.
 */
const SVG_PROPS = {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false,
};

export const ProfileLinkIcon: React.FC<{ platform: LinkPlatform; size?: number }> = ({ platform, size = 14 }) => {
    const common = { width: size, height: size, style: { flex: 'none' as const } };
    switch (platform) {
        case 'github': return <Github {...common} aria-hidden="true" />;
        case 'twitch': return <Twitch {...common} aria-hidden="true" />;
        case 'youtube': return <Youtube {...common} aria-hidden="true" />;
        case 'instagram': return <Instagram {...common} aria-hidden="true" />;
        case 'discord': return <Gamepad2 {...common} aria-hidden="true" />;
        case 'steam':
            return (
                <svg {...SVG_PROPS} {...common}>
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="15" cy="9.5" r="2.6" />
                    <path d="M4 13.5l5 2" />
                    <circle cx="9.5" cy="15.5" r="1.8" fill="currentColor" stroke="none" />
                </svg>
            );
        case 'x':
            return (
                <svg {...SVG_PROPS} {...common} strokeWidth={2.4}>
                    <path d="M5 5l14 14M19 5L5 19" />
                </svg>
            );
        case 'tiktok':
            return (
                <svg {...SVG_PROPS} {...common}>
                    <path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5" />
                    <path d="M14 4c.3 2.4 1.9 4 4.5 4.2" />
                </svg>
            );
        case 'reddit':
            return (
                <svg {...SVG_PROPS} {...common}>
                    <ellipse cx="12" cy="14" rx="8" ry="5.5" />
                    <circle cx="9.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
                    <circle cx="14.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
                    <path d="M12 8.5L13 4l4 1" />
                    <circle cx="18" cy="5.2" r="1.2" />
                </svg>
            );
        case 'spotify':
            return (
                <svg {...SVG_PROPS} {...common}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M7 9.5c3.5-1 7-.7 10 1M7.8 12.7c2.8-.7 5.6-.5 8 .8M8.7 15.7c2.2-.5 4.2-.3 6 .6" />
                </svg>
            );
        case 'bluesky':
            return (
                <svg {...SVG_PROPS} {...common} fill="currentColor" stroke="none">
                    <path d="M12 11.5C10.5 8.5 7 5 4.2 4.8 3.4 4.7 3 5.3 3 6.4c0 1 .5 5.2.9 6 .8 1.8 2.7 2.4 4.6 2.2-2.8.5-4 2.3-2 4.3 3.4 3.4 4.4-1.2 4.5-2.3.1 1.1 1.1 5.7 4.5 2.3 2-2 .8-3.8-2-4.3 1.9.2 3.8-.4 4.6-2.2.4-.8.9-5 .9-6 0-1.1-.4-1.7-1.2-1.6C17 5 13.5 8.5 12 11.5z" />
                </svg>
            );
        case 'medal':
            // A medal on its ribbon (a generic glyph, not the Medal.tv logo).
            return (
                <svg {...SVG_PROPS} {...common}>
                    <path d="M8 3l2.5 6M16 3l-2.5 6" />
                    <circle cx="12" cy="15" r="5.5" />
                    <path d="M12 12.4l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2-1.45-1.4 2-.3z" fill="currentColor" stroke="none" />
                </svg>
            );
        default:
            return null;
    }
};
