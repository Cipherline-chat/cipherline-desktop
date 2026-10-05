/**
 * annotationTransport - the pure half of the network layer: what to SEND
 * when local state changes, and what to DO with a message that arrived.
 *
 * Deliberately free of LiveKit and React so it is testable in node. The thin
 * hook that binds it to a Room (useAnnotationTransport) owns the sockets;
 * this file owns the decisions.
 *
 * Authorization model: a stroke message for track `X|source` is accepted
 * when the SFU-attested sender is `X` (the owner) or is on the owner's
 * published grant list as mirrored in our store. Grant messages are believed
 * only from the owner; requests are queued only by the owner. If the owner's
 * list was never received, nobody but the owner is allowed.
 */
import { annotationStore, isGranted, type AnnotationState, type Stroke } from './annotationStore';
import { type AnnotMsg, type WireStroke, MAX_APPEND_POINTS, WIRE_TOOL } from './annotationCodec';

/** Store ids for remote strokes are namespaced by sender so two peers using
 *  the same local id can never collide, and so a peer cannot reach into
 *  another's stroke by guessing its id. */
export const remoteId = (sender: string, wireId: string): string => `${sender}/${wireId}`;
export const ownerOf = (track: string): string => track.slice(0, track.indexOf('|'));

/** Phase 3: the track's owner, or anyone on the owner's published grant
 *  list as mirrored in our store. If we never received the owner's list,
 *  nobody but the owner is allowed - grants only ever reduce on silence. */
export function isAllowed(track: string, sender: string): boolean {
    return isGranted(annotationStore.getState(), track, sender);
}

// -- Outbound: diff local store changes into wire messages -----------------

/**
 * Per-stroke progress the sender has already put on the wire: how many of the
 * stroke's points have been sent, and whether its `stroke.end` has.
 *
 * A live stroke's `points` array only ever grows now (nothing is trimmed off
 * the head any more), so this is a plain index into it — the absolute-count
 * bookkeeping the comet model needed is gone with the comet.
 */
export interface SentCursor { points: number; ended: boolean }
export type SentState = Map<string, SentCursor>; // key: `${track} ${id}`

const ck = (track: string, id: string) => `${track} ${id}`;

/**
 * Compare the previous and next store snapshots and produce the messages
 * that carry the LOCAL user's changes. Idempotent given `sent`: calling it
 * twice with the same `next` sends nothing the second time.
 */
