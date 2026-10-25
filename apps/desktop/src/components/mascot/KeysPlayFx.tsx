import React from 'react';
import { BROWS } from '../../utils/keysBrain';
import type { FxTarget } from '../../utils/keysPlay';

/**
 * The small effects Keys' click reactions use (utils/keysPlay.ts), in the
 * same three layers as his gear (KeysGear.tsx): BACK (beside him: on the TV,
 * on the safe), ON (inside his gesture wrapper, so they move with him) and
 * FRONT (in front of him: envelopes, the DND wall, dust).
 *
 * HomeKeys mounts only the effects the current state uses (`fxFor`), plus
 * the rare idle props while one plays. Every one of them rests at opacity 0
 * (home-keys-play.css) and is seen only while its Web Animation runs, so
 * mounting or unmounting one never shows anything. aria-hidden throughout:
 * what he is doing is in his accessible name.
 */

type Reg = (t: FxTarget) => (el: HTMLElement | null) => void;

const BACK: ReadonlySet<string> = new Set(['gameover', 'hiscore', 'dial', 'door', 'vaultKey']);
const FRONT: ReadonlySet<string> = new Set(['wall', 'dust']);
const isBack = (t: FxTarget) => BACK.has(t) || t.startsWith('conf') || t.startsWith('shard');
const isFront = (t: FxTarget) => FRONT.has(t) || t.startsWith('env') || t.startsWith('aval');

/** Where each avalanche envelope comes to rest (the pile's own spots, so the
 *  avalanche buries him to the eyes like a full pile does). */
const AVAL_AT: { x: number; y: number }[] = [
    { x: 6, y: 80 }, { x: 70, y: 82 }, { x: 40, y: 86 }, { x: 20, y: 70 }, { x: 58, y: 69 },
    { x: 84, y: 66 }, { x: 10, y: 56 }, { x: 34, y: 58 }, { x: 62, y: 52 }, { x: 46, y: 44 },
];
const ENV_AT: { x: number; y: number }[] = [{ x: 34, y: 80 }, { x: 18, y: 74 }, { x: 58, y: 72 }];

const Envelope: React.FC = () => (
    <svg viewBox="0 0 24 16" focusable="false">
        <rect x=".75" y=".75" width="22.5" height="14.5" rx="2" fill="#E8EEFF" stroke="#9AA6C8" strokeWidth="1" />
        <path d="M1.5 1.8 L12 9 L22.5 1.8" stroke="#9AA6C8" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
        <circle cx="12" cy="9" r="2" fill="var(--cl-flash)" />
    </svg>
);

