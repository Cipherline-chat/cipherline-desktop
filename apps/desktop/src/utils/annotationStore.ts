/**
 * annotationStore — the single source of truth for in-call annotations.
 *
 * A tiny external store (useSyncExternalStore) rather than a slice of
 * CallContext: the toolbar (draw mode, colour) and every VideoTile (the
 * canvas) need the same state, nothing else in the app does, and keeping it
 * out of the context keeps Phase 1 from touching Dashboard at all. Phase 2
 * adds remote strokes to the same `strokes` map; Phase 3 adds grants beside
 * it.
 *
 * THERE IS ONE TOOL: the laser, and a laser stroke is a WHOLE MARK, not a
 * comet. While the pen is down the stroke is solid and complete — every point
 * it has ever had, at full opacity. When the pen lifts, the whole thing fades
 * out together over LASER_TTL_MS and is gone. That is a deliberate
 * simplification of an earlier pen/laser pair — with no persistent mark there
 * is no tool to pick, nothing to undo and nothing to clear, which is why none
 * of those exist here any more.
 *
 * An intermediate design faded every POINT on its own clock so the tail
 * vanished while the head still moved. It did guarantee expiry, but it broke
 * the thing the feature is for: the line you are drawing eroded under your own
 * hand, and drawing each segment separately at its own opacity turned the
 * trail into a string of DOTS (adjacent round line caps compositing against
 * each other at different alphas). Both renderers now draw a stroke as ONE
 * path at ONE opacity, and expiry is per stroke again.
 *
 * The expiry guarantee that motivated per-point ageing is kept by a WATCHDOG
 * instead — see STROKE_IDLE_MS. A stroke that stops receiving points is
 * treated as abandoned and fades exactly as if it had been released, so a lost
 * pointerup, a peer who left mid-stroke, or a truncated remote stream can no
 * longer pin a mark on someone's screen forever.
 *
 * Strokes are stored per TRACK — keyed by the publishing participant's
 * identity plus the source (camera vs screen share are separate surfaces) —
 * and every point is normalized to the video's intrinsic frame (see
 * annotationGeometry). Nothing here touches the DOM or the network, so all
 * of it is testable in plain vitest.
 *
 * Bounds are enforced HERE, on every mutation, not in the UI: they are the
 * same limits a receiver will apply to remote strokes in Phase 2, so local
 * and remote data can never diverge in shape.
 */
import { useSyncExternalStore } from 'react';
import type { Point } from './annotationGeometry';

export interface Stroke {
    id: string;
    /** LiveKit identity of the participant who drew it. */
    by: string;
    color: string;
    /** Line width in CSS px at a 1920-wide frame; renderers scale it. */
    width: number;
    /**
     * Every point the stroke has ever had. Nothing is ever removed from the
     * head: the mark stays whole for as long as it is being drawn.
     */
    points: Point[];
    /**
     * ms epoch (LOCAL clock) of the last point appended. Read ONLY by the
     * abandonment watchdog in expireLasers — a stroke that has not grown in
     * STROKE_IDLE_MS is one whose release is never coming.
     *
     * Local clock, never carried on the wire: nothing a peer sends can make a
     * stroke look younger than it is, and two machines with skewed clocks still
     * age their copies at the same rate. For a remote stroke this is when WE
     * last received points for it, which is the only liveness signal a receiver
     * actually has.
     */
    updatedAt: number;
    /**
     * ms epoch (LOCAL clock) at which the stroke CLOSED and started to fade;
     * 0 while it is still live. This is the whole of the expiry model:
     *
     *   - 0            → solid, full opacity, never removed. The pen is down.
     *   - t            → fading; gone once `now - t >= LASER_TTL_MS`.
     *
     * Set in exactly two places: endStroke (the pen lifted, or a peer's
     * `stroke.end` arrived) and the watchdog in expireLasers (nobody is ever
     * going to lift it). Both mean the same thing to every renderer, which is
     * why an abandoned stroke fades identically to a released one instead of
     * popping out of existence.
     *
     * There is deliberately no separate `done` boolean: two fields that must
     * agree are two fields that can disagree. `closedAt !== 0` IS done, and the
     * wire's `done` flag is derived from it at the edge.
     */
    closedAt: number;
}

