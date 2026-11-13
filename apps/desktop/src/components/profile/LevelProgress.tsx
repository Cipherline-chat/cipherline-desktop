import React, { useEffect, useId, useRef } from 'react';
import { Egg, Lock, Trophy } from 'lucide-react';
import { MAX_LEVEL } from '../../utils/profileExtras';
import { levelProgress, pointsLabel, TIER_POINTS, EGG_POINT } from '../../utils/levelProgress';
import '../../styles/profile-card.css';

/**
 * The level, opened: what pressing someone's level medallion shows at the top
 * of their Achievements tab (the unlocked / locked list follows under it).
 *
 *   Level 3                                   7 to go
 *   9 of 16 points to level 4
 *   [=========-------------]
 *   5 achievements  ·  4 easter eggs found
 *
 * Everything here is public profile data the server already sends to any
 * signed-in viewer: the level, the points behind it, the unlocked count and
 * the Egg hunter badge COUNT (never which eggs). No per-achievement progress:
 * those counters stay on the owner's device.
 *
 * `level === null` = the server did not share a level with this viewer: the
 * section says so and shows nothing else.
 */
export interface LevelProgressProps {
    level: number | null;
    /** Points behind the level (resolveLevelPoints); null = unknown, draw the level only. */
    points: number | null;
    /** Unlocked achievements; null = unknown. */
    achievementCount: number | null;
    /** From the Egg hunter badge; null = no badge (nothing to say). */
    eggCount: number | null;
    isSelf: boolean;
    name?: string | null;
    /** Bump to move focus here (the level medallion was pressed). */
    focusSignal?: number;
}

export const LevelProgress: React.FC<LevelProgressProps> = ({ level, points, achievementCount, eggCount, isSelf, name, focusSignal = 0 }) => {
    const ids = useId();
    const ref = useRef<HTMLElement>(null);
    useEffect(() => { if (focusSignal > 0) ref.current?.focus({ preventScroll: true }); }, [focusSignal]);

    if (level === null) {
        return (
            <section ref={ref} tabIndex={-1} className="plp plp--hidden" aria-labelledby={`${ids}-h`} data-testid="level-progress" data-state="hidden">
                <span className="plp-lock" aria-hidden="true"><Lock size={18} /></span>
                <div className="plp-body">
                    <h3 className="plp-title" id={`${ids}-h`}>Level not shared</h3>
                    <p className="plp-line">{name ? `${name} doesn’t share their level with you.` : 'This level isn’t shared with you.'}</p>
                </div>
            </section>
        );
    }

    const m = levelProgress(level, points);
    const r = 25;
    const c = 2 * Math.PI * r;
    const ringFill = m.max ? 1 : m.level / MAX_LEVEL;
    const sources: React.ReactNode[] = [];
    if (achievementCount !== null) {
        sources.push(<li key="a"><Trophy size={13} aria-hidden="true" />{achievementCount} achievement{achievementCount === 1 ? '' : 's'}</li>);
    }
    if (eggCount !== null && eggCount > 0) {
        sources.push(<li key="e" data-testid="level-progress-eggs"><Egg size={13} aria-hidden="true" />{eggCount} easter egg{eggCount === 1 ? '' : 's'} found</li>);
    }

    return (
        <section ref={ref} tabIndex={-1} className="plp" aria-labelledby={`${ids}-h`} data-testid="level-progress" data-max={m.max ? 'true' : undefined}>
            <span className="plp-ring" aria-hidden="true">
                <svg viewBox="0 0 60 60" focusable="false">
                    <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="3.5" />
                    <circle className="pbm-arc plp-arc" cx="30" cy="30" r={r} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"
                        strokeDasharray={`${(c * ringFill).toFixed(2)} ${c.toFixed(2)}`} />
                </svg>
                <b>{m.level}</b>
            </span>
            <div className="plp-body">
                <div className="plp-head">
                    <h3 className="plp-title" id={`${ids}-h`}>
                        Level {m.level}{m.max && <span className="plp-max">Max</span>}
                    </h3>
                    {m.remaining !== null && <span className="plp-togo" data-testid="level-progress-togo">{pointsLabel(m.remaining)} to go</span>}
                </div>
                <p className="plp-line" data-testid="level-progress-line">{m.line}</p>
                <div className="pcd-prog plp-bar" role="progressbar" aria-labelledby={`${ids}-h`}
                    aria-valuemin={0} aria-valuemax={m.nextPoints ?? m.points ?? MAX_LEVEL} aria-valuenow={m.points ?? m.level}
                    aria-valuetext={m.line} data-testid="level-progress-bar">
                    <i style={{ transform: `scaleX(${m.fraction})` }} />
                </div>
                {sources.length > 0 && <ul className="plp-src" aria-label={isSelf ? 'Where your points come from' : 'Where the points come from'}>{sources}</ul>}
                <p className="plp-how">
                    Points per unlock: bronze {TIER_POINTS.bronze} · silver {TIER_POINTS.silver} · gold {TIER_POINTS.gold} · easter egg {EGG_POINT}
                </p>
            </div>
        </section>
    );
};

export default LevelProgress;
