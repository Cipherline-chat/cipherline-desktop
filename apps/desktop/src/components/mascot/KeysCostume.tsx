import React from 'react';
import type { Costume } from '../../utils/easterEggs';

/**
 * Keys' wardrobe — tiny hats for the right days (Halloween: witch hat; New
 * Year and Cipherline's birthday: party hat). Drawn in Keys' own 110×92
 * viewBox, ABOVE the dome (the dome's crown is at y≈14; the SVG already has
 * `overflow: visible`, so a tall hat simply rises out of the box). Rendered
 * inside Keys' `.k2-tilt` group so it leans with him, and tipped a few degrees
 * so it sits jauntily rather than like a lid.
 *
 * Static shapes only: no animation, no filter — it costs nothing and needs no
 * reduced-motion variant (doctrine rules 9 and 11).
 */
export const KeysCostume: React.FC<{ costume: Costume }> = ({ costume }) => (
    <g className="k2-costume" data-costume={costume} transform="rotate(-9 55 16)" aria-hidden="true">
        {costume === 'witch' ? (
            <>
                {/* Cone with a bent tip, then the brim over its base. */}
                <path d="M40 17 C44 4 49 -8 56 -17 C58 -22 63 -24 69 -22 C64 -19 63 -14 65 -8 C69 2 71 10 72 17 Z" fill="#3A2A66" />
                {/* Band. */}
                <path d="M41.6 11.5 L70.4 11.5 L72 17 L40 17 Z" fill="var(--cl-flash, #FF6B5E)" />
                <rect x="52.5" y="11.5" width="6.5" height="5.5" rx="1" fill="none" stroke="var(--cl-glow, #FFC94D)" strokeWidth="1.8" />
                <ellipse cx="56" cy="17.5" rx="27" ry="4.6" fill="#2C1F52" />
                <ellipse cx="56" cy="16.6" rx="27" ry="4" fill="#3A2A66" />
            </>
        ) : (
            <>
                <path d="M43 17 L58 -15 L71 17 Z" fill="var(--cl-glow, #FFC94D)" />
                {/* Stripes, clipped by hand to the cone's edges. */}
                <path d="M47.5 8 L65.4 8 L67 12 L46 12 Z" fill="var(--cl-flash, #FF6B5E)" />
                <path d="M53 -4.5 L62.5 -4.5 L64.5 0 L51 0 Z" fill="var(--cl-flash, #FF6B5E)" />
                <circle cx="58" cy="-16" r="4.6" fill="#FFFFFF" />
                <ellipse cx="57" cy="17.2" rx="16" ry="2.6" fill="var(--cl-lume-hi, #7DF0DF)" opacity="0.9" />
            </>
        )}
    </g>
);

export default KeysCostume;