export interface AnnotationState {
    /** Draw mode is on for the local user's own tiles (Phase 1 scope). */
    enabled: boolean;
    color: string;
    width: number;
    /** trackKey -> strokes, oldest first. */
    strokes: Record<string, Stroke[]>;
    /**
     * Phase 3. trackKey -> identities allowed to draw on that track. For a
     * track WE own this is the authoritative list we publish; for anyone
     * else's track it is the mirror of what its owner last published. The
     * owner is never listed - ownership is implicit everywhere.
     */
    grants: Record<string, string[]>;
    /** trackKey -> identities with a pending request. Only meaningful for
     *  tracks we own (nobody else needs to see who asked). */
    requests: Record<string, string[]>;
    /**
     * OWNER side of the decline cooldown. `${track}\n${identity}` -> ms epoch
     * at which that person may ask about that track again. Two jobs: the
     * transport diffs a newly-added key into the `grant.deny` that tells them
     * they were declined, and `addRequest` refuses to re-queue them until it
     * lapses — so a peer running a patched client cannot turn "no" into a
     * stream of prompts. The cooldown is enforced by the person it protects,
     * never only by the asker's own client.
     */
    deniedUntil: Record<string, number>;
    /** VIEWER side of the same cooldown. trackKey -> ms epoch at which we may
     *  ask again after being declined. Drives the request button's disabled
     *  countdown; `requestAccess` is a no-op until it passes. */
    cooldownUntil: Record<string, number>;
    /** Tracks WE have asked to annotate and not yet heard back on (viewer
     *  side). Store-driven so the transport can emit grant.request from a
     *  diff like everything else. */
    outgoing: string[];
    /** ms epoch when each pending request was made. Incoming keyed
     *  `${track}\n${identity}`, outgoing keyed by track. Bookkeeping for
     *  expireRequests(); never part of any diff the transport sends. */
    requestedAt: Record<string, number>;
    /**
     * VIEWER side. trackKey -> ms epoch (LOCAL clock) at which the owner
     * APPROVED OUR OWN pending request on that track. A one-shot marker for
     * the auto-arm in useAnnotationAutoArm ("you were just let in, so start
     * drawing"): set by markApproved, spent by consumeApproval, pruned by
     * dropTrack / expireRequests / reset. Bookkeeping only - never part of any
     * diff the transport sends, and never set by a snapshot, a grant list or
     * anyone else's approval, so a re-sync of an already-approved state can
     * not re-arm the tool.
     */
    approvedAt: Record<string, number>;
    /** May the local user ASK to annotate in this call? True in DM/group
     *  calls; in a server channel it mirrors the ANNOTATE permission. Set by
     *  the call surface, read by every remote tile's request affordance. */
    canRequest: boolean;
    /**
     * trackKeys the LOCAL user is publishing right now — the surfaces we can
     * hand out access to. Maintained by useAnnotationTransport from the Room's
     * own publications, because nothing else in the store knows a track exists
     * until somebody draws on it or is granted on it.
     *
     * This is what lets "Allow Annotating" appear on a right-click menu that
     * has no idea what the local user is sharing: the six places that offer
     * the item ask the store, and the "which surface?" rule lives in exactly
     * one place (grantOnOwnedSurface) rather than six.
     */
    ownedSurfaces: string[];
}

/** How long a CLOSED stroke takes to fade from full opacity to gone. */
export const LASER_TTL_MS = 1500;
/**
 * The abandonment watchdog: a LIVE stroke that has gone this long without a new
 * point is treated as released, and fades exactly as if the pen had been
 * lifted. It is what makes "the stroke stays until you let go" safe to promise.
 *
 * WHY IT EQUALS THE RELEASE TTL. The watchdog and the fade are the only two
 * clocks in the feature, and a user only ever has to learn one number: a
 * stroke you stop feeding behaves precisely like a stroke you released. The
 * worst case an abandoned stroke can occupy someone's screen is therefore
 * STROKE_IDLE_MS + LASER_TTL_MS = 3s after its last point — bounded, small,
 * and identical for local and remote strokes — versus forever before, which is
 * the bug this replaced.
 *
 * Making it SHORTER would start eating live strokes during ordinary pauses;
 * making it LONGER would buy a stuck stroke more screen time for no benefit,
 * since the only thing the extra window can do is delay a fade that is already
 * certain. Equal is the point where neither failure gets cheaper.
 *
 * The one honest cost: a pointer held ABSOLUTELY still (no OS pointer events at
 * all) for 1.5s is indistinguishable from an abandoned stroke to every observer
 * — the local renderer, the receiver, and the desktop overlay all see the same
 * silence. Such a stroke closes and fades; the next real movement simply starts
 * a fresh one at the cursor (AnnotationOverlay's onPointerMove), so the pen
 * never goes dead. Near-still hands do NOT trip it: sub-MIN_STEP moves are
 * force-appended once the stroke is half-idle, precisely so that a slow hand
 * keeps its own mark alive on every client at once rather than only locally.
 */
export const STROKE_IDLE_MS = LASER_TTL_MS;
export const MAX_STROKES_PER_TRACK = 2000;
export const MAX_POINTS_PER_STROKE = 5000;
/** Same cap the codec puts on grant.list. */
export const MAX_GRANTS = 64;
/** A request to draw (either direction) lapses after this. The viewer can
 *  then ask again; the owner's pending list drops it. Both sides expire on
 *  their own clocks, so no 'expired' message crosses the wire. */