export function diffLocalForWire(
    prev: AnnotationState, next: AnnotationState, me: string, room: string, sent: SentState,
): AnnotMsg[] {
    const out: AnnotMsg[] = [];

    // Grant lists for tracks WE own: publish whenever they change.
    const grantTracks = new Set([...Object.keys(prev.grants), ...Object.keys(next.grants)]);
    for (const track of grantTracks) {
        if (ownerOf(track) !== me) continue;
        const a = prev.grants[track] ?? [], b = next.grants[track] ?? [];
        if (a.length === b.length && a.every((v, i) => v === b[i])) continue;
        for (const id of b) if (!a.includes(id)) out.push({ t: 'grant.grant', room, track, identity: id });
        for (const id of a) if (!b.includes(id)) out.push({ t: 'grant.revoke', room, track, identity: id });
        out.push({ t: 'grant.list', room, track, identities: [...b] });
    }
    // Declines on tracks WE own. One message per newly-recorded decline: the
    // store holds the cooldown deadline, so a key that was not there before
    // is exactly one press of Decline. The asker's client turns it into their
    // countdown; every other client ignores it (it is not about them), the
    // same way grant.grant and grant.revoke already travel.
    for (const k of Object.keys(next.deniedUntil)) {
        if (k in prev.deniedUntil) continue;
        const nl = k.indexOf('\n');
        if (nl <= 0) continue;
        const track = k.slice(0, nl), identity = k.slice(nl + 1);
        if (!identity || ownerOf(track) !== me) continue;
        out.push({ t: 'grant.deny', room, track, identity });
    }
    // Our own requests to annotate someone else's track.
    for (const track of next.outgoing) {
        if (!prev.outgoing.includes(track) && ownerOf(track) !== me) out.push({ t: 'grant.request', room, track });
    }

    const tracks = new Set([...Object.keys(prev.strokes), ...Object.keys(next.strokes)]);
    for (const track of tracks) {
        const before = prev.strokes[track] ?? [];
        const after = next.strokes[track] ?? [];
        const afterIds = new Map(after.map(s => [s.id, s]));

        // A local stroke that is gone now simply finished fading, or left with
        // its track. Nothing goes on the wire for it: every peer runs the same
        // fade against the `stroke.end` we already sent, or — if we never got
        // to send one — against its own watchdog. Only the send cursor is
        // retired, or `sent` would grow for the length of the call.
        const mineBefore = before.filter(s => s.by === me);
        const mineAfter = after.filter(s => s.by === me);
        for (const s of mineBefore) if (!afterIds.has(s.id)) sent.delete(ck(track, s.id));

        for (const s of mineAfter) {
            if (!s.points.length) continue;
            const key = ck(track, s.id);
            let cur = sent.get(key);
            if (!cur) {
                out.push({ t: 'stroke.begin', room, track, id: s.id, tool: WIRE_TOOL, color: s.color, width: s.width, p: s.points[0] });
                cur = { points: 1, ended: false };
                sent.set(key, cur);
            }
            while (cur.points < s.points.length) {
                const pts = s.points.slice(cur.points, cur.points + MAX_APPEND_POINTS);
                out.push({ t: 'stroke.append', room, track, id: s.id, pts });
                cur.points += pts.length;
            }
            // A stroke the WATCHDOG closed sends `stroke.end` just like a
            // released one. That is not a lie about the pen: it is us telling
            // peers we have given up on it, so they stop waiting and fade in
            // step with us rather than each running their own watchdog to a
            // slightly different deadline.
            if (s.closedAt !== 0 && !cur.ended) {
                out.push({ t: 'stroke.end', room, track, id: s.id });
                cur.ended = true;
            }
        }
    }
    return out;
}

// -- Inbound: apply a validated message from an attested sender ------------

export interface ApplyResult {
    applied: boolean;
    reason?: string;
    /**
     * `grant.request` only: a NEW person is now waiting on us. The hook turns
     * this into the notification sound, so it is true exactly once per asker —
     * never for a repeat of an ask already on the list, someone already
     * granted, or a peer knocking inside their decline cooldown. A sound a
     * peer can retrigger at will is a sound a peer can use as a weapon.
     */
    queuedRequest?: boolean;
}

/**
 * Apply one decoded message. `sender` is the SFU-attested identity from the
 * data packet, never anything inside the payload. Snapshot parts are handed
 * to the assembler instead (they arrive out of band of the live stream).
 */
export function applyRemote(msg: AnnotMsg, sender: string, me: string): ApplyResult {
    if (sender === me) return { applied: false, reason: 'own echo' };
    switch (msg.t) {
        case 'stroke.begin': {
            if (!isAllowed(msg.track, sender)) return { applied: false, reason: 'not allowed' };
            const id = annotationStore.beginStroke(msg.track, sender, msg.p, {
                id: remoteId(sender, msg.id), color: msg.color, width: msg.width,
            });
            return { applied: id !== null };
        }
        case 'stroke.append':
            if (!isAllowed(msg.track, sender)) return { applied: false, reason: 'not allowed' };
            annotationStore.appendPoints(msg.track, remoteId(sender, msg.id), msg.pts);
            return { applied: true };
        case 'stroke.end':
            if (!isAllowed(msg.track, sender)) return { applied: false, reason: 'not allowed' };
            annotationStore.endStroke(msg.track, remoteId(sender, msg.id));
            return { applied: true };

        // -- grants: the owner speaks, everyone else listens ------------------
        case 'grant.request':
            // Only the owner cares, and only about tracks it owns.
            if (ownerOf(msg.track) !== me) return { applied: false, reason: 'not my track' };
            return { applied: true, queuedRequest: annotationStore.addRequest(msg.track, sender) };
        case 'grant.list':
            if (ownerOf(msg.track) !== sender) return { applied: false, reason: 'not owner' };
            annotationStore.setGrantList(msg.track, msg.identities);
            if (msg.identities.includes(me) || !annotationStore.getState().outgoing.includes(msg.track)) {
                annotationStore.clearOutgoing(msg.track);
            }
            return { applied: true };
        case 'grant.grant':
            if (ownerOf(msg.track) !== sender) return { applied: false, reason: 'not owner' };
            if (msg.identity === me) annotationStore.clearOutgoing(msg.track);
            return { applied: true }; // the list message that follows carries the state
        case 'grant.deny':
            if (ownerOf(msg.track) !== sender) return { applied: false, reason: 'not owner' };
            // A no ends the request AND starts our cooldown, so the button
            // says "declined - ask again in a minute" instead of quietly
            // letting us knock straight away. The owner enforces the same
            // window on their side (annotationStore.addRequest).
            if (msg.identity === me) annotationStore.enterCooldown(msg.track);
            return { applied: true };
        case 'grant.revoke':
            if (ownerOf(msg.track) !== sender) return { applied: false, reason: 'not owner' };
            return { applied: true }; // list follows
        default:
            return { applied: false, reason: 'not a live message' };
    }
}

