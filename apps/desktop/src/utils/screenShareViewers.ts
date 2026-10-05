/**
 * screenShareViewers — who is actually WATCHING a screenshare, and when to
 * cue the person sharing it.
 *
 * ── Why this is client-only
 *
 * "Viewer" here means "clicked Watch on this share", which is the moment the
 * client calls `RemoteTrackPublication.setSubscribed(true)` (ScreenShareGate's
 * `handleWatch`). Nothing about that needs the API: every client in the call
 * is already in the same LiveKit room, already receives every other
 * participant's `metadata`, and already re-renders on
 * `ParticipantMetadataChanged` (SidebarConference watches it for deafen /
 * avatar / server-moderation flags today). So a viewer simply publishes the
 * set of publisher identities it is watching into its OWN metadata, and every
 * other client derives the count by reading the roster.
 *
 * That keeps the server a blind relay, which is the repo's first architecture
 * rule: a `POST /calls/:id/viewers` endpoint would have handed the API a
 * live who-is-watching-whom graph — precisely the "who talks to whom, when,
 * and how often" metadata CLAUDE.md says not to collect — in exchange for
 * nothing the room already lacks. It also costs no new WS event, no new
 * throttle bucket, and no version floor.
 *
 * The state is derived, never accumulated: the count for a publisher is a
 * fold over the CURRENT roster, so a participant who drops off the call (or
 * whose metadata never arrived) simply is not in the fold. There is no
 * counter to leak, no join/leave event to miss, and a late joiner computes
 * exactly the same number as everyone else on its first render.
 *
 * ── Trust
 *
 * A viewer's metadata is self-reported. A modified client could claim to
 * watch a share it never subscribed to, or hide that it is watching. That is
 * acceptable BY CONSTRUCTION here and must stay that way: this number is a
 * social nicety, never an access control or a privacy guarantee. Anyone in
 * the call can subscribe to a published share — the count reports intent, not
 * permission. Do not grow a gate on top of it.
 */

/**
 * The metadata key holding the identities whose screenshare this participant
 * is watching. Namespaced away from the flat `deafened` / `server_*` keys that
 * `participantMetadata.ts` owns, so the two writers can never collide on a
 * name.
 */
export const WATCHING_META_KEY = 'watching_shares';

/** Roster entry shape — the two fields of a LiveKit Participant this module
 *  reads. Deliberately structural rather than importing `Participant`, so the
 *  tests can hand it plain objects. */
export interface ViewerRosterEntry {
    identity: string;
    metadata?: string | null;
}

/**
 * Read the watched-publisher list out of one participant's raw metadata blob.
 *
 * Total and defensive: metadata is a free-form JSON string written by other
 * clients (and, for the `server_*` keys, by the API), so every shape that is
 * not "array of non-empty strings" degrades to "watching nothing" rather than
 * throwing inside a render.
 */
export function parseWatchedShares(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const obj = JSON.parse(raw);
        if (typeof obj !== 'object' || obj === null) return [];
        const list = (obj as Record<string, unknown>)[WATCHING_META_KEY];
        if (!Array.isArray(list)) return [];
        const out: string[] = [];
        for (const v of list) {
            if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Produce the metadata blob to publish for a new watched set, or `null` when
 * the blob would be unchanged.
 *
 * Returning `null` for "no change" is what keeps the publish effect from
 * looping: it writes, LiveKit echoes the new metadata back as a
 * ParticipantMetadataChanged, the effect re-runs, and this function reports
 * nothing left to do.
 *
 * Read-modify-write over the WHOLE blob (not a patch) because
 * `Participant.setMetadata` replaces it wholesale and three writers share it
 * (this one, the avatar sync, and the deafen toggle). An empty set DELETES the
 * key rather than writing `[]`, so a participant who has never watched
 * anything publishes no extra bytes at all.
 */
export function writeWatchedShares(
    raw: string | null | undefined,
    watching: readonly string[],
): string | null {
    let obj: Record<string, unknown> = {};
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) obj = parsed as Record<string, unknown>;
        } catch {
            // Unparseable blob — treat it as absent. Overwriting garbage with a
            // well-formed blob is strictly better than refusing to publish.
            obj = {};
        }
    }

    const next = [...new Set(watching.filter(v => typeof v === 'string' && v !== ''))].sort();
    const current = parseWatchedShares(raw).slice().sort();
    const same = next.length === current.length && next.every((v, i) => v === current[i]);
    if (same) return null;

    if (next.length === 0) delete obj[WATCHING_META_KEY];
    else obj[WATCHING_META_KEY] = next;

    return JSON.stringify(obj);
}

/**
 * Identities currently watching `publisher`, sorted.
 *
 * `publisher` is excluded from its own count — you do not watch your own
 * share, and a client that somehow claimed to must not inflate the number.
 */
export function viewersOf(
    roster: readonly ViewerRosterEntry[],
    publisher: string,
): string[] {
    if (!publisher) return [];
    const out: string[] = [];
    for (const entry of roster) {
        if (!entry || !entry.identity || entry.identity === publisher) continue;
        if (out.includes(entry.identity)) continue; // defensive: duplicate roster rows
        if (parseWatchedShares(entry.metadata).includes(publisher)) out.push(entry.identity);
    }
    return out.sort();
}

/**
 * Publisher identity → viewer identities, for every publisher anyone claims to
 * be watching. Used where several counts are needed from one pass rather than
 * one `viewersOf` per tile.
 */
