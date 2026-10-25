import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BadgeCheck, Crown } from 'lucide-react';
import { eggBadgeCount, resolveProfileBadgeColor, resolveProfileBadgeIcon, sortProfileBadges, type ProfileBadge } from '../utils/profileBadges';
import { useClTooltip } from './cl/useClTooltip';
import { EggTierIcon } from './EggTierIcon';
import { EGG_IDS, parseEggTierIcon } from '../utils/eggProgress';
import { formatProDuration, formatProSinceTooltip, parseProSince, proMonthsElapsed } from '../utils/proSince';
import { MAX_LEVEL } from '../utils/profileExtras';
import { levelFill } from '../utils/profileCardLayout';
import { useEscape } from '../hooks/useEscape';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { ProfileLinkIcon } from './ProfileLinkIcon';
import '../styles/profile-card.css';

/**
 * Profile badges as ONE designed set: every badge is the same round medallion
 * (tinted fill, hairline rim, centred glyph, a hover/focus tooltip), whatever
 * it is - the profile level, Pro, an admin-granted badge, the Egg hunter
 * badge (whose egg count sits on the medallion as a small bubble) or a
 * verified Steam account.
 *
 * On the card (`ProfileBadgeStrip`) the medallions are buttons that DO
 * something (owner request 2026-10-24): the level opens the achievements,
 * Steam opens the Steam profile, and Pro / Egg hunter / admin badges open a
 * small popover that says what they are (the egg one: how many found, never
 * which). Keyboard: Enter / Space activate, Escape closes the popover.
 *
 * `ProfileBadgeRow` draws the server's `badges` array alone (the Friends rows
 * use it, at the dense `sm` size, non-interactive).
 *
 * Renders `null` for nothing to show - no wrapper element, no layout shift.
 */
export interface ProfileBadgeRowProps {
    badges: readonly ProfileBadge[] | null | undefined;
    /** `md` - 24px medallion, for the profile card. `sm` - 16px, for a dense
     *  list row (friends list); icon-only (the egg count is in the tooltip). */
    size?: 'sm' | 'md';
    className?: string;
}

const SWATCH: Record<'sm' | 'md', { box: number; icon: number }> = {
    sm: { box: 16, icon: 10 },
    md: { box: 24, icon: 13 },
};

export const ProfileBadgeRow: React.FC<ProfileBadgeRowProps> = ({ badges, size = 'md', className }) => {
    if (!badges || badges.length === 0) return null;
    return (
        <span className={`pbm-row pbm-row--${size}${className ? ` ${className}` : ''}`}>
            {sortProfileBadges(badges).map((b, i) => <BadgeMedallion key={b.badge_id} badge={b} size={size} index={i} />)}
        </span>
    );
};

/** The card's row: level, Pro, Steam, then the server's badges. Null when there is nothing. */
export const ProfileBadgeStrip: React.FC<{
    badges?: readonly ProfileBadge[] | null;
    isPro?: boolean;
    /** Month ("YYYY-MM") the Pro period began, for the tooltip. */
    proSince?: string | null;
    level?: number;
    /** Level ring pressed: open the achievements. Absent = the ring only has its tooltip. */
    onLevel?: () => void;
    /** A verified Steam account to show (and open). */
    steam?: { label: string; onOpen: () => void } | null;
    className?: string;
}> = ({ badges, isPro, proSince, level, onLevel, steam, className }) => {
    const sorted = badges && badges.length > 0 ? sortProfileBadges(badges) : [];
    const lead = (level && level > 0 ? 1 : 0) + (isPro ? 1 : 0) + (steam ? 1 : 0);
    if (lead === 0 && sorted.length === 0) return null;
    let i = 0;
    return (
        <span className={`pbm-row pbm-row--md${className ? ` ${className}` : ''}`} data-testid="profile-badges">
            {!!level && level > 0 && <LevelMedallion level={level} index={i++} onActivate={onLevel} />}
            {isPro && <ProMedallion proSince={proSince} index={i++} interactive />}
            {steam && <SteamMedallion label={steam.label} onOpen={steam.onOpen} index={i++} />}
            {sorted.map((b) => <BadgeMedallion key={b.badge_id} badge={b} size="md" index={i++} interactive />)}
        </span>
    );
};

// ── the popover a medallion can open ─────────────────────────────────────────

