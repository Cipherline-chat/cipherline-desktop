/**
 * Coalesces a burst of full-snapshot writes into one.
 *
 * Message history is persisted as a single JSON snapshot per account. The
 * persist effects were keyed on the message state, so EVERY arriving message
 * re-ran `JSON.stringify(entire history)` synchronously on the main thread —
 * O(total history) per message, i.e. quadratic over a burst. Boot is the worst
 * case: draining the queued backlog re-serialized the whole history once per
 * queued message before the UI could settle.
 *
 * Since each write is a complete snapshot, every intermediate one is dead —
 * only the last value in a window has to reach disk. This defers both the
 * serialize AND the store write until the burst stops.
 *
 * The value is held UNSERIALIZED until flush time; that's the entire point.
 * Serializing eagerly to make flush-on-quit cheap would reintroduce the cost
 * this class exists to remove.
 *
 * DURABILITY: the local cache is the only copy of a delivered message (the
 * server deletes envelopes once ACKed), so a pending write must never be lost
 * to a quit. Callers are responsible for calling flush() on unmount and on the
 * page-teardown events — see useCoalescedPersist, which wires that up.
 */
export class CoalescedWriter<T> {
    private pending: { key: string; value: T } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    // Declared explicitly rather than as constructor parameter properties —
    // this project builds with `erasableSyntaxOnly`, which bans that shorthand.
    private readonly write: (key: string, value: T) => void;
    private readonly delayMs: number;

    constructor(write: (key: string, value: T) => void, delayMs: number) {
        this.write = write;
        this.delayMs = delayMs;
    }

    /** Queue `value` for `key`, replacing anything already queued. */
    schedule(key: string, value: T): void {
        this.pending = { key, value };
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.delayMs);
    }

    /** Write the queued value now, if any. Safe to call when nothing is queued. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const p = this.pending;
        this.pending = null;
        if (p) this.write(p.key, p.value);
    }

    /** Drop the queued value without writing it. Used when the owner is going
     *  away and the data is intentionally being discarded (e.g. a full clear). */
    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending = null;
    }

    get hasPending(): boolean {
        return this.pending !== null;
    }
}
