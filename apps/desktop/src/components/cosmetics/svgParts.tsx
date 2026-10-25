import React from 'react';
import { shade, type HSL } from './colour';

/**
 * Small SVG building blocks shared by the decoration art (decorations.tsx):
 * gradient helpers, the Keys mascot's head and paws, a moon jelly. Components
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
/** A moon jelly (or two) drifting at the upper right, its bell pulsing. */
export const Jelly: React.FC<{ u: string; t: HSL; x: number; y: number; s: number; delay: number }> = ({ u, t, x, y, s, delay }) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
        <g className="pc-bob" style={{ animationDelay: `${delay}s` }}>
            <g className="pc-jelly" style={{ animationDelay: `${delay}s` }}>
                <g stroke={shade(t, 10)} fill="none" strokeLinecap="round">
                    {[-10.5, -7, -3.5, 0, 3.5, 7, 10.5].map((dx, i) => (
                        <path key={i} d={`M${dx} 3.6 q ${i % 2 ? 1.4 : -1.4} 6 0 12 t 0 ${8 + (i % 3) * 3}`} strokeOpacity=".32" strokeWidth=".35" />
                    ))}
                    <path d="M-3 4 q 3.4 6 -0.6 12 q -3.6 5.4 0.8 11" strokeOpacity=".7" strokeWidth="1.5" />
                    <path d="M3 4 q -3.4 6 0.6 12 q 3.6 5.4 -0.8 11" strokeOpacity=".7" strokeWidth="1.5" />
                </g>
                <path d="M-14 4 C -14 -11, 14 -11, 14 4 C 11 2.4, 7.6 5, 4.6 3.6 C 2 5.2, -2 5.2, -4.6 3.6 C -7.6 5, -11 2.4, -14 4 Z" fill={`url(#${u}-jb)`} stroke={shade(t, 14)} strokeWidth=".9" strokeLinejoin="round" />
                <g fill="none" stroke={shade(t, 26)} strokeOpacity=".85" strokeWidth=".9">
                    <path d="M-6.6 -1.4 a2.3 2.3 0 1 1 3.8 1.6" /><path d="M6.6 -1.4 a2.3 2.3 0 1 0 -3.8 1.6" />
                    <path d="M-3.2 -5.6 a2.2 2.2 0 1 1 3.4 -1.2" /><path d="M3.2 -5.6 a2.2 2.2 0 1 0 -3.4 -1.2" />
                </g>
                <path d="M-9 -4.4 C -7 -7.8, -3 -8.8, 0 -8.8" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth=".9" strokeLinecap="round" />
            </g>
        </g>
    </g>
);