export const REQUEST_TTL_MS = 60_000;
/**
 * How long an explicit DECLINE holds someone off. Deliberately the same 60s
 * as REQUEST_TTL_MS: being told "no" should cost about what being ignored
 * costs, because on a live share the honest meaning of both is "not right
 * now" — and one number is one thing for a user to learn. Long enough that a
 * declined viewer cannot pester a streamer mid-sentence; short enough that
 * "sorry, wrong button" is a minute of waiting, not a dead end for the call.
 */
export const DENY_COOLDOWN_MS = 60_000;
/** How long an approval stays claimable by the auto-arm. Long enough for the
 *  tile to be on a drawable surface at the moment the grant lands (or to get
 *  there a beat later); short enough that "you were approved a while ago"
 *  never starts a pen under a click that was aimed at something else. */
export const AUTO_ARM_WINDOW_MS = 10_000;
export const DEFAULT_WIDTH = 4;
export const PALETTE = ['#25E0C8', '#FFC94D', '#FF6B5E', '#5E8EE0', '#4ADE80', '#FFFFFF'] as const;

export const trackKey = (identity: string, source: string): string => `${identity}|${source}`;
/**
 * livekit-client's `Track.Source.ScreenShare` value, spelled out rather than
 * imported: this module must stay free of livekit-client (apps/website
 * type-checks this tree without it — see annotationOverlayTypes.ts).
 */
export const SCREEN_SHARE_SOURCE = 'screen_share';
/** Is this trackKey a screen share? Matches the SOURCE half only — a substring
 *  test against the whole key would also fire on a display name like
 *  "screenprinter". */
export const isScreenShareTrack = (key: string): boolean => key.endsWith('|' + SCREEN_SHARE_SOURCE);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clean = (p: Point): Point | null =>
    Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: clamp01(p.x), y: clamp01(p.y) } : null;

let state: AnnotationState = {
    enabled: false,
    color: PALETTE[0],
    width: DEFAULT_WIDTH,
    strokes: {},
    grants: {},
    requests: {},
    deniedUntil: {},
    cooldownUntil: {},
    outgoing: [],
    requestedAt: {},
    approvedAt: {},
    canRequest: true,
    ownedSurfaces: [],
};

const listeners = new Set<() => void>();
function set(next: AnnotationState) {
    state = next;
    listeners.forEach(l => l());
}
function setStrokes(key: string, list: Stroke[]) {
    set({ ...state, strokes: { ...state.strokes, [key]: list } });
}

let seq = 0;
/** Ids are only ever compared for equality, so a per-session counter plus a
 *  random suffix is enough; Phase 2 prefixes the sender identity on the wire. */
/** Clock, overridable in tests. */
export const clock = { now: () => Date.now() };
const now = () => clock.now();