const POP_W = 232;

/** A small floating note under a medallion, portaled to <body> (the card clips). Escape / outside click closes. */
const BadgePopover: React.FC<{
    anchor: HTMLElement;
    id: string;
    label: string;
    onClose: () => void;
    children: React.ReactNode;
}> = ({ anchor, id, label, onClose, children }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
    useLayoutEffect(() => {
        const r = anchor.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, r.left + r.width / 2 - POP_W / 2));
        const above = r.bottom + 120 > window.innerHeight;
        setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
    }, [anchor]);
    useEscape(onClose);
    const inside = useCallback((t: Node) => !!(ref.current?.contains(t) || anchor.contains(t)), [anchor]);
    useDismissOnOutsideClick(inside, true, onClose);
    return createPortal(
        <div
            ref={ref} id={id} role="dialog" aria-label={label} className="pbm-pop"
            data-above={pos?.above ? 'true' : undefined}
            style={pos ? { left: pos.left, top: pos.top, width: POP_W } : { visibility: 'hidden', left: 0, top: 0, width: POP_W }}
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </div>,
        document.body,
    );
};

/** Shared shell: focusable, named, tooltip-bearing; a button when it does something. */
const Medallion: React.FC<{
    label: string;
    tip: React.ReactNode;
    className: string;
    box: number;
    index: number;
    testId?: string;
    /** Pressing it runs this... */
    onActivate?: () => void;
    /** ...or opens this popover. */
    popover?: { title: string; body: React.ReactNode };
    children: React.ReactNode;
}> = ({ label, tip, className, box, index, testId, onActivate, popover, children }) => {
    // The element the popover hangs from while it is open (null = closed).
    const [openAt, setOpenAt] = useState<HTMLElement | null>(null);
    const open = !!openAt;
    const popId = useId();
    // The tooltip stays for pointer hover; it is redundant while the popover says more.
    const { anchorProps, tooltip, describedBy } = useClTooltip(open ? '' : tip);
    const { ref: setRef, ...handlers } = anchorProps;
    const style = { width: box, height: box, ['--i' as string]: index } as React.CSSProperties;
    const interactive = !!onActivate || !!popover;
    if (!interactive) {
        return (
            <span ref={setRef as React.Ref<HTMLSpanElement>} {...handlers} tabIndex={0} role="img" aria-label={label} aria-describedby={describedBy}
                data-testid={testId} className={`pbm ${className}`} style={style}>
                {children}
                {tooltip}
            </span>
        );
    }
    return (
        <>
            <button
                ref={setRef as React.Ref<HTMLButtonElement>} {...handlers} type="button" aria-label={label}
                aria-describedby={describedBy} aria-haspopup={popover ? 'dialog' : undefined}
                aria-expanded={popover ? open : undefined} aria-controls={popover && open ? popId : undefined}
                data-testid={testId} className={`pbm pbm--btn ${className}`} style={style}
                onClick={(e) => { e.stopPropagation(); if (onActivate) onActivate(); else setOpenAt(openAt ? null : e.currentTarget); }}
            >
                {children}
                {tooltip}
            </button>
            {popover && openAt && (
                <BadgePopover anchor={openAt} id={popId} label={popover.title} onClose={() => setOpenAt(null)}>
                    <b>{popover.title}</b>
                    {popover.body}
                </BadgePopover>
            )}
        </>
    );
};

/** One admin / egg badge. */
const BadgeMedallion: React.FC<{ badge: ProfileBadge; size: 'sm' | 'md'; index: number; interactive?: boolean }> = ({ badge, size, index, interactive }) => {
    const tokens = resolveProfileBadgeColor(badge.color);
    const { box, icon } = SWATCH[size];
    // The synthesized Egg hunter badge (`egg-tier-N`) is the one icon NOT in
    // the lucide allowlist: it maps to the house ocean glyphs in EggTierIcon.
    // An unknown `egg-tier-9` falls through to the generic fallback.
    // React.createElement, not `<Icon />`: the lookup result is a fixed
    // allowlisted component, but a capitalised local used as a JSX tag reads as
    // a component defined during render to `react-hooks/static-components`.
    const eggTier = parseEggTierIcon(badge.icon);
    const iconEl = eggTier
        ? <EggTierIcon tier={eggTier} size={icon + 2} />
        : React.createElement(resolveProfileBadgeIcon(badge.icon), {
            style: { width: icon, height: icon },
            strokeWidth: 2.25,
            'aria-hidden': 'true',
        });
    const count = eggBadgeCount(badge);
    const shownCount = size === 'md' && eggTier ? count : undefined;
    // Egg hunter: how many, of how many - never which (that would spoil them).
    const popover = !interactive ? undefined : eggTier ? {
        title: badge.label,
        body: <EggProgress found={count ?? 0} total={EGG_IDS.length} />,
    } : {
        title: badge.label,
        body: <p>A badge from the Cipherline team.</p>,
    };
    return (
        <Medallion label={badge.label} tip={badge.label} box={box} index={index} popover={popover} className={`${tokens.bg} ${tokens.border} ${tokens.text}`}>
            {iconEl}
            {shownCount !== undefined && <span data-egg-count aria-hidden="true" className="pbm-count">{shownCount}</span>}
        </Medallion>
    );
};

