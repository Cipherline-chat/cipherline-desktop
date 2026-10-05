import React from 'react';

/**
 * The wave field behind the incoming-call screen.
 *
 * The ring it accompanies reads as water rather than as a bell, so the
 * backdrop answers the sound instead of ignoring it: three sine bands
 * drifting low in the panel at different speeds and opacities.
 *
 * Each band is deliberately TWICE its container's width and carries FOUR
 * full periods, and .cl-incall-waves animates it to translateX(-50%) — by
 * exactly two periods — so the loop closes on itself with no seam to
 * disguise. The translation is applied to the HTML element rather than
 * inside the SVG so it never passes through the viewBox's coordinate
 * scaling, which is what would otherwise make the wavelength shift as the
 * user drags the panel wider.
 *
 * `preserveAspectRatio="none"` is intentional: the path is a decorative
 * waveform, not a glyph, and letting it stretch to the band's height is how
 * the three bands end up with visibly different amplitudes from one shared
 * geometry.
 *
 * Purely decorative, so `aria-hidden` and no pointer events — a ringing call
 * has exactly two things a person can act on and neither of them is this.
 */
const BANDS = [
    { cls: 'w1', d: 'M0,60 C50,30 150,30 200,60 C250,90 350,90 400,60 C450,30 550,30 600,60 C650,90 750,90 800,60 C850,30 950,30 1000,60 C1050,90 1150,90 1200,60 C1250,30 1350,30 1400,60 C1450,90 1550,90 1600,60' },
    { cls: 'w2', d: 'M-130,60 C-80,38 20,38 70,60 C120,82 220,82 270,60 C320,38 420,38 470,60 C520,82 620,82 670,60 C720,38 820,38 870,60 C920,82 1020,82 1070,60 C1120,38 1220,38 1270,60 C1320,82 1420,82 1470,60' },
    { cls: 'w3', d: 'M-260,60 C-210,44 -110,44 -60,60 C-10,76 90,76 140,60 C190,44 290,44 340,60 C390,76 490,76 540,60 C590,44 690,44 740,60 C790,76 890,76 940,60 C990,44 1090,44 1140,60 C1190,76 1290,76 1340,60' },
];

export const IncomingCallWaves: React.FC = () => (
    <div className="cl-incall-waves" aria-hidden="true">
        {BANDS.map(b => (
            <svg
                key={b.cls}
                className={b.cls}
                viewBox="0 0 1600 120"
                preserveAspectRatio="none"
                focusable="false"
            >
                <path d={b.d} />
            </svg>
        ))}
    </div>
);