export const newStrokeId = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const annotationStore = {
    getState: (): AnnotationState => state,
    subscribe(l: () => void): () => void {
        listeners.add(l);
        return () => { listeners.delete(l); };
    },

    setEnabled(enabled: boolean) { if (enabled !== state.enabled) set({ ...state, enabled }); },
    setColor(color: string)        { if (color !== state.color) set({ ...state, color }); },
    setWidth(width: number) {
        const w = Math.min(24, Math.max(1, width));
        if (w !== state.width) set({ ...state, width: w });
    },

    /** Start a stroke. Returns null (and records nothing) if the first point
     *  is malformed — a stroke that begins outside the frame is rejected by
     *  the caller before it gets here, so this is the wire-safety net. */
    beginStroke(key: string, by: string, first: Point, opts?: Partial<Pick<Stroke, 'color' | 'width' | 'id'>>): string | null {
        const p = clean(first);
        if (!p) return null;
        const t = now();
        const stroke: Stroke = {
            id: opts?.id ?? newStrokeId(),
            by,
            color: opts?.color ?? state.color,
            width: opts?.width ?? state.width,
            points: [p],
            updatedAt: t,
            closedAt: 0,
        };
        const list = [...(state.strokes[key] ?? []), stroke];
        // Oldest-first eviction keeps memory bounded on an hour-long share.
        setStrokes(key, list.length > MAX_STROKES_PER_TRACK ? list.slice(list.length - MAX_STROKES_PER_TRACK) : list);
        return stroke.id;
    },

    /**
     * Extend a live stroke. Returns false when there was nothing to extend —
     * unknown id, already closed (released, or given up on by the watchdog),
     * or full. The drawing surface uses that answer to start a FRESH stroke at
     * the current position rather than leaving the pen silently dead for the
     * rest of the gesture.
     *
     * Nothing is ever trimmed off the head: a live stroke is a whole mark. The
     * cap is what bounds it, and hitting it CLOSES the stroke (rather than
     * silently swallowing points, as this did while the head was being trimmed
     * and the cap was therefore unreachable) so the caller starts a new one and
     * the old one fades away normally.
     */
    appendPoints(key: string, id: string, points: Point[]): boolean {
        const list = state.strokes[key];
        if (!list) return false;
        const i = list.findIndex(s => s.id === id);
        if (i < 0 || list[i].closedAt !== 0) return false;
        const add = points.map(clean).filter((p): p is Point => !!p);
        if (!add.length) return true; // the stroke is alive; these points were junk
        const s = list[i];
        const t = now();
        const room = MAX_POINTS_PER_STROKE - s.points.length;
        if (room <= 0) {
            setStrokes(key, [...list.slice(0, i), { ...s, closedAt: t }, ...list.slice(i + 1)]);
            return false;
        }
        const next: Stroke = {
            ...s,
            points: [...s.points, ...add.slice(0, room)],
            updatedAt: t,
        };
        setStrokes(key, [...list.slice(0, i), next, ...list.slice(i + 1)]);
        return true;
    },

    /**
     * The pen lifted (locally, or a peer's `stroke.end` arrived). The stroke
     * closes and starts to fade FROM NOW — which is exactly the behaviour this
     * feature is supposed to have: it stays whole and solid while you hold, and
     * only begins to go once you let go.
     *
     * It cannot buy unbounded life: the watchdog closes any stroke that stops
     * growing for STROKE_IDLE_MS, so "now" is never more than that after the
     * last point.
     */
    endStroke(key: string, id: string) {
        const list = state.strokes[key];
        if (!list) return;
        const i = list.findIndex(s => s.id === id);
        if (i < 0 || list[i].closedAt !== 0) return;
        setStrokes(key, [...list.slice(0, i), { ...list[i], closedAt: now() }, ...list.slice(i + 1)]);
    },

    /**
     * Remove one stroke outright, skipping the fade.
     *
     * Reduced-motion only: someone who has asked for no motion gets no ramp,
     * so their own released stroke goes at once. Peers are unaffected — they
     * were already sent the `stroke.end` and fade it normally on their own
     * screens, because this is a local presentation preference, not a change
     * to what anyone else sees. Nothing else may delete a stroke early:
     * expiry belongs to the watchdog and the fade.
     */
    removeStroke(key: string, id: string) {
        const list = state.strokes[key];
        if (!list) return;
        const next = list.filter(s => s.id !== id);
        if (next.length !== list.length) setStrokes(key, next);
    },

    /** Drop everything on a track at once. Not a user action any more — every
     *  stroke clears itself within STROKE_IDLE_MS + LASER_TTL_MS at the latest
     *  — it exists so a snapshot can replace a track's contents wholesale. */
    clearTrack(key: string) {
        if (!state.strokes[key]?.length) return;
        setStrokes(key, []);
    },

    /**
     * Age the lasers. Returns true when the stroke DATA changed (a stroke
     * closed, or a faded one was removed) — not merely because a fading
     * stroke's opacity moved, which is the renderer's business and needs no
     * store mutation.
     *
     * Two rules, in this order:
     *
     *  1. WATCHDOG. A live stroke (`closedAt === 0`) that has had no new point
     *     for STROKE_IDLE_MS is closed as of `at`. This is the expiry
     *     guarantee: a pointerup that never arrived, a participant who left
     *     mid-stroke, a backgrounded tab, a remote stream cut off in the middle
     *     — every one of them looks the same from here (points stopped coming),
     *     and every one of them now ends in a normal fade instead of a mark
     *     nailed to someone's screen for the rest of the call.
     *
     *  2. FADE. A closed stroke is removed once LASER_TTL_MS has passed since
     *     it closed. Until then it is still drawn, at a falling opacity — see
     *     strokeAlpha, which both renderers share.
     *
     * A LIVE stroke is never touched: it keeps every point at full opacity for
     * as long as the pen is down. That is the whole point of the rewrite.
     *
     * `updatedAt`/`closedAt` are local-clock stamps, so this holds identically
     * for remote strokes (live, snapshot-applied or chunked): they age from
     * when WE last heard about them, which is the only liveness a receiver has.
     */
    expireLasers(at: number = now()): boolean {
        let changed = false;
        const strokes: Record<string, Stroke[]> = {};
        for (const [key, list] of Object.entries(state.strokes)) {
            const kept: Stroke[] = [];
            for (const s of list) {
                if (s.closedAt === 0) {
                    if (at - s.updatedAt < STROKE_IDLE_MS) { kept.push(s); continue; }
                    changed = true;
                    kept.push({ ...s, closedAt: at });
                    continue;
                }
                if (at - s.closedAt < LASER_TTL_MS) { kept.push(s); continue; }
                changed = true; // fully faded — the stroke goes
            }
            strokes[key] = kept;
        }
        if (changed) set({ ...state, strokes });
        return changed;
    },

    /** Everything for one track is gone with the track (unpublish / leave):
     *  its strokes, its grants, any pending requests, and both halves of the
     *  decline cooldown — a share that ended is not a share you are still
     *  serving out a "no" on. */
    dropTrack(key: string) {
        if (!(key in state.strokes) && !(key in state.grants) && !(key in state.requests)
            && !(key in state.cooldownUntil) && !state.outgoing.includes(key)
            && !state.ownedSurfaces.includes(key) && !(key in state.approvedAt)
            && !Object.keys(state.deniedUntil).some(k => k.startsWith(key + '\n'))) return;
        const strokes = { ...state.strokes }; delete strokes[key];
        const grants = { ...state.grants }; delete grants[key];
        const requests = { ...state.requests }; delete requests[key];
        const cooldownUntil = { ...state.cooldownUntil }; delete cooldownUntil[key];
        const deniedUntil = { ...state.deniedUntil };
        for (const k of Object.keys(deniedUntil)) if (k.startsWith(key + '\n')) delete deniedUntil[k];
        const outgoing = state.outgoing.filter(k => k !== key);
        const requestedAt = { ...state.requestedAt };
        for (const k of Object.keys(requestedAt)) if (k === key || k.startsWith(key + '\n')) delete requestedAt[k];
        const ownedSurfaces = state.ownedSurfaces.filter(k => k !== key);
        const approvedAt = { ...state.approvedAt }; delete approvedAt[key];
        set({ ...state, strokes, grants, requests, deniedUntil, cooldownUntil, outgoing, requestedAt, ownedSurfaces, approvedAt });
    },

    // -- Phase 3: grants -----------------------------------------------------

    /** A viewer asked to annotate this track (streamer side). Deduplicated;
     *  an already-granted identity is not queued, and neither is one still
     *  inside the cooldown from a decline — that check lives HERE, on the
     *  side being protected, because the asking client is the one that would
     *  have to be patched to ignore it.
     *
     * Returns true only when the request was actually QUEUED — i.e. this is a
     * new person asking for the first time. The transport turns that into the
     * notification cue, so a duplicate ask, an already-granted person and a
     * peer knocking inside their decline cooldown are all silent: the sound
     * means "someone is waiting on you", and it must never be a thing a peer
     * can make ring on demand.
     */
    addRequest(key: string, identity: string): boolean {
        if (!identity || (state.grants[key] ?? []).includes(identity)) return false;
        const until = state.deniedUntil[key + '\n' + identity];
        if (until !== undefined && now() < until) return false;
        const cur = state.requests[key] ?? [];
        if (cur.includes(identity)) return false;
        set({ ...state, requests: { ...state.requests, [key]: [...cur, identity].slice(-MAX_GRANTS) }, requestedAt: { ...state.requestedAt, [key + '\n' + identity]: now() } });
        return true;
    },
    /**
     * Streamer declines. Drops the request AND starts the cooldown, which is
     * the only thing that makes a decline different from letting the request
     * lapse: the transport turns the new `deniedUntil` entry into the
     * `grant.deny` that tells the asker (so their button says "declined,
     * ask again in a minute" instead of "asked..." for a silent minute), and
     * addRequest above refuses them until it passes.
     */
    denyRequest(key: string, identity: string) {
        if (!identity) return;
        const cur = state.requests[key];
        const requests = cur?.includes(identity) ? { ...state.requests, [key]: cur.filter(i => i !== identity) } : state.requests;
        const requestedAt = { ...state.requestedAt }; delete requestedAt[key + '\n' + identity];
        set({ ...state, requests, requestedAt, deniedUntil: { ...state.deniedUntil, [key + '\n' + identity]: now() + DENY_COOLDOWN_MS } });
    },
    /** Streamer grants (also clears the request, and any decline cooldown
     *  still standing against them — a yes outranks an earlier no). */
    grant(key: string, identity: string) {
        if (!identity) return;
        const cur = state.grants[key] ?? [];
        const grants = cur.includes(identity) ? state.grants : { ...state.grants, [key]: [...cur, identity].slice(-MAX_GRANTS) };
        const req = state.requests[key];
        const requests = req?.includes(identity) ? { ...state.requests, [key]: req.filter(i => i !== identity) } : state.requests;
        const requestedAt = { ...state.requestedAt }; delete requestedAt[key + '\n' + identity];
        const dk = key + '\n' + identity;
        const deniedUntil = dk in state.deniedUntil ? { ...state.deniedUntil } : state.deniedUntil;
        if (deniedUntil !== state.deniedUntil) delete deniedUntil[dk];
        if (grants !== state.grants || requests !== state.requests || deniedUntil !== state.deniedUntil) {
            set({ ...state, grants, requests, requestedAt, deniedUntil });
        }
    },
    revoke(key: string, identity: string) {
        const cur = state.grants[key];
        if (!cur?.includes(identity)) return;
        set({ ...state, grants: { ...state.grants, [key]: cur.filter(i => i !== identity) } });
    },
    /**
     * Revoke `identity` from EVERY track `owner` owns, in one mutation.
     *
     * This is what a right-click on a participant's name means: names are not
     * scoped to a surface (the roster, the huddle card and the tile label all
     * show the same person), so "stop them annotating" has to mean all of the
     * revoker's own surfaces - camera and screen share alike. It can never
     * touch a track someone else owns: only that owner's client may publish
     * their grant list, so a revoke there would be ignored by every receiver
     * anyway (see applyRemote's `grant.list` owner check).
     *
     * One `set` on purpose - the transport diffs snapshots, so a single
     * mutation becomes one grant.revoke + grant.list pair per track rather
     * than a burst of intermediate lists.
     *
     * Returns the tracks actually changed (empty = nothing to do).
     */
    revokeAllFrom(owner: string, identity: string): string[] {
        if (!owner || !identity) return [];
        const keys = ownedGrantTracks(state, owner, identity);
        if (!keys.length) return [];
        const grants = { ...state.grants };
        for (const k of keys) grants[k] = grants[k].filter(i => i !== identity);
        set({ ...state, grants });
        return keys;
    },
    /** Mirror the owner's published list for a track we do NOT own. Replaces
     *  wholesale: the owner's list is the truth, not a delta. */
    setGrantList(key: string, identities: string[]) {
        const next = [...new Set(identities.filter(Boolean))].slice(0, MAX_GRANTS);
        const cur = state.grants[key] ?? [];
        if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;
        set({ ...state, grants: { ...state.grants, [key]: next } });
    },

    setCanRequest(v: boolean) { if (v !== state.canRequest) set({ ...state, canRequest: v }); },

    /** Replace the list of surfaces WE publish. Order is irrelevant; the
     *  transport recomputes it wholesale from the Room on every publish and
     *  unpublish, so this is a set-and-forget mirror, not a delta. */
    setOwnedSurfaces(keys: string[]) {
        const next = [...new Set(keys.filter(Boolean))];
        const cur = state.ownedSurfaces;
        if (cur.length === next.length && next.every(k => cur.includes(k))) return;
        set({ ...state, ownedSurfaces: next });
    },

    /**
     * Give `identity` access without them having asked — the streamer-side
     * inverse of "Stop Annotating".
     *
     * WHICH surface: the screen share if we are publishing one, otherwise the
     * camera. A share is what annotation is FOR — it is the surface with
     * content worth pointing at, and the only one the desktop overlay can draw
     * over — whereas granting on the camera by default would hand someone a
     * pen over your face because you happened to have both on. If you want the
     * other surface as well, the per-tile requests menu grants per surface;
     * grants stay per-owner-per-surface either way, and there is deliberately
     * still no room-wide "anyone may draw".
     *
     * Also clears any decline cooldown standing against them (via `grant`): an
     * offer outranks an earlier no, and it would be absurd to hand someone
     * access while their own client still says "ask again in 43s".
     *
     * Returns the track granted on, or null when we own no surface to grant.
     */
    grantOnOwnedSurface(owner: string, identity: string): string | null {
        if (!owner || !identity || identity === owner) return null;
        const mine = state.ownedSurfaces.filter(k => k.startsWith(owner + '|'));
        const target = mine.find(isScreenShareTrack) ?? mine[0];
        if (!target) return null;
        if ((state.grants[target] ?? []).includes(identity)) return target;
        annotationStore.grant(target, identity);
        return target;
    },

    /** Viewer side: ask the owner of `key` for access. Idempotent, and a
     *  no-op while a decline cooldown is running (the button is disabled
     *  then, but a keyboard or a stale render must not slip past it). */
    requestAccess(key: string) {
        if (state.outgoing.includes(key)) return;
        if (cooldownLeft(state, key) > 0) return;
        set({ ...state, outgoing: [...state.outgoing, key], requestedAt: { ...state.requestedAt, [key]: now() } });
    },
    /** The owner answered (granted, denied, or the track went away). */
    clearOutgoing(key: string) {
        if (!state.outgoing.includes(key)) return;
        const requestedAt = { ...state.requestedAt }; delete requestedAt[key];
        set({ ...state, outgoing: state.outgoing.filter(k => k !== key), requestedAt });
    },
    /**
     * Viewer side: the owner just APPROVED our request on `key`. Leaves a
     * one-shot marker for the auto-arm (see AUTO_ARM_WINDOW_MS); it does not
     * arm anything itself - whether the track is on a surface where drawing
     * exists is the tile's knowledge, not the store's. Only the transport's
     * live `grant.grant` naming us, with a request of ours pending, calls this.
     */
    markApproved(key: string) {
        if (!key) return;
        set({ ...state, approvedAt: { ...state.approvedAt, [key]: now() } });
    },
    /**
     * Spend the approval marker for `key`. True only when a marker exists and
     * is still inside `windowMs`; either way a marker that is found is removed
     * (a stale one is garbage, a fresh one is being used right now), so each
     * approval can arm at most once.
     */
    consumeApproval(key: string, windowMs: number = AUTO_ARM_WINDOW_MS): boolean {
        const at = state.approvedAt[key];
        if (at === undefined) return false;
        const approvedAt = { ...state.approvedAt }; delete approvedAt[key];
        set({ ...state, approvedAt });
        return now() - at <= windowMs;
    },
    /**
     * Viewer side: the owner said no. Ends the pending request and starts the
     * cooldown, so the asker sees a countdown rather than a request that just
     * evaporated. Called from the transport when a `grant.deny` naming us
     * arrives from the track's owner.
     */
    enterCooldown(key: string, ms: number = DENY_COOLDOWN_MS) {
        const requestedAt = { ...state.requestedAt }; delete requestedAt[key];
        set({
            ...state,
            outgoing: state.outgoing.filter(k => k !== key),
            requestedAt,
            cooldownUntil: { ...state.cooldownUntil, [key]: now() + ms },
        });
    },
    /** Drop requests older than REQUEST_TTL_MS (both directions) and lapsed
     *  decline cooldowns (both sides). Returns true when something changed —
     *  which is also what re-renders a request button whose countdown has
     *  just run out. Called on a slow tick by the transport. */
    expireRequests(at: number = now(), ttl: number = REQUEST_TTL_MS): boolean {
        let changed = false;
        const requestedAt = { ...state.requestedAt };
        let requests = state.requests;
        let outgoing = state.outgoing;
        for (const [k, t] of Object.entries(state.requestedAt)) {
            if (at - t < ttl) continue;
            delete requestedAt[k]; changed = true;
            const nl = k.indexOf('\n');
            if (nl === -1) outgoing = outgoing.filter(o => o !== k);
            else {
                const track = k.slice(0, nl), id = k.slice(nl + 1);
                requests = { ...requests, [track]: (requests[track] ?? []).filter(i => i !== id) };
            }
        }
        const deniedUntil = { ...state.deniedUntil };
        for (const [k, until] of Object.entries(state.deniedUntil)) if (at >= until) { delete deniedUntil[k]; changed = true; }
        const cooldownUntil = { ...state.cooldownUntil };
        for (const [k, until] of Object.entries(state.cooldownUntil)) if (at >= until) { delete cooldownUntil[k]; changed = true; }
        const approvedAt = { ...state.approvedAt };
        for (const [k, t] of Object.entries(state.approvedAt)) if (at - t > AUTO_ARM_WINDOW_MS) { delete approvedAt[k]; changed = true; }
        if (changed) set({ ...state, requests, outgoing, requestedAt, deniedUntil, cooldownUntil, approvedAt });
        return changed;
    },

    /** Call end. */
    reset() {
        set({ enabled: false, color: PALETTE[0], width: DEFAULT_WIDTH, strokes: {}, grants: {}, requests: {}, deniedUntil: {}, cooldownUntil: {}, outgoing: [], requestedAt: {}, approvedAt: {}, canRequest: true, ownedSurfaces: [] });
    },
};

