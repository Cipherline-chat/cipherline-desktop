/**
 * Pure style helpers for the rail folder tile (kept out of
 * ServerFolderTile.tsx so that file only exports components — fast refresh —
 * and so Dashboard's drag ghost can tint the same way).
 */
import type React from 'react';
import { formatRailBadgeCount, type BadgeState } from '../../utils/unreadBadges';
import { FOLDER_COLOR_VAR, type RailFolder } from './serverFolders';

export function notchStyle(mask: string | undefined): React.CSSProperties {
    if (!mask) return {};
    return { maskImage: mask, WebkitMaskImage: mask, maskComposite: 'intersect', WebkitMaskComposite: 'source-in' } as React.CSSProperties;
}

export function folderTint(folder: RailFolder): React.CSSProperties | undefined {
    if (!folder.color) return undefined;
    const c = FOLDER_COLOR_VAR[folder.color];
    return {
        ['--cl-folder-tint' as string]: `color-mix(in srgb, ${c} 22%, transparent)`,
        ['--cl-folder-ring' as string]: `color-mix(in srgb, ${c} 55%, transparent)`,
    };
}

/**
 * Badges sit on the folder TILE's corners (a little outside the 40px box, so
 * they read as the tile's badges and not as a mini icon's), and the box is
 * notched under each one — the same cut-out an avatar status dot uses — so a
 * badge never sits ON TOP of a mini icon. Geometry, in box coordinates (the
 * 40px box is inset 2px in the 44px button):
 *   - count pill: RailBadge's top/right 2px inside a wrapper inset -7px →
 *     the pill's top-right corner at tile (-5, 49) → box (-7, 47); 17px tall,
 *     wider for more digits; +1.5px for its abyss border.
 *   - quiet dot: 12px at tile top/right -3 → centre box (39, 1).
 *   - live call: 16px at tile -bottom-1 -right-1 → centre box (38, 38), plus
 *     its 2px abyss ring.
 */
export function folderNotchMask(badge: BadgeState | null, hasCall: boolean): string | undefined {
    const hole = (x: number, y: number, r: number) => `radial-gradient(circle at ${x}px ${y}px, transparent ${r}px, #000 ${r + 0.5}px)`;
    const holes: string[] = [];
    if (badge && badge.count > 0) {
        if (badge.tone === 'quiet') holes.push(hole(39, 1, 7.5));
        else {
            const text = formatRailBadgeCount(badge.count) ?? '';
            const w = Math.max(17, 12 + 6 * text.length);
            const right = 47;          // pill right edge (box coords)
            const cy = -7 + 8.5;       // pill vertical centre
            holes.push(hole(right - 8.5, cy, 10));
            if (w > 17) holes.push(hole(right - w + 8.5, cy, 10));
        }
    }
    if (hasCall) holes.push(hole(38, 38, 10));
    return holes.length ? holes.join(', ') : undefined;
}

