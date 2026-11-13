/**
 * Call presence lifecycle — who just JOINED a call, who is LEAVING it, and a
 * short-lived ghost for the leaver so the UI can animate them out before the
 * row / tile is removed.
 *
 * Why this exists (owner ask, 2026-10-28): the first join / last leave of a
 * server call animated (the whole call card enters and exits), but a person
 * joining or leaving a call that was already running just popped in / out.
 * DM and group calls had only a 0.14-0.2 s opacity blink. This is the one
 * piece of state every surface reads to animate those transitions the same way.
 *
 * Purely VISUAL bookkeeping. Nothing here gates, delays or reorders call logic:
 * the roster it is fed is the real one (LiveKit's participant list, or the
 * server's voice / huddle presence), and it is fed AFTER that roster changed.
 * A leaver's LiveKit disconnect, audio routing and E2EE key handling have all
 * already happened by the time their ghost starts fading.
 *
 * Three rules make the animations safe in the call panel:
 *
 *  1. A JOIN is a lifecycle event, not a mount. `claimEnter` answers "should
 *     this surface play the join animation for this person now?" exactly once
 *     per (surface, person, join) — so a tile that remounts because the layout
 *     changed (focus, fullscreen, the voice-channel strip switching between the
 *     inline and portaled branch, the sidebar portal root moving on navigation)
 *     does NOT replay the join. That is the portal-reparent gotcha
 *     (memory: portal_reparent_animation_gotcha) handled at the source: the
 *     animation is keyed on the join, never on the node's mount.
 *  2. People already in the call when we arrive are not "joining". The first
 *     `observe` (and anything discovered within `settleMs` of it — LiveKit
 *     discovers an existing room's members one by one over the first second,
 *     the same burst CallPane's 2 s join-sound gate covers) is the baseline.
 *  3. A rejoin during the leave animation cancels the ghost: the same entry
 *     goes back to `entering` (new join seq), so the still-mounted row animates
 *     back from wherever its exit had got to instead of being removed and
 *     re-added.
 *
 * Reduced motion: no ghosts (a leaver is removed at once) and no join claims.
 */

export type PresencePhase = 'entering' | 'present' | 'leaving';

export interface PresenceItem {
    id: string;
    phase: PresencePhase;
}

export interface PresenceTrackerOptions {
    /** How long after a join the person counts as `entering`. */
    enterMs?: number;
    /** How long a leaver's ghost is retained (≈ the leave animation). */
    leaveMs?: number;
    /** Arrivals within this long of the FIRST observe are the baseline, not joins. */
    settleMs?: number;
    /** Ids that count as joining even on the first observe (your own join). */
    selfJoinIds?: readonly string[];
    reducedMotion?: boolean;
}

/** Shared timings. `LEAVE_MS` must cover the longest leave animation (rows: 0.26 s). */
export const PRESENCE_ENTER_MS = 700;
export const PRESENCE_LEAVE_MS = 300;
/** LiveKit's discovery burst for a room we just joined (see rule 2 above). */
export const PRESENCE_LIVEKIT_SETTLE_MS = 1500;
/**
 * A second claim of the same (surface, person, join) within this window still
 * animates. It covers React StrictMode's double render of a mounting component
 * (both invocations must agree) — not a real remount, which is always a later
 * commit than this.
 */
const TWIN_CLAIM_MS = 40;

interface Entry {
    joinedAt: number;        // -Infinity for the baseline roster
    leftAt: number | null;   // non-null = ghost
    seq: number;             // bumps on every (re)join
}

export interface PresenceTracker {
    /** Feed the current roster. Idempotent for an unchanged roster. Returns true if anything changed. */
    observe(ids: readonly string[], now: number): boolean;
    /** Drop expired ghosts. Returns true if anything was removed. */
    prune(now: number): boolean;
    /** Current roster order with live ghosts kept where they were. */
    list(now: number): PresenceItem[];
    phase(id: string, now: number): PresencePhase | null;
    isLeaving(id: string, now: number): boolean;
    /** True once per (surface, id, join) while the person is `entering`. */
    claimEnter(surface: string, id: string, now: number): boolean;
    /** Ms until the next ghost expiry (null = none pending). */
    nextExpiryIn(now: number): number | null;
    setReducedMotion(reduced: boolean): void;
}