/** React binding. Pass a selector to avoid re-rendering every tile on every
 *  point appended to some other tile. */
export function useAnnotationStore<T>(selector: (s: AnnotationState) => T): T {
    return useSyncExternalStore(annotationStore.subscribe, () => selector(annotationStore.getState()), () => selector(annotationStore.getState()));
}

/**
 * Opacity of a WHOLE stroke, seen at `at`: 1 while it is live, then a linear
 * ramp to 0 across LASER_TTL_MS once it has closed.
 *
 * One number per stroke, not per point, and every renderer applies it as a
 * single `globalAlpha` around a single path. That is what makes the trail read
 * as one continuous laser line: the previous per-point version had to stroke
 * each segment separately (each with its own alpha), and adjacent round line
 * caps compositing against one another at different opacities is precisely
 * what produced the "dots on the trail" this replaced.
 *
 * The visible half of the rule expireLasers enforces in the data, so a stroke
 * reaches zero opacity exactly as it is removed.
 */
export const strokeAlpha = (s: Pick<Stroke, 'closedAt'>, at: number): number =>
    s.closedAt === 0 ? 1 : Math.max(0, Math.min(1, 1 - (at - s.closedAt) / LASER_TTL_MS));

/** Is the pen still down on this stroke (or, for a remote one, still feeding
 *  it)? The wire's `done` flag is this, inverted, at the edge. */
