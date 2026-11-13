import React, { useMemo, useState } from 'react';
import { motion, PresenceContext, useIsPresent, type MotionProps, type Variants } from 'framer-motion';
import { presenceNow, type PresencePhase, type PresenceTracker } from '../../utils/callPresenceLifecycle';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { usePresenceRoster } from '../../hooks/usePresenceRoster';
import {
    CALL_JOIN_S, CALL_EASE_ENTER, ROW_JOIN_FROM, ROW_SHOWN, ROW_LEAVE, ROW_STATIC, ROW_VARIANTS,
    CLIP, TILE_JOIN_FROM, REDUCED_TILE, presenceTileVariants,
} from './presenceVariants';

/**
 * Join / leave animation COMPONENTS for people in a call. The timing tokens,
 * variants and the leave-aware exit live in ./presenceVariants (shared with
 * SidebarConference / ServerContextPanel / JoiningCallView); the lifecycle
 * state in utils/callPresenceLifecycle; the server-roster hook in
 * hooks/usePresenceRoster.
 */
type PresenceMotionProps = Omit<MotionProps, 'variants' | 'initial' | 'animate' | 'exit'> & {
    /** Participant identity. */
    pid: string;
    /** Which kind of surface this is ('cam', 'share', 'audio', 'fs', …) — one join animation per surface. */
    surface: string;
    tracker: PresenceTracker | null;
    /** The surface's existing variants (initial / animate / exit). Ignored for kind 'row'. */
    variants?: Variants;
    /** 'tile' (default): base variants + join pop / leave shrink. 'row': ROW_VARIANTS. */
    kind?: 'tile' | 'row';
    className?: string;
    style?: React.CSSProperties;
    ref?: React.Ref<HTMLDivElement>;
    children?: React.ReactNode;
};

/**
 * A call tile's motion wrapper. Drop-in for the `motion.div` a surface already
 * renders (same variants, layout and transition props), plus a join animation
 * when — and only when — this person just joined and this surface hasn't
 * already shown it. `ref` is forwarded (React 19 ref-as-prop) because
 * AnimatePresence's popLayout measures its direct children through it.
 */
export function PresenceMotion({ pid, surface, tracker, variants, kind = 'tile', ref, ...rest }: PresenceMotionProps) {
    const reduced = usePrefersReducedMotion();
    // Decided once, at mount: a later re-render (or a remount after the join
    // window / on another branch of the same surface) never replays it.
    const [join] = useState(() => !reduced && !!tracker?.claimEnter(surface, pid, presenceNow()));
    const v = useMemo(
        () => (reduced ? REDUCED_TILE : kind === 'row' ? ROW_VARIANTS : presenceTileVariants(variants ?? REDUCED_TILE, pid)),
        [reduced, kind, variants, pid],
    );
    const isPresent = useIsPresent();
    const [joinDone, setJoinDone] = useState(!join);
    const clip = kind === 'row' && !reduced && (!joinDone || !isPresent);
    return (
        <motion.div
            ref={ref}
            {...rest}
            style={clip ? { ...rest.style, ...CLIP } : rest.style}
            onAnimationComplete={(def) => { if (def === 'animate') setJoinDone(true); rest.onAnimationComplete?.(def); }}
            data-presence-join={join ? 'true' : undefined}
            variants={v}
            initial={join ? 'join' : 'initial'}
            animate="animate"
            exit="exit"
        />
    );
}

/**
 * Join-only wrapper for surfaces with no exit handling of their own
 * (fullscreen grid / strip cells). Renders a plain motion.div that animates
 * from TILE_JOIN_FROM only if the person just joined; otherwise it is inert
 * (initial={false}), so entering fullscreen never plays anything.
 */
