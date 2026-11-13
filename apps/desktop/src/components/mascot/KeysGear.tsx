import React from 'react';
import type { Gear, PileTier } from '../../utils/keysMirror';
import { BROWS } from '../../utils/keysBrain';

/**
 * The gear Keys wears, holds and has beside him on the Home deck, in three
 * layers (HomeKeys places them): BACK (beside / behind him, still: the TV,
 * the ring light, the safe, the DND sign), ON (on his body, inside his
 * gesture wrapper so it moves with him: headset, mask, crown, lantern, what
 * he is holding) and FRONT (above / in front of him, still: bubbles, the
 * unread pile, the puffs, the paper plane).
 *
 * Every piece is ALWAYS mounted, at rest invisible; `is-on` makes it appear.
 * That is what lets home-keys-mirror.css give every piece a real entry AND
 * exit (CSS transitions, which also reverse cleanly when interrupted), and
 * the art is drawn once, not on every state change. Each piece is an html
 * span (its own compositor layer while it moves) around a small static svg:
 * nothing inside an svg ever animates. Shapes are in Keys' own viewBox
 * (110 x 92) where they sit on him. Everything is aria-hidden: HomeKeys
 * puts what he is doing into his accessible name instead.
 */

type On = (g: Gear) => boolean;
const cls = (base: string, on: boolean) => `hkg ${base}${on ? ' is-on' : ''}`;
const SVG = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 110 92" focusable="false" aria-hidden="true" {...p} />;

// ── BACK ─────────────────────────────────────────────────────────────────────

export const GearBack: React.FC<{ on: On }> = ({ on }) => (
    <div className="hkg-stage hkg-stage--back" aria-hidden="true">
        {/* A little CRT on the floor to his left, the game flickering on it. */}
        <span className={cls('hkg-tv', on('tv'))}>
            <svg viewBox="0 0 60 56" focusable="false">
                <path d="M22 10 L14 1 M38 10 L47 2" stroke="var(--cl-raise)" strokeWidth="2" strokeLinecap="round" fill="none" />
                <rect x="2" y="9" width="56" height="40" rx="8" fill="var(--cl-deep)" stroke="var(--cl-border)" strokeWidth="2" />
                <rect x="13" y="49" width="6" height="5" rx="2" fill="var(--cl-raise)" />
                <rect x="41" y="49" width="6" height="5" rx="2" fill="var(--cl-raise)" />
                <circle cx="51" cy="20" r="2.2" fill="var(--cl-raise)" />
                <circle cx="51" cy="28" r="2.2" fill="var(--cl-raise)" />
            </svg>
            {/* The screen: three washes cross-fading (opacity only). */}
            <span className="hkg-tv-screen">
                <i className="hkg-tv-a" /><i className="hkg-tv-b" /><i className="hkg-tv-c" />
                <b className="hkg-tv-pix" />
            </span>
            {/* Sharing your game in a call: you're live. */}
            <span className={cls('hkg-live', on('live'))}><i />LIVE</span>
        </span>
        {/* Camera on: a ring light on a stand to his right. */}
        <span className={cls('hkg-ring', on('ringlight'))}>
            <i className="hkg-ring-halo" />
            <svg viewBox="0 0 40 70" focusable="false">
                <path d="M20 38 L20 66 M12 68 L28 68" stroke="var(--cl-raise)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                <circle cx="20" cy="20" r="15" fill="none" stroke="var(--cl-glow)" strokeWidth="5" />
                <circle cx="20" cy="20" r="15" fill="none" stroke="#FFF4D6" strokeWidth="1.5" opacity=".8" />
                <circle cx="20" cy="20" r="3.5" fill="var(--cl-deep)" stroke="var(--cl-raise)" strokeWidth="1.5" />
            </svg>
        </span>
        {/* A backup running: a little safe for the papers to go into. */}
        <span className={cls('hkg-safe', on('safe'))}>
            <svg viewBox="0 0 40 40" focusable="false">
                <rect x="2" y="4" width="36" height="34" rx="5" fill="var(--cl-deep)" stroke="var(--cl-border)" strokeWidth="2" />
                <rect x="8" y="9" width="24" height="3" rx="1.5" fill="var(--cl-abyss)" />
                <circle cx="20" cy="25" r="7" fill="none" stroke="var(--cl-lume)" strokeWidth="2" />
                <path d="M20 25 L20 20" stroke="var(--cl-lume)" strokeWidth="2" strokeLinecap="round" />
            </svg>
        </span>
        {/* DND: a do-not-disturb sign planted beside him. */}
        <span className={cls('hkg-sign', on('sign'))}>
            <svg viewBox="0 0 24 44" focusable="false">
                <path d="M12 22 L12 43" stroke="var(--cl-raise)" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="12" cy="12" r="10.5" fill="var(--cl-flash)" />
                <rect x="5.5" y="10" width="13" height="4" rx="2" fill="#fff" />
            </svg>
        </span>
    </div>
);