export const isLive = (s: Pick<Stroke, 'closedAt'>): boolean => s.closedAt === 0;

export const EMPTY_STROKES: readonly Stroke[] = Object.freeze([]);
export const selectTrackStrokes = (key: string) => (s: AnnotationState): readonly Stroke[] => s.strokes[key] ?? EMPTY_STROKES;
const EMPTY_IDS: readonly string[] = Object.freeze([]);
/**
 * ms left on the decline cooldown for `key`, 0 when we may ask again.
 *
 * Deliberately NOT a store selector: it moves with the clock, and a
 * useSyncExternalStore snapshot has to be stable between renders. Components
 * select the fixed deadline (`selectCooldownUntil`) and do their own
 * per-second countdown; this is the store's own guard in `requestAccess`, so
 * the button and the store agree on when asking is possible.
 */
export function cooldownLeft(s: AnnotationState, key: string): number {
    const until = s.cooldownUntil[key];
    return until === undefined ? 0 : Math.max(0, until - now());
}
/** ms-epoch deadline of the decline cooldown on `key`; 0 when there is none. */
export const selectCooldownUntil = (key: string) => (s: AnnotationState): number => s.cooldownUntil[key] ?? 0;
export const selectTrackGrants = (key: string) => (s: AnnotationState): readonly string[] => s.grants[key] ?? EMPTY_IDS;
export const selectTrackRequests = (key: string) => (s: AnnotationState): readonly string[] => s.requests[key] ?? EMPTY_IDS;
/** May `identity` draw on `key`? The owner always may; otherwise only if granted. */
export const isGranted = (s: AnnotationState, key: string, identity: string): boolean =>
    key.startsWith(identity + '|') || (s.grants[key] ?? EMPTY_IDS).includes(identity);