export function PresenceEnter({ pid, surface, tracker, className, style, children }: {
    pid: string; surface: string; tracker: PresenceTracker | null;
    className?: string; style?: React.CSSProperties; children?: React.ReactNode;
}) {
    const reduced = usePrefersReducedMotion();
    const [join] = useState(() => !reduced && !!tracker?.claimEnter(surface, pid, presenceNow()));
    return (
        <PresenceIsolation>
        <motion.div
            className={className}
            style={style}
            data-presence-join={join ? 'true' : undefined}
            initial={join ? TILE_JOIN_FROM : false}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: CALL_JOIN_S, ease: CALL_EASE_ENTER }}
        >
            {children}
        </motion.div>
        </PresenceIsolation>
    );
}

/**
 * Detaches a subtree from any ancestor AnimatePresence. framer-motion blocks
 * the initial animation of EVERY motion descendant of an AnimatePresence child
 * that was present on that AnimatePresence's first render with initial={false}
 * (presenceContext.initial === false → blockInitialAnimation) — and that
 * context value never changes. ServerContextPanel's call cards sit in exactly
 * such an AnimatePresence (initial={false}, so cards already there when the
 * panel opens don't animate), which silently disabled every row join inside a
 * card that was already on screen: the bug this module exists to fix. Rows
 * have no exit of their own (their leave is the `leaving` phase), so nothing
 * is lost by not seeing the ancestor's presence.
 */
export function PresenceIsolation({ children }: { children?: React.ReactNode }) {
    return <PresenceContext.Provider value={null}>{children}</PresenceContext.Provider>;
}

// ── Server-state rosters (sidebar rows) ─────────────────────────────────────

/**
 * One sidebar row's presence wrapper: grows in on a join, collapses out on a
 * leave, inert otherwise. `phase` comes from usePresenceRoster; whether to
 * animate the join is claimed at mount.
 */
export function PresenceRow({ pid, phase, tracker, surface = 'row', className, children }: {
    pid: string; phase: PresencePhase; tracker: PresenceTracker; surface?: string;
    className?: string; children?: React.ReactNode;
}) {
    const reduced = usePrefersReducedMotion();
    const [join] = useState(() => !reduced && tracker.claimEnter(surface, pid, presenceNow()));
    const target = reduced ? ROW_STATIC : phase === 'leaving' ? ROW_LEAVE : ROW_SHOWN;
    const [moving, setMoving] = useState(join);
    // Only a change of TARGET (leaving ⇄ shown) moves the row; entering → present doesn't.
    const leaving = phase === 'leaving';
    const [wasLeaving, setWasLeaving] = useState(leaving);
    if (wasLeaving !== leaving) { setWasLeaving(leaving); setMoving(!reduced); }
    return (
        <motion.div
            className={className}
            data-presence={phase}
            data-presence-join={join ? 'true' : undefined}
            // A leaving ghost can't be clicked / dragged as if it were still there.
            style={{
                ...(moving ? CLIP : null),
                ...(phase === 'leaving' ? { pointerEvents: 'none' as const } : null),
            }}
            onAnimationComplete={() => { if (!leaving) setMoving(false); }}
            aria-hidden={phase === 'leaving' ? true : undefined}
            initial={join ? ROW_JOIN_FROM : false}
            animate={target}
        >
            {children}
        </motion.div>
    );
}

/**
 * Convenience: render a server-state roster with join / leave rows.
 * `renderRow(id, phase)` draws the row content (keyed by this component).
 */
export function PresenceRoster({ ids, selfJoinIds, rowClassName, renderRow }: {
    ids: readonly string[];
    selfJoinIds?: readonly string[];
    rowClassName?: string;
    renderRow: (id: string, phase: PresencePhase) => React.ReactNode;
}) {
    const { items, tracker } = usePresenceRoster(ids, { selfJoinIds });
    return (
        <PresenceIsolation>
            {items.map(it => (
                <PresenceRow key={it.id} pid={it.id} phase={it.phase} tracker={tracker} className={rowClassName}>
                    {renderRow(it.id, it.phase)}
                </PresenceRow>
            ))}
        </PresenceIsolation>
    );
}
