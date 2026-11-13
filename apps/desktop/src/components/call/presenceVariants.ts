import type React from 'react';
import type { Variants, TargetAndTransition } from 'framer-motion';
import { presenceNow, type PresenceTracker } from '../../utils/callPresenceLifecycle';

/**
 * Join / leave animations for people in a call — one family for every surface
 * that shows a call's participants (server sidebar rows, the floating huddle
 * card, the in-call rows / DM-group grid / video strips, fullscreen).
 *
 * Timing and easing are the call card's own (ServerContextPanel's huddle-call
 * card enter/exit, SidebarConference's tile glide), so a mid-call join reads
 * as the same motion as the first join that brings the card in:
 *   enter  ease-out [0.22, 1, 0.36, 1]  — the card's 0.18 s entrance curve
 *   exit   ease-in  [0.4, 0, 1, 1]      — the card's 0.22 s exit curve
 *   glide  [0.4, 0, 0.2, 1]             — SIDEBAR_GLIDE (height/reflow)
 *
 * Everything is framer-motion (JS / WAAPI), never a CSS keyframe class: a CSS
 * animation restarts when its node is reparented, and the call panel's portal
 * roots are reparented on resize and navigation (memory:
 * portal_reparent_animation_gotcha). Whether a join animates is decided ONCE,
 * from the participant's lifecycle (utils/callPresenceLifecycle claimEnter),
 * when the wrapper mounts — not from the mount itself — so a layout switch that
 * remounts a tile does not replay it.
 */
export const CALL_EASE_ENTER = [0.22, 1, 0.36, 1] as const;
export const CALL_EASE_EXIT = [0.4, 0, 1, 1] as const;
export const CALL_EASE_GLIDE = [0.4, 0, 0.2, 1] as const;
export const CALL_GLIDE_S = 0.32;
/** The call card's own entrance / exit (ServerContextPanel huddle-call card). */
export const CALL_CARD_ENTER = { duration: 0.18, ease: CALL_EASE_ENTER };
export const CALL_CARD_EXIT = { duration: 0.22, ease: CALL_EASE_EXIT };
/** Person-level join / leave. */
export const CALL_JOIN_S = 0.28;
export const CALL_LEAVE_S = 0.24;

// ── Rows (sidebar lists) ────────────────────────────────────────────────────
// A row grows its height from 0 while it fades and drops in from 6 px above —
// the card's own `y: -6` entrance — so the rows below glide down with it rather
// than jumping. Leaving reverses it. Height (not a transform) because the row
// sits in a card whose background and everything below it must follow; it's
// the same trade SidebarConference's tileGlideVariants made, on a single
// ~44 px row, and `overflow: hidden` is only on while the row is moving.
export const ROW_JOIN_FROM: TargetAndTransition = { height: 0, opacity: 0, y: -6 };
export const ROW_SHOWN: TargetAndTransition = {
    height: 'auto', opacity: 1, y: 0,
    transition: {
        height: { duration: 0.26, ease: CALL_EASE_GLIDE },
        opacity: { duration: 0.22, ease: CALL_EASE_ENTER, delay: 0.04 },
        y: { duration: CALL_JOIN_S, ease: CALL_EASE_ENTER, delay: 0.04 },
    },
};
export const ROW_LEAVE: TargetAndTransition = {
    height: 0, opacity: 0, y: -4,
    transition: {
        opacity: { duration: 0.16, ease: CALL_EASE_EXIT },
        y: { duration: 0.2, ease: CALL_EASE_EXIT },
        height: { duration: 0.24, ease: CALL_EASE_GLIDE, delay: 0.03 },
    },
};
/**
 * In-call rows (SidebarConference's voice / huddle list) as AnimatePresence
 * variants: a plain mount (e.g. someone's camera went off, so they moved from
 * the video strip into the rows) fades in at full height as before; a JOIN
 * grows in; every exit collapses (a leave, or a move into the video strip), so
 * the card never snaps shorter under a fading row.
 */
