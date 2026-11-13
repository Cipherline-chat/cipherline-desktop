/**
 * The in-memory recorder behind the Friends activity panel's "Recent"
 * timeline (rules: utils/friendActivity.ts). Module-level so the timeline
 * keeps filling while the Friends page is closed and survives navigating
 * away and back; never persisted, cleared on account change and sign-out.
 */
import {
    addEntry, diffListening, diffPresence, pruneEntries, SETTLE_MS,
    type FriendActivityEntry, type ListeningObservation, type PresenceSnapshot,
} from './friendActivity';

export class FriendActivityRecorder {
    private entries: FriendActivityEntry[] = [];
    private subs = new Set<() => void>();
    private settleUntil = 0;
    private prevPresence: PresenceSnapshot | null = null;
    private prevListening: ReadonlyMap<string, ListeningObservation> | null = null;
    private friendIds: ReadonlySet<string> = new Set();
    /** False until the first successfully LOADED friends list: that list is a baseline, not news. */
    private friendsBaselined = false;

    private emit() { for (const s of this.subs) s(); }

    /** The current timeline (immutable; a new array on every change). */
    getSnapshot = (): readonly FriendActivityEntry[] => this.entries;

    subscribe = (cb: () => void): (() => void) => {
        this.subs.add(cb);
        return () => { this.subs.delete(cb); };
    };

    /** A (re)connect: the next SETTLE_MS of presence / listening changes are a baseline. */
    beginSettle(now: number, ms = SETTLE_MS): void {
        this.settleUntil = Math.max(this.settleUntil, now + ms);
    }

    private settling(now: number): boolean { return now < this.settleUntil; }

    /**
     * Who counts as a friend right now. Anyone who stopped being one (removed,
     * blocked) is purged from the timeline and from the baselines, so a
     * re-added friend starts from a fresh baseline instead of a stale diff.
     *
     * `loaded` = the list came from a successful fetch (not the empty initial
     * state). After the first loaded list, anyone who newly appears in it is
     * a new friend ("You and Ana are now friends").
     */
    setFriends(ids: ReadonlySet<string>, blocked: ReadonlySet<string>, now: number, loaded = true): void {
        const allowed = new Set([...ids].filter(id => !blocked.has(id)));
        const before = this.friendIds;
        this.friendIds = allowed;
        if (loaded) {
            if (this.friendsBaselined) {
                const added = [...allowed].filter(id => !before.has(id));
                this.addAll(added.map(userId => ({ userId, kind: 'new_friend' as const, at: now })), now);
            }
            this.friendsBaselined = true;
        }
        const keep = this.entries.filter(e => allowed.has(e.userId));
        if (keep.length !== this.entries.length) {
            this.entries = pruneEntries(keep, now);
            this.emit();
        }
        if (this.prevPresence) {
            const p: PresenceSnapshot = {};
            for (const [id, o] of Object.entries(this.prevPresence)) if (allowed.has(id)) p[id] = o;
            this.prevPresence = p;
        }
        if (this.prevListening) {
            this.prevListening = new Map([...this.prevListening].filter(([id]) => allowed.has(id)));
        }
    }

    /** A fresh presence picture for friends (already resolved: offline friends carry nothing). */
    observePresence(next: PresenceSnapshot, now: number): void {
        const scoped: PresenceSnapshot = {};
        for (const [id, o] of Object.entries(next)) if (this.friendIds.has(id)) scoped[id] = o;
        const prev = this.prevPresence;
        this.prevPresence = scoped;
        if (!prev || this.settling(now)) return;
        this.addAll(diffPresence(prev, scoped, now), now);
    }

    /** What present friends are listening to / watching now. */
    observeListening(next: ReadonlyMap<string, ListeningObservation>, now: number): void {
        const scoped = new Map([...next].filter(([id]) => this.friendIds.has(id)));
        const prev = this.prevListening;
        this.prevListening = scoped;
        if (!prev || this.settling(now)) return;
        this.addAll(diffListening(prev, scoped, now), now);
    }

    /** A pushed event (avatar, rename, high five, new friend): recorded for friends only. */
    record(entry: Omit<FriendActivityEntry, 'id'>, now: number): void {
        if (!this.friendIds.has(entry.userId)) return;
        this.addAll([entry], now);
    }

    private addAll(list: Omit<FriendActivityEntry, 'id'>[], now: number): void {
        if (list.length === 0) return;
        let next = this.entries;
        for (const e of list) next = addEntry(next, e, now);
        this.entries = next;
        this.emit();
    }

    /** Sign-out / account switch: forget everything. */
    clear(): void {
        this.entries = [];
        this.prevPresence = null;
        this.prevListening = null;
        this.friendIds = new Set();
        this.friendsBaselined = false;
        this.settleUntil = 0;
        this.emit();
    }
}

/** The one recorder the app uses (hooks/useFriendActivity.ts). */
export const friendActivityRecorder = new FriendActivityRecorder();