// ── ON HIM ───────────────────────────────────────────────────────────────────

export const GearOn: React.FC<{ on: On; lanternDim: boolean }> = ({ on, lanternDim }) => (
    <span className="hkg-on" aria-hidden="true">
        {/* The TV's light on his dome, flickering with the game. */}
        <span className={cls('hkg-tvglow', on('tvglow'))}><i className="hkg-tv-a" /><i className="hkg-tv-b" /><i className="hkg-tv-c" /></span>
        {/* Invisible: only his eyes are left, floating. */}
        <span className={cls('hkg-camoeyes', on('camoEyes'))}>
            <SVG><path d={BROWS.awakeL} /><path d={BROWS.awakeR} /></SVG>
        </span>
        {/* DND: an eye mask with sleepy eyes stitched on. */}
        <span className={cls('hkg-mask', on('mask'))}>
            <SVG>
                <path d="M22 38 Q21 31 30 30.5 L80 30.5 Q89 31 88 38 Q89 45 80 45.5 L30 45.5 Q21 45 22 38 Z" fill="var(--cl-deep)" stroke="var(--cl-border)" strokeWidth="1.2" />
                <path d="M34 37 q6 4.5 12 0 M64 37 q6 4.5 12 0" stroke="#EFFFFC" strokeWidth="2" strokeLinecap="round" fill="none" opacity=".85" />
            </SVG>
        </span>
        {/* DND: big over-ear headphones. */}
        <span className={cls('hkg-phones', on('headphones'))}>
            <SVG>
                <path d="M17 44 A38 38 0 0 1 93 44" stroke="var(--cl-flash)" strokeWidth="4.5" fill="none" strokeLinecap="round" />
                <rect x="10" y="33" width="13" height="21" rx="6" fill="var(--cl-deep)" stroke="var(--cl-flash)" strokeWidth="2" />
                <rect x="87" y="33" width="13" height="21" rx="6" fill="var(--cl-deep)" stroke="var(--cl-flash)" strokeWidth="2" />
            </SVG>
        </span>
        {/* In a call: a headset with a boom mic. */}
        <span className={cls('hkg-headset', on('headset'))}>
            <SVG>
                <path d="M21.5 44 A33.5 33.5 0 0 1 88.5 44" stroke="var(--cl-deep)" strokeWidth="3.5" fill="none" strokeLinecap="round" />
                <rect x="13" y="36" width="10" height="15" rx="4.5" fill="var(--cl-deep)" stroke="var(--cl-raise)" strokeWidth="1.5" />
                <rect x="87" y="36" width="10" height="15" rx="4.5" fill="var(--cl-deep)" stroke="var(--cl-raise)" strokeWidth="1.5" />
                <path d="M18 50 Q20 58 32 57" stroke="var(--cl-deep)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                <circle cx="33.5" cy="57" r="3" fill="var(--cl-glow)" />
            </SVG>
            <i className="hkg-mic" />
        </span>
        {/* His wardrobe (utils/keysWardrobe.ts): at most one of these, and
            only when nothing else claims his head. The crown is Pro's. The
            dome is the arc centred (55, 48), r 34: its top is y 14, his
            brows sit at y 35-42. */}
        <span className={cls('hkg-crown', on('crown'))}>
            <SVG>
                <g transform="rotate(-16 42 14)">
                    <path d="M32 18 L33 7 L38 12.5 L42 5 L46 12.5 L51 7 L52 18 Z" fill="var(--cl-glow)" stroke="#C9952A" strokeWidth="1" strokeLinejoin="round" />
                    <circle cx="42" cy="14.5" r="1.6" fill="var(--cl-flash)" />
                </g>
            </SVG>
        </span>
        {/* A coral knit beanie: ribbed cuff, a pom-pom, worn a touch askew. */}
        <span className={cls('hkg-beanie', on('beanie'))}>
            <SVG>
                <g transform="rotate(-6 55 22)">
                    <path d="M25.5 27 C25.5 4 84.5 4 84.5 27 Z" fill="var(--cl-flash)" />
                    <path d="M39 9.5 C37 14 36.5 20 37 25 M55 6.5 L55 24 M71 9.5 C73 14 73.5 20 73 25" stroke="#E0544A" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                    <path d="M23.5 30.5 Q55 16 86.5 30.5" stroke="#C94A41" strokeWidth="7.5" strokeLinecap="round" fill="none" />
                    <path d="M30 26.5 L30.6 31.4 M37 23.6 L37.4 28.6 M44 21.8 L44.2 26.8 M51 21 L51 26 M58 21 L58 26 M65 21.6 L64.8 26.6 M72 23.2 L71.6 28.2 M79 25.8 L78.4 30.8" stroke="#A83C35" strokeWidth="1.3" strokeLinecap="round" />
                    <circle cx="55" cy="4.5" r="5.6" fill="#FFE3DF" />
                    <circle cx="53.3" cy="3" r="1.8" fill="#FFFFFF" opacity=".75" />
                </g>
            </SVG>
        </span>
        {/* A tiny captain's cap, perched and tipped: white top, navy band,
            gold cord and badge, a dark peak. */}
        <span className={cls('hkg-captain', on('captain'))}>
            <SVG>
                <g transform="rotate(9 58 15)">
                    <path d="M40 10.5 Q37 1.5 58 1 Q79 1.5 76 10.5 Z" fill="#F4F7FF" stroke="#C9D3EE" strokeWidth="1" strokeLinejoin="round" />
                    <rect x="41.5" y="9.5" width="33" height="7.5" rx="2" fill="#24346A" />
                    <path d="M42.5 10.6 L73.5 10.6" stroke="var(--cl-glow)" strokeWidth="1" strokeLinecap="round" />
                    <path d="M40 16.4 Q58 25 76 16.4 Q58 20.5 40 16.4 Z" fill="#0E1430" />
                    <path d="M50 18.6 Q58 21 66 18.6" stroke="#5E6B8F" strokeWidth=".9" strokeLinecap="round" fill="none" opacity=".8" />
                    <circle cx="58" cy="13.4" r="2.9" fill="var(--cl-glow)" stroke="#C9952A" strokeWidth=".7" />
                    <path d="M58 11.6 L58 15.2 M56.5 14.3 Q58 15.9 59.5 14.3" stroke="#8C6418" strokeWidth=".8" strokeLinecap="round" fill="none" />
                </g>
            </SVG>
        </span>
        {/* A dive mask over his eyes (they show through the glass), its strap
            round the back, and a snorkel up his right side. */}
        <span className={cls('hkg-snorkel', on('snorkel'))}>
            <SVG>
                <path d="M88.5 46 Q93 46 93 40 L93 7" stroke="var(--cl-flash)" strokeWidth="4" strokeLinecap="round" fill="none" />
                <path d="M93 9 L93 4" stroke="var(--cl-glow)" strokeWidth="4.6" strokeLinecap="round" />
                <path d="M84 44 Q88 47 91 45" stroke="#C94A41" strokeWidth="3" strokeLinecap="round" fill="none" />
                <path d="M21.5 38 L27 37 M83 37 L88.5 38" stroke="#1E2A55" strokeWidth="3.4" strokeLinecap="round" />
                <path d="M27 31 Q27 27.5 31 27.5 L79 27.5 Q83 27.5 83 31 L83 41 Q83 46.5 77 46.5 L62 46.5 Q58.5 46.5 57 43.5 L55 41.5 L53 43.5 Q51.5 46.5 48 46.5 L33 46.5 Q27 46.5 27 41 Z" fill="#BFF6EE" fillOpacity=".28" stroke="var(--cl-glow)" strokeWidth="2.8" strokeLinejoin="round" />
                <path d="M33 32 L38.5 30.5 M72 31.5 L76 30.5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
            </SVG>
        </span>
        {/* Sunglasses pushed up on his dome: the lenses catch a little coral
            and gold, and his eyes stay free. */}
        <span className={cls('hkg-shades', on('shades'))}>
            <SVG>
                <g transform="rotate(-4 55 22)">
                    <path d="M26.5 25.5 L33 22.6 M83.5 25.5 L77 22.6" stroke="#1E2A55" strokeWidth="2.2" strokeLinecap="round" />
                    <path d="M33 19 Q33 16.5 35.5 16.5 L50.5 16.5 Q53 16.5 52.5 19 L51.5 24 Q50.5 28.5 46 28.5 L39.5 28.5 Q34 28.5 33.4 24 Z" fill="#141B36" stroke="#2A3558" strokeWidth="1" />
                    <path d="M57.5 19 Q57 16.5 59.5 16.5 L74.5 16.5 Q77 16.5 77 19 L76.6 24 Q76 28.5 70.5 28.5 L64 28.5 Q59.5 28.5 58.5 24 Z" fill="#141B36" stroke="#2A3558" strokeWidth="1" />
                    <path d="M52.5 18.6 Q55 16.6 57.5 18.6" stroke="#2A3558" strokeWidth="1.8" fill="none" strokeLinecap="round" />
                    <path d="M35.5 25 L50 25 M60 25 L74.5 25" stroke="var(--cl-flash)" strokeWidth="2" strokeLinecap="round" opacity=".55" />
                    <path d="M36 21.6 L49.6 21.6 M60.4 21.6 L74.2 21.6" stroke="var(--cl-glow)" strokeWidth="1.2" strokeLinecap="round" opacity=".45" />
                    <path d="M37 19.4 L40 18.6 M61.5 19.4 L64.5 18.6" stroke="#FFFFFF" strokeWidth="1.3" strokeLinecap="round" opacity=".8" />
                </g>
            </SVG>
        </span>
        {/* A little sea flower tucked by his left ear. */}
        <span className={cls('hkg-flower', on('flower'))}>
            <SVG>
                <path d="M34 25 Q38 30 37 33.5" stroke="#139E8C" strokeWidth="2" strokeLinecap="round" fill="none" />
                <path d="M36.5 29 Q42 27.5 42 32 Q37.5 33.5 36.5 29 Z" fill="#139E8C" />
                <g transform="translate(29 21)">
                    {[0, 72, 144, 216, 288].map(a => (
                        <ellipse key={a} cx="0" cy="-5.2" rx="4" ry="5.4" transform={`rotate(${a + 10})`} fill="#FF8FA3" stroke="#E2566E" strokeWidth=".8" />
                    ))}
                    <circle r="3.1" fill="var(--cl-glow)" />
                    <circle cx="-.8" cy="-.8" r=".9" fill="#FFF4D6" />
                </g>
            </SVG>
        </span>
        {/* Night dive: a headlamp lure, like the anglerfish down here. */}
        <span className={cls(`hkg-lantern${lanternDim ? ' is-dim' : ''}`, on('lantern'))}>
            <i className="hkg-lantern-halo" />
            <SVG>
                <path d="M24 30 Q55 21 86 30" stroke="var(--cl-deep)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                <path d="M66 24 C67 10 80 2 91 6" stroke="var(--cl-muted, #A7B3D4)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
                <circle className="hkg-lantern-bulb" cx="93" cy="8" r="4.2" fill="var(--cl-glow)" />
            </SVG>
        </span>
        {/* In his hands (one at a time, see keysMirror's precedence). */}
        <span className={cls('hkg-pad', on('controller'))}>
            <SVG>
                <path d="M38 59 Q35 59 33 63 L30 70 Q29 74 33 74 Q35 74 38 71 L72 71 Q75 74 77 74 Q81 74 80 70 L77 63 Q75 59 72 59 Z" fill="var(--cl-deep)" stroke="var(--cl-raise)" strokeWidth="1.4" />
                <path d="M40 62.5 L40 68.5 M37 65.5 L43 65.5" stroke="var(--cl-lume)" strokeWidth="2" strokeLinecap="round" />
                <circle cx="68" cy="63.5" r="1.8" fill="var(--cl-flash)" />
                <circle cx="72" cy="66.5" r="1.8" fill="var(--cl-glow)" />
                <circle cx="64.5" cy="66.5" r="1.8" fill="var(--cl-ok)" />
            </SVG>
        </span>
        <span className={cls('hkg-frame', on('frame'))}>
            <SVG>
                <rect x="32" y="45" width="46" height="29" rx="3.5" fill="var(--cl-deep)" stroke="var(--cl-text, #E8EEFF)" strokeWidth="1.4" />
                <rect x="35.5" y="48.5" width="39" height="22" rx="1.5" fill="var(--cl-lume)" opacity=".35" />
                <path d="M38 66 L46 58 L52 63 L59 55 L72 66 Z" fill="var(--cl-lume)" opacity=".7" />
                <circle cx="44" cy="54" r="2.4" fill="var(--cl-glow)" />
            </SVG>
            <i className="hkg-frame-glare" />
        </span>
        <span className={cls('hkg-box', on('box'))}>
            <SVG>
                <rect x="35" y="55" width="40" height="22" rx="2" fill="#B98A55" stroke="#8C643A" strokeWidth="1.2" />
                <path d="M35 60 L75 60" stroke="#8C643A" strokeWidth="1" />
                <rect x="51" y="55" width="8" height="6" fill="#D9B98C" />
                <path d="M55 73 L55 65 M51.5 68.5 L55 65 L58.5 68.5" stroke="var(--cl-abyss)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </SVG>
        </span>
        <span className={cls('hkg-papers', on('papers'))}>
            <SVG>
                <rect x="39" y="58" width="30" height="16" rx="1.5" fill="#C9D3EE" transform="rotate(-4 54 66)" />
                <rect x="40" y="56" width="30" height="16" rx="1.5" fill="#E8EEFF" />
                <path d="M44 61 L64 61 M44 65 L60 65 M44 69 L62 69" stroke="#9AA6C8" strokeWidth="1.2" strokeLinecap="round" />
            </SVG>
            <i className="hkg-sheet" />
        </span>
        <span className={cls('hkg-mug', on('mug'))}>
            <SVG>
                <path d="M62 62 q7 0 7 5 q0 5 -7 5" stroke="var(--cl-flash)" strokeWidth="2.2" fill="none" />
                <rect x="45" y="58" width="18" height="17" rx="3" fill="var(--cl-flash)" />
                <rect x="45" y="58" width="18" height="3.5" rx="1.5" fill="#7A3A33" />
            </SVG>
            <i className="hkg-steam" /><i className="hkg-steam hkg-steam--b" />
        </span>
    </span>
);

// ── FRONT ────────────────────────────────────────────────────────────────────

/** Ten envelopes: the first three are the "few" pile, the next three the
 *  heap, the last four bury him to the eyes. Each has its own spot, tilt and
 *  the way it leaves (flung up and out) — CSS reads the custom properties. */
const ENVELOPES: { x: number; y: number; r: number; t: 1 | 2 | 3; w?: number; plane?: boolean }[] = [
    { x: 6, y: 80, r: -14, t: 1 },
    { x: 70, y: 82, r: 11, t: 1 },
    { x: 40, y: 86, r: -4, t: 1 },
    { x: 20, y: 70, r: 18, t: 2 },
    { x: 58, y: 69, r: -12, t: 2, plane: true },
    { x: 84, y: 66, r: 24, t: 2 },
    { x: 10, y: 56, r: -20, t: 3 },
    { x: 34, y: 58, r: 9, t: 3, w: 30 },
    { x: 62, y: 52, r: -7, t: 3, w: 30 },
    { x: 46, y: 44, r: 15, t: 3, plane: true },
];

const Envelope: React.FC = () => (
    <svg viewBox="0 0 24 16" focusable="false">
        <rect x=".75" y=".75" width="22.5" height="14.5" rx="2" fill="#E8EEFF" stroke="#9AA6C8" strokeWidth="1" />
        <path d="M1.5 1.8 L12 9 L22.5 1.8" stroke="#9AA6C8" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
        <circle cx="12" cy="9" r="2" fill="var(--cl-flash)" />
    </svg>
);

const PaperPlane: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} viewBox="0 0 32 22" focusable="false">
        <path d="M1 9 L31 1 L13 13 Z" fill="#F4F7FF" />
        <path d="M13 13 L31 1 L17 20 Z" fill="#C9D3EE" />
        <path d="M13 13 L14.5 19 L17 20 Z" fill="#9AA6C8" />
    </svg>
);