export function buildViewerIndex(
    roster: readonly ViewerRosterEntry[],
): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const entry of roster) {
        if (!entry || !entry.identity) continue;
        for (const publisher of parseWatchedShares(entry.metadata)) {
            if (publisher === entry.identity) continue; // never count yourself
            const list = index.get(publisher);
            if (list) { if (!list.includes(entry.identity)) list.push(entry.identity); }
            else index.set(publisher, [entry.identity]);
        }
    }
    for (const list of index.values()) list.sort();
    return index;
}

// ── Cue tracking for the streamer ───────────────────────────────────────────

export type ViewerCue = 'start' | 'stop';

/**
 * How long after an epoch begins the tracker stays silent.
 *
 * Covers the two "cue storm" cases the feature has to survive, both of which
 * are a 0 → N transition that is NOT N separate decisions by N people:
 *
 *  - You start sharing into a call where everyone is already waiting for it,
 *    and three people click Watch within a second of the track appearing.
 *  - You reconnect. LiveKit rebuilds the roster, every watcher's metadata
 *    arrives fresh, and from this tracker's point of view they all "just"
 *    started watching a share that has in fact been running for ten minutes.
 *
 * In both, the honest reading is "this is the starting state", not "N events
 * happened". So the first `graceMs` of every epoch is absorbed into the
 * baseline silently. Genuine watchers who arrive later are past the window and
 * cue normally.
 */
export const VIEWER_CUE_GRACE_MS = 2500;

/**
 * Minimum gap between two cues of the SAME kind.
 *
 * Each watcher's metadata lands as its own ParticipantMetadataChanged, so two
 * people clicking Watch a few hundred ms apart reduce as two separate diffs.
 * Two overlapping plays of one cue is a stutter, not information — and
 * `playSound` reuses one HTMLAudioElement per category, so the second play
 * restarts the first mid-sample and it literally sounds broken. Collapsing
 * them to one "somebody started watching" is both the nicer cue and the
 * truthful one.
 *
 * Kept per-kind, not global: a start and a stop in the same tick are two
 * different facts and both deserve to be heard.
 */
export const VIEWER_CUE_COALESCE_MS = 700;

export interface ViewerCueState {
    /**
     * Identifies the current "run" of the local share. `''` means the tracker
     * is dormant (not sharing). ANY change re-arms the grace window — that is
     * how reconnects and stop/start cycles avoid cueing their own rebuild.
     */
    epoch: string;
    /** Sorted viewer identities as of the last reduction. */
    viewers: readonly string[];
    /** When the current epoch was armed (ms, from the caller's clock). */
    armedAt: number;
    lastStartAt: number;
    lastStopAt: number;
}

export function initialViewerCueState(): ViewerCueState {
    return { epoch: '', viewers: [], armedAt: 0, lastStartAt: 0, lastStopAt: 0 };
}

export interface ViewerCueInput {
    /** `''` when not sharing. See `ViewerCueState.epoch`. */
    epoch: string;
    /** Who is watching the local share right now (from `viewersOf`). */
    viewers: readonly string[];
    /** Caller's clock, injected so this stays pure and testable. */
    now: number;
}

export interface ViewerCueOptions {
    graceMs?: number;
    coalesceMs?: number;
}

/**
 * Fold one observation of "who is watching my share" into the cue tracker.
 *
 * Pure: same inputs, same outputs, no clock and no audio. The caller plays
 * whatever comes back in `cues` and stores `state`. All four failure modes in
 * the feature brief are decided here rather than in the 4.4k-line conference
 * component, which is the whole reason this function exists.
 */
export function reduceViewerCues(
    prev: ViewerCueState,
    input: ViewerCueInput,
    opts: ViewerCueOptions = {},
): { state: ViewerCueState; cues: ViewerCue[] } {
    const graceMs = opts.graceMs ?? VIEWER_CUE_GRACE_MS;
    const coalesceMs = opts.coalesceMs ?? VIEWER_CUE_COALESCE_MS;

    // Not sharing. Drop everything — including the coalesce timestamps, so the
    // next share starts from a clean slate rather than inheriting a cooldown
    // from the previous one.
    if (!input.epoch) {
        return prev.epoch === '' && prev.viewers.length === 0
            ? { state: prev, cues: [] }
            : { state: initialViewerCueState(), cues: [] };
    }

    const viewers = [...new Set(input.viewers)].sort();

    // New epoch (share started, restarted, or the connection came back):
    // adopt whatever is on screen as the baseline, silently.
    if (prev.epoch !== input.epoch) {
        return {
            state: { epoch: input.epoch, viewers, armedAt: input.now, lastStartAt: 0, lastStopAt: 0 },
            cues: [],
        };
    }

    const added = viewers.filter(v => !prev.viewers.includes(v));
    const removed = prev.viewers.filter(v => !viewers.includes(v));
    if (added.length === 0 && removed.length === 0) {
        return { state: prev, cues: [] };
    }

    // Still inside the grace window — absorb into the baseline without cueing.
    if (input.now - prev.armedAt < graceMs) {
        return { state: { ...prev, viewers }, cues: [] };
    }

    const cues: ViewerCue[] = [];
    let lastStartAt = prev.lastStartAt;
    let lastStopAt = prev.lastStopAt;

    // One cue per KIND per tick, however many identities moved: "two people
    // started watching" is still one thing that happened to you.
    if (added.length > 0 && input.now - prev.lastStartAt >= coalesceMs) {
        cues.push('start');
        lastStartAt = input.now;
    }
    if (removed.length > 0 && input.now - prev.lastStopAt >= coalesceMs) {
        cues.push('stop');
        lastStopAt = input.now;
    }

    return { state: { ...prev, viewers, lastStartAt, lastStopAt }, cues };
}