const EggProgress: React.FC<{ found: number; total: number }> = ({ found, total }) => {
    const n = Math.min(found, total);
    return (
        <>
            <p>Found {n} of {total} hidden easter eggs.</p>
            <span className="pbm-pop-bar" aria-hidden="true"><i style={{ transform: `scaleX(${total ? n / total : 0})` }} /></span>
            <p className="pbm-pop-faint">Where they are stays a secret.</p>
        </>
    );
};

/** Pro: a gold crown medallion; the tooltip / popover say since when (month precision) when the server says so. */
export const ProMedallion: React.FC<{ proSince?: string | null; index?: number; interactive?: boolean }> = ({ proSince, index = 0, interactive }) => {
    const tip = useMemo(() => formatProSinceTooltip(proSince) ?? 'Cipherline Pro', [proSince]);
    const tokens = resolveProfileBadgeColor('gold');
    const since = parseProSince(proSince);
    const popover = interactive ? {
        title: 'Cipherline Pro',
        body: since
            ? <p>Pro since {new Date(Date.UTC(since.year, since.month - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}, {formatProDuration(proMonthsElapsed(since, new Date()))}.</p>
            : <p>Supports Cipherline with Pro.</p>,
    } : undefined;
    return (
        <Medallion label={tip} tip={tip} box={24} index={index} testId="pro-badge" popover={popover} className={`${tokens.bg} ${tokens.border} ${tokens.text}`}>
            <Crown style={{ width: 13, height: 13 }} strokeWidth={2.25} aria-hidden="true" />
        </Medallion>
    );
};

/** Verified Steam: opens the Steam profile through the validated external-link path. */
const SteamMedallion: React.FC<{ label: string; onOpen: () => void; index: number }> = ({ label, onOpen, index }) => (
    <Medallion label={`Steam, verified: ${label}. Opens in your browser.`} tip={`Steam, verified: ${label}`} box={24} index={index} testId="steam-badge"
        onActivate={onOpen} className="pbm-steam">
        <ProfileLinkIcon platform="steam" size={13} />
        <span className="pbm-tick" aria-hidden="true"><BadgeCheck size={10} strokeWidth={2.6} /></span>
    </Medallion>
);

/** Profile level: the number inside a ring that is `level / MAX_LEVEL` full. Cosmetic only. */
export const LevelMedallion: React.FC<{ level: number; index?: number; onActivate?: () => void }> = ({ level, index = 0, onActivate }) => {
    const r = 11.25;
    const c = 2 * Math.PI * r;
    const fill = levelFill(level, MAX_LEVEL);
    const label = level >= MAX_LEVEL ? `Profile level ${level} (max)` : `Profile level ${level} of ${MAX_LEVEL}`;
    return (
        <Medallion label={onActivate ? `${label}. Show achievements` : label} tip={onActivate ? `${label}. Click for achievements` : label}
            box={24} index={index} testId="profile-level" className="pbm-level" onActivate={onActivate}>
            <svg viewBox="0 0 26 26" aria-hidden="true" focusable="false">
                <circle cx="13" cy="13" r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="2" />
                <circle className="pbm-arc" cx="13" cy="13" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    strokeDasharray={`${(c * fill).toFixed(2)} ${c.toFixed(2)}`} />
            </svg>
            <b>{level}</b>
        </Medallion>
    );
};

export default ProfileBadgeRow;