function fx(t: FxTarget, reg: Reg): React.ReactNode {
    const r = reg(t);
    const n = t.match(/\d+$/)?.[0];
    switch (t) {
        case 'gameover': return <span key={t} ref={r} className="hkp hkp-screen hkp-gameover">GAME<br />OVER</span>;
        case 'hiscore': return <span key={t} ref={r} className="hkp hkp-screen hkp-hiscore">HI<br />SCORE</span>;
        case 'dial':
            return (
                <span key={t} ref={r} className="hkp hkp-dial">
                    <svg viewBox="0 0 16 16" focusable="false">
                        <circle cx="8" cy="8" r="7" fill="var(--cl-deep)" stroke="var(--cl-lume)" strokeWidth="2" />
                        <path d="M8 8 L8 3" stroke="var(--cl-lume)" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </span>
            );
        case 'door': return <span key={t} ref={r} className="hkp hkp-door"><i /></span>;
        case 'vaultKey':
            return (
                <span key={t} ref={r} className="hkp hkp-vkey">
                    <svg viewBox="0 0 20 10" focusable="false">
                        <circle cx="4.5" cy="5" r="3.5" fill="none" stroke="var(--cl-glow)" strokeWidth="2" />
                        <path d="M8 5 L19 5 M15 5 L15 8.5 M18 5 L18 7.5" stroke="var(--cl-glow)" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </span>
            );
        case 'wall': return <span key={t} ref={r} className="hkp hkp-wall"><b>DO NOT<br />DISTURB</b></span>;
        case 'dust': return <span key={t} ref={r} className="hkp hkp-dust" />;
        case 'finger': return <span key={t} ref={r} className="hkp hkp-finger" />;
        case 'mute':
            return (
                <span key={t} ref={r} className="hkp hkp-mute">
                    <svg viewBox="0 0 20 20" focusable="false">
                        <rect x="7" y="3" width="6" height="9" rx="3" fill="var(--cl-text, #E8EEFF)" />
                        <path d="M4.5 10 Q4.5 15 10 15 Q15.5 15 15.5 10 M10 15 L10 18" stroke="var(--cl-text, #E8EEFF)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
                        <path d="M3.5 3 L16.5 17" stroke="var(--cl-flash)" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                </span>
            );
        case 'tap': return <span key={t} ref={r} className="hkp hkp-tap" />;
        case 'busy': return <span key={t} ref={r} className="hkp hkp-busy">BUSY</span>;
        case 'vol': return <span key={t} ref={r} className="hkp hkp-vol"><i /><i /><i /></span>;
        case 'stripes': return <span key={t} ref={r} className="hkp hkp-stripes" />;
        case 'antenna': return <span key={t} ref={r} className="hkp hkp-antenna" />;
        case 'gust': return <span key={t} ref={r} className="hkp hkp-gust"><i /><i /></span>;
        case 'beam': return <span key={t} ref={r} className="hkp hkp-beam" />;
        case 'moth': return <span key={t} ref={r} className="hkp hkp-moth"><i /><i /></span>;
        case 'paper':
            return (
                <span key={t} ref={r} className="hkp hkp-paper">
                    <b /><i /><i /><i /><i className="hkp-paper-pic" />
                </span>
            );
        default: break;
    }
    if (t.startsWith('conf')) return <span key={t} ref={r} className={`hkp hkp-bit hkp-conf hkp-conf--${n}`} />;
    if (t.startsWith('shard')) return <span key={t} ref={r} className={`hkp hkp-bit hkp-shard hkp-shard--${n}`} />;
    if (t.startsWith('squig')) {
        return (
            <span key={t} ref={r} className={`hkp hkp-squig hkp-squig--${n}`}>
                <svg viewBox="0 0 30 12" focusable="false"><path d="M1 6 L5 1.5 L9 10.5 L13 1.5 L17 10.5 L21 1.5 L25 10.5 L29 6" /></svg>
            </span>
        );
    }
    if (t.startsWith('env')) {
        const at = ENV_AT[Number(n)] ?? ENV_AT[0];
        return <span key={t} ref={r} className="hkp hkp-env" style={{ left: `${at.x}%`, top: `${at.y}%` }}><Envelope /></span>;
    }
    if (t.startsWith('aval')) {
        const at = AVAL_AT[Number(n)] ?? AVAL_AT[0];
        return <span key={t} ref={r} className="hkp hkp-env hkp-aval" style={{ left: `${at.x}%`, top: `${at.y}%` }}><Envelope /></span>;
    }
    if (t.startsWith('doc')) return <span key={t} ref={r} className={`hkp hkp-doc hkp-doc--${n}`}><i /></span>;
    if (t.startsWith('drop')) return <span key={t} ref={r} className="hkp hkp-drop" />;
    if (t.startsWith('csp') || t.startsWith('shine')) return <span key={t} ref={r} className={`hkp hkp-twinkle hkp-${t}`} />;
    if (t.startsWith('ball')) return <span key={t} ref={r} className={`hkp hkp-ball hkp-ball--${n}`} />;
    return null;
}

export const PlayBack: React.FC<{ fx: readonly FxTarget[]; reg: Reg }> = ({ fx: list, reg }) => {
    const items = list.filter(isBack);
    if (!items.length) return null;
    const tv = items.filter(t => t === 'gameover' || t === 'hiscore' || t.startsWith('conf') || t.startsWith('shard'));
    const safe = items.filter(t => t === 'dial' || t === 'door' || t === 'vaultKey');
    return (
        <div className="hkg-stage hkg-stage--back hkp-stage" aria-hidden="true">
            {tv.length > 0 && <span className="hkp-at-tv">{tv.map(t => fx(t, reg))}</span>}
            {safe.length > 0 && <span className="hkp-at-safe">{safe.map(t => fx(t, reg))}</span>}
        </div>
    );
};

export const PlayOn: React.FC<{ fx: readonly FxTarget[]; reg: Reg; oneEye: boolean }> = ({ fx: list, reg, oneEye }) => {
    const items = list.filter(t => !isBack(t) && !isFront(t));
    if (!items.length && !oneEye) return null;
    return (
        <span className="hkp-on" aria-hidden="true">
            {items.map(t => fx(t, reg))}
            {/* Asleep, poked: one eye opens and glares, the other stays shut. */}
            {oneEye && (
                <svg className="hkp-oneeye" viewBox="0 0 110 92" focusable="false">
                    <path d={BROWS.closedL} />
                    <path d="M62 33 L76 37" />
                    <path d="M63.5 39.5 L74.5 39.5" />
                </svg>
            )}
        </span>
    );
};

export const PlayFront: React.FC<{ fx: readonly FxTarget[]; reg: Reg }> = ({ fx: list, reg }) => {
    const items = list.filter(isFront);
    if (!items.length) return null;
    return (
        <div className="hkg-stage hkg-stage--front hkp-stage" aria-hidden="true">
            {items.map(t => fx(t, reg))}
        </div>
    );
};