// -- Snapshots ---------------------------------------------------------------

/** The streamer's current grant list for a track it owns. */
export function grantsOf(track: string): string[] {
    return [...(annotationStore.getState().grants[track] ?? [])];
}

/** Build the wire form of a track's current strokes (streamer side). */
export function snapshotOf(track: string): WireStroke[] {
    return (annotationStore.getState().strokes[track] ?? []).map((s: Stroke) => ({
        // `done` is derived at the edge: the store keeps one field (`closedAt`)
        // so there is nothing for a stale boolean to disagree with.
        id: s.id, by: s.by, tool: WIRE_TOOL, color: s.color, width: s.width, points: s.points, done: s.closedAt !== 0,
    }));
}

type SnapshotMsg = Extract<AnnotMsg, { t: 'snapshot' }>;

/** Collects chunked snapshot parts per (sender, track, seq); yields the
 *  complete set once, then forgets it. Stale seqs are dropped on the floor. */
export class SnapshotAssembler {
    private parts = new Map<string, { of: number; got: Map<number, SnapshotMsg> }>();
    private latestSeq = new Map<string, number>();

    push(msg: SnapshotMsg, sender: string): { strokes: WireStroke[]; identities: string[] } | null {
        const tkey = `${sender} ${msg.track}`;
        const latest = this.latestSeq.get(tkey);
        if (latest !== undefined && msg.seq < latest) return null;
        if (latest === undefined || msg.seq > latest) {
            this.latestSeq.set(tkey, msg.seq);
            for (const k of [...this.parts.keys()]) if (k.startsWith(tkey + ' ')) this.parts.delete(k);
        }
        const key = `${tkey} ${msg.seq}`;
        let entry = this.parts.get(key);
        if (!entry) { entry = { of: msg.of, got: new Map() }; this.parts.set(key, entry); }
        if (entry.of !== msg.of) return null; // inconsistent set - ignore it
        entry.got.set(msg.part, msg);
        if (entry.got.size < entry.of) return null;
        this.parts.delete(key);
        const ordered = [...entry.got.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
        return {
            strokes: ordered.flatMap(p => p.strokes),
            identities: ordered[0].identities ?? [],
        };
    }
}

/**
 * Replace a track's contents with a streamer's snapshot. Trusted only because
 * `sender` is the track's owner - anyone else's snapshot is refused.
 */
export function applySnapshot(track: string, sender: string, strokes: WireStroke[], identities: string[] = []): boolean {
    if (ownerOf(track) !== sender) return false;
    annotationStore.setGrantList(track, identities);
    annotationStore.clearTrack(track);
    for (const s of strokes) {
        // Keep the author as relayed, but namespace ids by author so later
        // live messages for the same stroke line up.
        const id = remoteId(s.by, s.id);
        annotationStore.beginStroke(track, s.by, s.points[0], { id, color: s.color, width: s.width });
        if (s.points.length > 1) annotationStore.appendPoints(track, id, s.points.slice(1));
        if (s.done) annotationStore.endStroke(track, id);
    }
    return true;
}
