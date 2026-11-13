import React from 'react';
import { shade, type HSL } from './colour';
import { f1 } from './geometry';

/**
 * Small SVG building blocks shared by the decoration art (decorations.tsx):
 * gradient helpers and the Keys mascot's head and paws. Components
 * only (kept apart from the art table so Fast Refresh can hot-swap them).
 */

/** Linear gradient helper (objectBoundingBox, top -> bottom unless given). */
export const Lin: React.FC<{ id: string; stops: Array<[number, string]>; x1?: number; y1?: number; x2?: number; y2?: number }> = ({ id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1 }) => (
    <linearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2}>
        {stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}
    </linearGradient>
);
export const Rad: React.FC<{ id: string; stops: Array<[number, string]>; cx?: number; cy?: number; r?: number; user?: boolean; fx?: number; fy?: number }> = ({ id, stops, cx = 0.5, cy = 0.5, r = 0.5, user, fx, fy }) => (
    <radialGradient id={id} cx={cx} cy={cy} r={r} fx={fx} fy={fy} gradientUnits={user ? 'userSpaceOnUse' : undefined}>
        {stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}
    </radialGradient>
);

export const KeysHead: React.FC<{ u: string; t: HSL; mood?: number }> = ({ u, t, mood = 0 }) => {
    const eye = '#0B0F1E';
    const happy = (x: number) => `M${x} 41 l5 -5 l5 5 l5 -5 l5 5`;
    return (
        // The 110x92 Keys head from mascot/Keys.tsx, placed so its flat base hides behind the avatar's top edge.
        <g transform="translate(0.5 -42) scale(0.9)">
            <defs>
                <Lin id={`${u}-kd`} stops={[[0, shade(t, 12)], [0.55, shade(t, 0)], [1, shade(t, -12)]]} />
            </defs>
            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill={`url(#${u}-kd)`} />
            <path d="M30 24 A26 26 0 0 1 52 15.5" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="3" strokeLinecap="round" />
            <g stroke={eye} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
                {mood === 1 ? (
                    <>
                        <path d="M29.5 38 q6.5 5 13 0" /><path d="M66.5 38 q6.5 5 13 0" />
                    </>
                ) : mood === 2 ? (
                    <>
                        <path d={happy(28.5)} transform="translate(0 -3)" /><path d="M58 37.5 q8 -5 16 0" />
                    </>
                ) : (
                    <>
                        <path d={happy(28.5)} transform="translate(0 -3)" /><path d={happy(56.5)} transform="translate(0 -3)" />
                    </>
                )}
            </g>
        </g>
    );
};
/** Two of Keys' legs over the avatar's top edge: he is holding on, not floating. */
// His two OUTER legs (Keys.tsx x=29 / 80.9 -> 26.6 / 73.3 here) are exactly
// where the avatar's rim is, so they drape over it, angled to the curve.
export const KeysPaws: React.FC<{ t: HSL }> = ({ t }) => (
    <g strokeLinecap="round">
        {([[26.6, -26], [73.3, 26]] as const).map(([x, rot]) => (
            <g key={x} transform={`rotate(${rot} ${x} 6)`}>
                <line x1={x + 0.9} y1="5.4" x2={x + 0.9} y2="12.6" stroke="#000" strokeOpacity=".3" strokeWidth="8.6" />
                <line x1={x} y1="3" x2={x} y2="10.6" stroke={shade(t, 0)} strokeWidth="8.6" />
                <line x1={x - 2} y1="3.4" x2={x - 2} y2="8" stroke="#fff" strokeOpacity=".3" strokeWidth="1.5" />
                <path d={`M${x - 2.2} 11.6 L${x - 2.2} 13.2 M${x + 2.2} 11.6 L${x + 2.2} 13.2`} stroke={shade(t, -30)} strokeWidth="1.1" />
            </g>
        ))}
    </g>
);

/** A tilted orbit (cosmetics/halos.tsx): centre, tilt in degrees, semi-axes. */
export interface OrbitFrame { cx: number; cy: number; tilt: number; rx: number; ry: number }

/** One half of an orbit frame: everything inside is in the frame's own coordinates (centre 0,0, x along the major axis). */
export const OrbitHalf: React.FC<{ id: string; f: OrbitFrame; half: 'far' | 'near'; children: React.ReactNode }> = ({ id, f, half, children }) => (
    <g transform={`translate(${f1(f.cx)} ${f1(f.cy)}) rotate(${f1(f.tilt)})`}>
        <defs>
            <clipPath id={id} clipPathUnits="userSpaceOnUse">
                <rect x={-f.rx - 20} y={half === 'far' ? -f.ry - 40 : 0} width={2 * f.rx + 40} height={f.ry + 40} />
            </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>{children}</g>
    </g>
);

const BAT_WING = 'M0 -0.6 C -1.6 -2.6, -4.2 -3.6, -7.6 -2.4 C -6.6 -1.6, -6.4 -0.6, -6.8 0.6 C -5.6 -0.2, -4.6 0, -4 0.9 C -3.2 0.1, -2.2 0.2, -1.4 1.2 Z';
/**
 * A bat seen from the front, wings beating (bat halo). `rimW` is the moonlit rim's width in the bat's own units: a
 * hairline at card size, thicker at thumbnail size, where a dark silhouette on a dark tile shows only by its rim.
 */
export const Bat: React.FC<{ s: number; delay: number; rim: string; rimW?: number }> = ({ s, delay, rim, rimW = 0.35 }) => (
    <g transform={`scale(${f1(s)})`}>
        {/* Both wings beat as one group (one animation per bat, not per wing): the flap scales about the body's axis. */}
        <g className="pc-flap" style={{ animationDelay: `${f1(delay)}s` }}>
            <path d={BAT_WING} fill="#120B1F" stroke={rim} strokeWidth={f1(rimW)} strokeLinejoin="round" />
            <path d={BAT_WING} transform="scale(-1 1)" fill="#120B1F" stroke={rim} strokeWidth={f1(rimW)} strokeLinejoin="round" />
        </g>
        <ellipse cy=".3" rx="1.25" ry="1.9" fill="#120B1F" stroke={rim} strokeWidth={f1(rimW * 0.86)} />
        <path d="M-1 -1.2 L-1.1 -2.9 L-0.35 -1.7 L0.35 -1.7 L1.1 -2.9 L1 -1.2 Z" fill="#120B1F" />
        <circle cx="-.45" cy="-.9" r=".22" fill="#FFB34D" />
        <circle cx=".45" cy="-.9" r=".22" fill="#FFB34D" />
    </g>
);