export function createPresenceTracker(opts: PresenceTrackerOptions = {}): PresenceTracker {
    const enterMs = opts.enterMs ?? PRESENCE_ENTER_MS;
    const leaveMs = opts.leaveMs ?? PRESENCE_LEAVE_MS;
    const settleMs = opts.settleMs ?? 0;
    const selfJoin = new Set(opts.selfJoinIds ?? []);
    let reduced = !!opts.reducedMotion;

    const entries = new Map<string, Entry>();
    const claims = new Map<string, number>();   // `${surface}\n${id}\n${seq}` → first claim time
    let order: string[] = [];                    // last merged order (live + ghosts)
    let startedAt: number | null = null;
    let lastKey: string | null = null;

    const isGhostLive = (e: Entry, now: number) => e.leftAt !== null && now - e.leftAt < leaveMs;

    function prune(now: number): boolean {
        let changed = false;
        for (const [id, e] of entries) {
            if (e.leftAt !== null && !isGhostLive(e, now)) {
                entries.delete(id);
                changed = true;
            }
        }
        if (changed) {
            order = order.filter(id => entries.has(id));
            for (const k of claims.keys()) {
                if (!entries.has(k.split('\n')[1])) claims.delete(k);
            }
        }
        return changed;
    }

    function observe(ids: readonly string[], now: number): boolean {
        const pruned = prune(now);
        const key = ids.join('\n');
        if (key === lastKey && startedAt !== null) return pruned;
        lastKey = key;
        const first = startedAt === null;
        if (first) startedAt = now;
        const baseline = first || now - (startedAt as number) < settleMs;
        const present = new Set(ids);
        let changed = pruned;

        for (const id of ids) {
            const e = entries.get(id);
            if (!e) {
                const joining = !baseline || (first && selfJoin.has(id));
                entries.set(id, { joinedAt: joining ? now : -Infinity, leftAt: null, seq: 1 });
                changed = true;
            } else if (e.leftAt !== null) {
                // Rejoin while the ghost is still animating out: cancel it.
                e.leftAt = null;
                e.joinedAt = now;
                e.seq += 1;
                changed = true;
            }
        }
        for (const [id, e] of entries) {
            if (e.leftAt === null && !present.has(id)) {
                if (reduced) entries.delete(id);
                else e.leftAt = now;
                changed = true;
            }
        }

        // Merge: live ids in roster order, ghosts re-inserted at the index they
        // last had, so the rest of the list doesn't jump before the ghost collapses.
        const ghosts = order
            .map((id, index) => ({ id, index }))
            .filter(g => !present.has(g.id) && entries.has(g.id));
        const merged = [...ids];
        for (const g of ghosts) merged.splice(Math.min(g.index, merged.length), 0, g.id);
        order = merged;
        return changed;
    }

    function phase(id: string, now: number): PresencePhase | null {
        const e = entries.get(id);
        if (!e) return null;
        if (e.leftAt !== null) return isGhostLive(e, now) ? 'leaving' : null;
        return now - e.joinedAt < enterMs ? 'entering' : 'present';
    }

    return {
        observe,
        prune,
        list(now) {
            return order
                .map(id => ({ id, phase: phase(id, now) }))
                .filter((it): it is PresenceItem => it.phase !== null);
        },
        phase,
        isLeaving: (id, now) => phase(id, now) === 'leaving',
        claimEnter(surface, id, now) {
            if (reduced) return false;
            const e = entries.get(id);
            if (!e || phase(id, now) !== 'entering') return false;
            const k = `${surface}\n${id}\n${e.seq}`;
            const at = claims.get(k);
            if (at === undefined) { claims.set(k, now); return true; }
            return now - at < TWIN_CLAIM_MS;
        },
        nextExpiryIn(now) {
            let next: number | null = null;
            for (const e of entries.values()) {
                if (e.leftAt === null) continue;
                const left = Math.max(0, e.leftAt + leaveMs - now);
                next = next === null ? left : Math.min(next, left);
            }
            return next;
        },
        setReducedMotion(r) {
            reduced = r;
            if (r) {
                for (const [id, e] of entries) if (e.leftAt !== null) entries.delete(id);
                order = order.filter(id => entries.has(id));
            }
        },
    };
}

// ── The live call's tracker ─────────────────────────────────────────────────
// One per call session, held OUTSIDE the component tree: SidebarConference
// remounts whenever its portal root moves (CallSidebarPortal re-portals on
// navigation) and FullscreenOverlay mounts fresh on every fullscreen toggle, so
// component state would forget who had already been animated in. Only the
// current call is kept.
let current: { key: string; tracker: PresenceTracker } | null = null;

export function callPresenceTracker(sessionKey: string, opts?: PresenceTrackerOptions): PresenceTracker {
    if (current?.key !== sessionKey) {
        current = {
            key: sessionKey,
            tracker: createPresenceTracker({ settleMs: PRESENCE_LIVEKIT_SETTLE_MS, ...opts }),
        };
    }
    return current.tracker;
}

/** The current call's tracker, if a call view has registered one. */
export function currentCallPresenceTracker(): PresenceTracker | null {
    return current?.tracker ?? null;
}

/** Test hook. */
export function __resetCallPresenceForTests(): void {
    current = null;
}

export const presenceNow = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
