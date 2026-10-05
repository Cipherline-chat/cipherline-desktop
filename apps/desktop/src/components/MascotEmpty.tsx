import React from 'react';
import { Keys } from './mascot/Keys';

/**
 * Empty-state block with the mascot instead of a flat icon tile. Renders the
 * shared articulated Keys (components/mascot/Keys.tsx), which owns the poke
 * eggs (happy → sleepy at 5 → asleep at 8, hover wakes), the `cl:cuttlefish`
 * cue wiggle, and reduced-motion handling — this wrapper owns only the
 * empty-state copy layout. No wave-on-mount: the session hello belongs to
 * the home deck.
 */
interface MascotEmptyProps {
    title: string;
    sub: string;
    /** Optional action (e.g. an Add Friend button) rendered under the copy. */
    children?: React.ReactNode;
    size?: number;
}

export const MascotEmpty: React.FC<MascotEmptyProps> = ({ title, sub, children, size = 64 }) => (
    <div className="flex flex-col items-center justify-center h-full px-6 py-10 text-center">
        <span style={{ marginBottom: 14 }}>
            <Keys size={size} waveOnMount={false} />
        </span>
        <h3 style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 500, fontSize: 15, color: 'var(--cl-text)', margin: 0 }}>
            {title}
        </h3>
        <p className="mt-1.5" style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--cl-faint)', fontFamily: 'var(--cl-font-body)', margin: '6px 0 0', maxWidth: 320 }}>
            {sub}
        </p>
        {children && <div className="mt-4">{children}</div>}
    </div>
);
