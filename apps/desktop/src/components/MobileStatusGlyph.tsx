import React from 'react';
import { type UserStatus, STATUS_CONFIG } from '../utils/userStatusModel';

/**
 * The "on mobile" form of the status dot: a small phone, filled with the
 * status color (green / amber / red), with a dark screen. A little narrower
 * than the dot it replaces and a little taller, so every call site's ring (a
 * `rounded-full` bordered span) becomes a pill around it — the shape people
 * know from Discord.
 *
 * Shown only while the person is visibly present and EVERY device they're
 * present on is a phone (the server's `on_mobile`); never for offline.
 */
export const MobileStatusGlyph: React.FC<{ status: UserStatus; size?: number }> = ({ status, size = 10 }) => {
    const w = Math.max(6, Math.round(size * 0.8));
    const h = Math.max(9, Math.round(size * 1.3));
    const radius = Math.max(2, Math.round(size * 0.22));
    const inset = Math.max(1, Math.round(size * 0.14));
    const label = `${STATUS_CONFIG[status]?.label ?? 'Online'} — on mobile`;
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            data-testid="status-mobile-glyph"
            style={{
                display: 'inline-block',
                position: 'relative',
                width: w,
                height: h,
                borderRadius: radius,
                backgroundColor: STATUS_CONFIG[status]?.color ?? '#6b7280',
                flexShrink: 0,
            }}
        >
            {/* screen */}
            <span
                style={{
                    position: 'absolute',
                    left: inset,
                    right: inset,
                    top: inset,
                    bottom: inset + Math.max(1, Math.round(size * 0.16)),
                    borderRadius: Math.max(1, radius - inset),
                    backgroundColor: 'rgba(10, 15, 28, 0.78)',
                }}
            />
        </span>
    );
};