/** Tracks owned by `owner` that `identity` is currently granted on. Ownership
 *  is read off the key exactly as `isGranted` reads it, so the two can never
 *  disagree about who owns what. */
export const ownedGrantTracks = (s: AnnotationState, owner: string, identity: string): string[] =>
    owner && identity
        ? Object.keys(s.grants).filter(k => k.startsWith(owner + '|') && (s.grants[k] ?? EMPTY_IDS).includes(identity))
        : [];

/**
 * Does `identity` hold an annotation grant on ANY surface in this call? Drives
 * the pencil badge beside their name.
 *
 * Explicit grants only - a streamer's implicit right to their own tile is not
 * a badge, or every sharer would wear one and the mark would mean nothing.
 * Grant lists are mirrored from each owner to everyone, so every client shows
 * the same badge for the same person.
 */
export const selectCanAnnotate = (identity: string) => (s: AnnotationState): boolean =>
    !!identity && Object.values(s.grants).some(list => list.includes(identity));

/** True when the local user can take an annotation grant away from `identity`
 *  - i.e. they hold one on a surface WE own. Gates the right-click item. */
export const selectCanRevoke = (owner: string, identity: string) => (s: AnnotationState): boolean =>
    ownedGrantTracks(s, owner, identity).length > 0;

/**
 * True when the local user can OFFER `identity` annotation access unprompted -
 * we are publishing at least one surface and they hold no grant on any of
 * them. The exact complement of selectCanRevoke over the surfaces we own, so a
 * menu shows precisely one of "Allow Annotating" / "Stop Annotating" and never
 * both, never neither-when-it-should-be-one.
 *
 * Note the asymmetry is deliberate: revoking is offered whenever they hold a
 * grant on anything of ours (including a surface we have since stopped
 * publishing but whose grant is still standing), while granting needs a LIVE
 * surface, because there is nothing to draw on otherwise.
 */
export const selectCanGrantAnnotation = (owner: string, identity: string) => (s: AnnotationState): boolean => {
    if (!owner || !identity || identity === owner) return false;
    if (ownedGrantTracks(s, owner, identity).length > 0) return false;
    return s.ownedSurfaces.some(k => k.startsWith(owner + '|'));
};

/** Which surface `grantOnOwnedSurface` would pick, for menu copy ("Allow
 *  Annotating on your screen" vs "...your video"). Null when there is none. */
export const selectGrantTarget = (owner: string) => (s: AnnotationState): string | null => {
    if (!owner) return null;
    const mine = s.ownedSurfaces.filter(k => k.startsWith(owner + '|'));
    return mine.find(isScreenShareTrack) ?? mine[0] ?? null;
};