export const ROW_VARIANTS: Variants = {
    initial: { opacity: 0 },
    join: ROW_JOIN_FROM,
    animate: ROW_SHOWN,
    exit: ROW_LEAVE,
};
/** Reduced motion: no movement at all — a row is simply there or gone. */
export const ROW_STATIC: TargetAndTransition = { height: 'auto', opacity: 1, y: 0, transition: { duration: 0 } };
/**
 * A row clips its content only while its height is moving (otherwise the
 * content would spill over the row below at height 0). Driven from React, not
 * a variant's transitionEnd — framer left `overflow` stuck at 'hidden' that
 * way (measured in harness/call-anims), which would clip the speaking ring.
 */
export const CLIP: React.CSSProperties = { overflow: 'hidden' };

// ── Tiles (grids / strips) ──────────────────────────────────────────────────
/** A joiner's tile rises in from slightly small and below its slot. */
export const TILE_JOIN_FROM = { opacity: 0, scale: 0.88, y: 8 };
const TILE_JOIN_IN = {
    scale: 1, y: 0,
    transition: { duration: CALL_JOIN_S, ease: CALL_EASE_ENTER },
};
/** A leaver's tile shrinks back and fades — the join, reversed, on the exit curve. */
export const TILE_LEAVE_TO = { opacity: 0, scale: 0.88, y: 4 };
const TILE_LEAVE_TRANSITION = { duration: CALL_LEAVE_S, ease: CALL_EASE_EXIT };

export const REDUCED_TILE: Variants = {
    initial: { opacity: 0 },
    join: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.15 } },
    exit: { opacity: 0, transition: { duration: 0.12 } },
};

/** Handed to AnimatePresence as `custom` so an EXITING tile can ask "did this person leave?". */
export interface PresenceExitContext {
    isLeaving(id: string): boolean;
}

export function presenceExitContext(tracker: PresenceTracker | null): PresenceExitContext {
    return { isLeaving: id => !!tracker?.isLeaving(id, presenceNow()) };
}

type Target = Record<string, unknown> & { transition?: Record<string, unknown> };

const variantCache = new WeakMap<Variants, Map<string, Variants>>();

/**
 * Extends a surface's existing tile variants with a `join` start state and a
 * leave-aware `exit`. The base variants are untouched for every other mount /
 * unmount (a camera turning on, a stream being focused, the strip switching
 * branches): those keep their existing fade / glide.
 *
 * The exit is a variant FUNCTION of AnimatePresence's `custom`: an exiting
 * child can't receive new props, but AnimatePresence passes its latest
 * `custom` to exit resolvers (motion-dom animation-state: exit resolves with
 * presenceContext.custom). The id is closed over here, per child.
 */
export function presenceTileVariants(base: Variants, id: string): Variants {
    let byId = variantCache.get(base);
    if (!byId) { byId = new Map(); variantCache.set(base, byId); }
    const hit = byId.get(id);
    if (hit) return hit;

    const baseAnimate = (base.animate ?? {}) as Target;
    const baseExit = (base.exit ?? {}) as Target;
    const v: Variants = {
        ...base,
        join: { ...((base.initial ?? {}) as Target), ...TILE_JOIN_FROM },
        animate: {
            ...baseAnimate,
            ...TILE_JOIN_IN,
            transition: {
                ...(baseAnimate.transition ?? {}),
                scale: TILE_JOIN_IN.transition,
                y: TILE_JOIN_IN.transition,
            },
        },
        exit: ((ctx?: PresenceExitContext) => {
            if (!ctx?.isLeaving(id)) return baseExit;
            const t = (baseExit.transition ?? {}) as Record<string, unknown>;
            // Keep the surface's own collapse (height / margin glide) so the
            // strip still closes up smoothly; add the leave on top of it.
            return {
                ...baseExit,
                ...TILE_LEAVE_TO,
                transition: {
                    ...t,
                    opacity: TILE_LEAVE_TRANSITION,
                    scale: TILE_LEAVE_TRANSITION,
                    y: TILE_LEAVE_TRANSITION,
                },
            };
        }) as unknown as Variants[string],
    };
    byId.set(id, v);
    return v;
}