export const GearFront: React.FC<{
    on: On;
    pile: PileTier;
    reg: (k: 'plane' | 'bang' | 'shh' | 'stars' | 'ping') => (el: HTMLElement | null) => void;
}> = ({ on, pile, reg }) => (
    <div className="hkg-stage hkg-stage--front" aria-hidden="true">
        <span className="hkg-pile">
            {ENVELOPES.map((e, k) => (
                <span
                    key={k}
                    className={cls(`hkg-env hkg-env--t${e.t}`, pile >= e.t)}
                    style={{
                        left: `${e.x}%`, top: `${e.y}%`, width: `${e.w ?? 24}%`,
                        ['--r' as string]: `${e.r}deg`,
                        ['--ex' as string]: `${(e.x - 45) * 1.6}px`,
                        ['--d' as string]: `${(k % 3) * 70 + (e.t - 1) * 90}ms`,
                    }}
                >
                    {e.plane ? <PaperPlane /> : <Envelope />}
                </span>
            ))}
        </span>
        {/* No connection: a bubble with crossed-out signal bars. */}
        <span className={cls('hkg-bubble hkg-nosig', on('noSignal'))}>
            <svg viewBox="0 0 30 22" focusable="false">
                <rect x="7" y="13" width="3.5" height="5" rx="1" fill="var(--cl-faint, #5E6B8F)" />
                <rect x="13" y="9" width="3.5" height="9" rx="1" fill="var(--cl-faint, #5E6B8F)" />
                <rect x="19" y="5" width="3.5" height="13" rx="1" fill="var(--cl-faint, #5E6B8F)" />
                <path d="M6 4 L24 19" stroke="var(--cl-flash)" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
        </span>
        {/* In a call: a call bubble; its bars dance while you're speaking. */}
        <span className={cls('hkg-bubble hkg-callb', on('callBubble'))}>
            <svg className="hkg-callb-phone" viewBox="0 0 24 24" focusable="false">
                <path d="M6.6 3.5 L9.4 3.2 L11 7.8 L8.9 9.2 Q10.4 12.6 13.8 14.4 L15.3 12.3 L19.9 13.9 L19.6 16.7 Q19.3 19.4 16.6 19.3 Q5.2 18.4 4.3 6.7 Q4.2 3.9 6.6 3.5 Z" fill="var(--cl-lume)" />
            </svg>
            <i className="hkg-eq" /><i className="hkg-eq hkg-eq--b" /><i className="hkg-eq hkg-eq--c" />
        </span>
        {/* Napping. */}
        <span className={cls('hkg-zzz', on('zzz'))}><i>z</i><i>z</i><i>Z</i></span>
        {/* One-shot puffs (Web Animations from HomeKeys; invisible at rest). */}
        <span ref={reg('bang')} className="hkg-puff hkg-bang">!</span>
        <span ref={reg('shh')} className="hkg-puff hkg-shh">shh</span>
        <span ref={reg('stars')} className="hkg-puff hkg-stars"><i>✦</i><i>✧</i><i>✦</i></span>
        <span ref={reg('ping')} className="hkg-puff hkg-ping" />
        {/* A message arrived while you're on Home: a paper plane flies by. */}
        <span ref={reg('plane')} className="hkg-plane"><PaperPlane /></span>
    </div>
);
