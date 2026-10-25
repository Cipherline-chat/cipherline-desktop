import React, { useMemo, useRef, useState } from 'react';
import {
    Mic, Timer, Users, Flame, ShieldCheck, Server, MessageSquare, Egg, CalendarDays, Gamepad2, Moon, Ear, Laptop, Trophy, Lock,
    ChevronLeft, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { ACHIEVEMENTS, type AchievementDef, type Progress, type ProgressUnit } from '../../utils/achievements/catalog';
import { formatUnlockMonth } from '../../utils/achievements/format';
import { achievementsFor, featuredAchievements, type AchievementFilter } from '../../utils/profileCardLayout';
import { useAchievementProgress, type AchievementsData } from '../../hooks/useUserAchievements';
import { useEscape } from '../../hooks/useEscape';
import '../../styles/profile-card.css';

/**
 * Achievements on the profile card, in two sizes:
 *
 *  - `AchievementsSummary`: a section of the card - the count and three
 *    medallions (the owner's picks, else the rarest unlocked), with "View all".
 *  - `AchievementsSheet`: "View all", shown in place of the card's body - a
 *    compact grid filtered to Unlocked or Locked, with one detail line for the
 *    medallion you point at or focus. Never one long list.
 *
 * Achievements are client-attested and gate nothing. Your own card adds
 * progress (computed on this device, never sent).
 */

const ICONS: Record<string, LucideIcon> = {
    mic: Mic, timer: Timer, users: Users, flame: Flame, shield: ShieldCheck, server: Server, message: MessageSquare,
    egg: Egg, calendar: CalendarDays, gamepad: Gamepad2, moon: Moon, ear: Ear, laptop: Laptop,
};
const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' } as const;

function formatProgress(p: Progress, unit: ProgressUnit): string {
    const cur = Math.min(p.current, p.target);
    const n = (v: number) => (unit === 'hours' ? (v < 10 ? v.toFixed(1) : String(Math.floor(v))) : String(Math.floor(v)));
    const suffix = unit === 'hours' ? ' h' : unit === 'days' ? ' days' : unit === 'people' ? ' people' : '';
    return `${n(cur)} / ${n(p.target)}${suffix}`;
}

/** One round medallion: tier rim + glyph. Locked ones are hollow; with `progress` a thin ring shows how close. */
export const AchievementMedallion: React.FC<{
    def: AchievementDef;
    unlocked: boolean;
    size?: number;
    progress?: Progress | null;
}> = ({ def, unlocked, size = 40, progress }) => {
    const hidden = def.secret && !unlocked;
    const icon = hidden ? Lock : ICONS[def.icon] ?? Trophy;
    const frac = !unlocked && progress && progress.target > 0 ? Math.max(0, Math.min(1, progress.current / progress.target)) : 0;
    const r = size / 2 + 2.5;
    const c = 2 * Math.PI * r;
    const box = size + 8;
    return (
        <span className="pam" data-tier={def.tier} data-locked={unlocked ? undefined : 'true'} style={{ width: size, height: size }} aria-hidden="true">
            {React.createElement(icon, { style: { width: size * 0.45, height: size * 0.45 }, strokeWidth: 2 })}
            {frac > 0 && (
                <svg className="pam-prog" viewBox={`0 0 ${box} ${box}`} focusable="false">
                    <circle className="pam-arc" cx={box / 2} cy={box / 2} r={r} fill="none" stroke="var(--cl-lume, #25E0C8)" strokeWidth="2" strokeLinecap="round"
                        strokeDasharray={`${(c * frac).toFixed(2)} ${c.toFixed(2)}`} />
                </svg>
            )}
        </span>
    );
};

export interface AchievementsSummaryProps {
    /** Unlocked list (null while loading, or when not fetched because the owner's picks are enough). */
    data: AchievementsData | null;
    /** Unlocked count from the profile (public); used until `data` arrives. */
    count: number | null;
    /** The owner's picks (showcase.top_achievements). */
    picks: readonly string[];
    isSelf: boolean;
    onViewAll: () => void;
    viewAllRef?: React.Ref<HTMLButtonElement>;
    loading?: boolean;
}

/** The card section: "Achievements  9 of 24  View all" and three medallions. */
export const AchievementsSummary: React.FC<AchievementsSummaryProps> = ({ data, count, picks, isSelf, onViewAll, viewAllRef, loading }) => {
    const featured = featuredAchievements(data?.unlocked ?? null, picks);
    const n = data ? data.unlocked.length : count ?? 0;
    return (
        <section className="pcd-sec" aria-labelledby="pcd-ach-h" data-testid="achievements-summary">
            <div className="pcd-sec-head">
                <h3 className="pcd-sec-title" id="pcd-ach-h">
                    <Trophy size={13} aria-hidden="true" /> Achievements
                    <span className="pcd-sec-aside" data-testid="achievements-count">{n} of {ACHIEVEMENTS.length}</span>
                </h3>
                <button ref={viewAllRef} type="button" className="pcd-link-btn" onClick={(e) => { e.stopPropagation(); onViewAll(); }} data-testid="achievements-view-all">
                    View all<ChevronRight size={13} aria-hidden="true" />
                </button>
            </div>
            {featured.length > 0 ? (
                <ul className="pcd-ach">
                    {featured.map((def, j) => (
                        <li key={def.id} className="pcd-ach-item" title={def.description} data-testid={`achievement-chip-${def.id}`} style={{ ['--j' as string]: j } as React.CSSProperties}>
                            <AchievementMedallion def={def} unlocked size={40} />
                            <b>{def.name}</b>
                            <span className="pcd-ach-tier" data-tier={def.tier}>{TIER_LABEL[def.tier]}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="pcd-ach-empty" role={loading ? 'status' : undefined}>
                    {loading ? 'Loading achievements…' : isSelf ? 'None yet. View all to see how to earn them.' : 'None to show yet.'}
                </p>
            )}
        </section>
    );
};

export interface AchievementsSheetProps {
    data: AchievementsData | null;
    loading: boolean;
    error: boolean;
    isSelf: boolean;
    /** The card's "View all" sheet: a Back button and an Escape layer. Omit for the full profile's tab (embedded). */
    onBack?: () => void;
    onRetry?: () => void;
}

/** "View all": Unlocked / Locked, a compact grid, and a detail line for the pointed-at medallion. */
export const AchievementsSheet: React.FC<AchievementsSheetProps> = ({ data, loading, error, isSelf, onBack, onRetry }) => {
    const progress = useAchievementProgress();
    const unlocked = data?.unlocked ?? null;
    const months = useMemo(() => new Map((unlocked ?? []).map((u) => [u.id, u.month])), [unlocked]);
    const unlockedCount = months.size;
    const [filter, setFilter] = useState<AchievementFilter>(() => (unlockedCount > 0 || !isSelf ? 'unlocked' : 'locked'));
    const list = achievementsFor(filter, unlocked, isSelf ? progress : null);
    const [pointed, setPointed] = useState<string | null>(null);
    const current = list.find((d) => d.id === pointed) ?? list[0] ?? null;
    const gridRef = useRef<HTMLUListElement>(null);
    // Escape backs out of the sheet to the card (a layer above the card's own). Embedded: no layer.
    useEscape(() => onBack?.(), !!onBack);

    const onGridKeys = (e: React.KeyboardEvent) => {
        const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
        if (!keys.includes(e.key)) return;
        const btns = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const at = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        e.preventDefault();
        e.stopPropagation();
        // As many columns as the grid lays out (4 in the card, more on the full profile).
        const cols = Math.max(1, (gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length : 4) || 4);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1
            : e.key === 'ArrowRight' ? Math.min(btns.length - 1, at + 1)
            : e.key === 'ArrowLeft' ? Math.max(0, at - 1)
            : e.key === 'ArrowDown' ? Math.min(btns.length - 1, at + cols)
            : Math.max(0, at - cols);
        btns[next]?.focus();
    };

    const tab = (f: AchievementFilter, label: string, n: number) => (
        <button
            type="button" aria-pressed={filter === f}
            data-testid={`achievements-filter-${f}`}
            onClick={(e) => { e.stopPropagation(); setFilter(f); setPointed(null); }}
            onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault(); e.stopPropagation();
                const other: AchievementFilter = f === 'unlocked' ? 'locked' : 'unlocked';
                setFilter(other); setPointed(null);
                (e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-testid="achievements-filter-${other}"]`))?.focus();
            }}
        >{label}<span>{n}</span></button>
    );

    // Progress is your own and never shown for a secret one (it would hint at what it is).
    const p = current && isSelf && !current.secret && !months.has(current.id) ? progress?.[current.id] ?? null : null;
    const hidden = !!current && current.secret && !months.has(current.id);

    return (
        <section className={`pcd-sheet${onBack ? '' : ' pcd-sheet--embedded'}`} aria-label="All achievements" data-testid="achievements-panel">
            <div className="pcd-sheet-head">
                {onBack && (
                    <button type="button" className="pcd-back" aria-label="Back to profile" onClick={(e) => { e.stopPropagation(); onBack(); }} data-testid="achievements-back" autoFocus>
                        <ChevronLeft size={16} aria-hidden="true" />
                    </button>
                )}
                <h3>Achievements</h3>
                <span className="pcd-sec-aside">{unlockedCount} of {ACHIEVEMENTS.length}</span>
            </div>

            {!data && loading ? (
                <p className="pcd-sheet-empty" role="status">Loading achievements…</p>
            ) : !data && error ? (
                <div className="pcd-error">
                    <p>Couldn’t load achievements right now.</p>
                    {onRetry && <button type="button" className="pcd-link-btn" onClick={(e) => { e.stopPropagation(); onRetry(); }}>Try again</button>}
                </div>
            ) : (
                <>
                    <div className="pcd-seg" role="group" aria-label="Show">
                        {tab('unlocked', 'Unlocked', unlockedCount)}
                        {tab('locked', 'Locked', ACHIEVEMENTS.length - unlockedCount)}
                    </div>

                    {current && (
                        <div className="pcd-detail" key={`${filter}:${current.id}`} aria-live="polite" data-testid="achievement-detail">
                            <AchievementMedallion def={current} unlocked={months.has(current.id)} size={36} progress={p} />
                            <div className="pcd-detail-txt">
                                <b>{hidden ? 'Secret achievement' : current.name}</b>
                                <p>{hidden ? 'Keep exploring. It shows here once it is unlocked.' : current.description}</p>
                                <span className="pcd-detail-meta" data-tier={months.has(current.id) ? current.tier : undefined}>
                                    {TIER_LABEL[current.tier]}
                                    {months.has(current.id) ? ` · Unlocked ${formatUnlockMonth(months.get(current.id)!)}` : p ? ` · ${formatProgress(p, current.unit)}` : ' · Locked'}
                                </span>
                                {p && !hidden && (
                                    <div className="pcd-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                                        aria-valuenow={Math.round(Math.min(1, p.current / p.target) * 100)} aria-label={`${current.name} progress`}>
                                        <i style={{ transform: `scaleX(${Math.min(1, p.current / p.target)})` }} />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {list.length === 0 ? (
                        <p className="pcd-sheet-empty">
                            {filter === 'unlocked' ? (isSelf ? 'Nothing unlocked yet. Check Locked to see what to aim for.' : 'Nothing unlocked yet.') : 'Every achievement is unlocked.'}
                        </p>
                    ) : (
                        <ul className="pcd-grid" ref={gridRef} onKeyDown={onGridKeys} key={filter} aria-label={filter === 'unlocked' ? 'Unlocked achievements' : 'Locked achievements'}>
                            {list.map((def, k) => {
                                const on = months.has(def.id);
                                const secret = def.secret && !on;
                                return (
                                    <li key={def.id} style={{ ['--k' as string]: Math.min(k, 16) } as React.CSSProperties} data-testid={`achievement-${def.id}`} data-unlocked={on ? 'true' : 'false'}>
                                        <button
                                            type="button" className="pcd-grid-btn" data-unlocked={on ? 'true' : undefined}
                                            aria-pressed={current?.id === def.id}
                                            aria-label={secret ? 'Secret achievement, locked' : `${def.name}, ${TIER_LABEL[def.tier]}, ${on ? 'unlocked' : 'locked'}`}
                                            onPointerEnter={() => setPointed(def.id)} onFocus={() => setPointed(def.id)}
                                            onClick={(e) => { e.stopPropagation(); setPointed(def.id); }}
                                        >
                                            <AchievementMedallion def={def} unlocked={on} size={40} progress={isSelf && !on && !def.secret ? progress?.[def.id] ?? null : null} />
                                            <span className="pcd-grid-name">{secret ? '???' : def.name}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
};
