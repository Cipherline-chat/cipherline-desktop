/**
 * Where the diagnostic report gets the call engine's decision log from.
 *
 * The producer is `src/utils/callEventLog.ts` (`getCallEvents()`), wired in
 * as DEFAULT_SOURCE below. `readCallEvents()` still guards against a throwing
 * or malformed producer, and bundle.ts re-validates, caps and scrubs
 * everything it returns. Tests swap it with `setCallEventsSource`.
 *
 * CONTRACT with the producer: `t` is milliseconds since the epoch
 * (`Date.now()`), NOT `performance.now()` — the builder turns it into seconds
 * relative to the report's `generated_at`, like the perf log. `kind` is a
 * snake_case event name; `detail` holds short scalars only; track references
 * are placeholders (`self-camera`, `remote-video-1`). None of that is trusted
 * here: the builder drops anything that does not conform.
 */
import { getCallEvents, getPinnedCallEvents } from '../callEventLog';

export interface CallEventInput {
    /** ms since epoch. */
    t: number;
    kind: string;
    detail?: Record<string, string | number | boolean>;
}

export type CallEventsGetter = () => ReadonlyArray<CallEventInput>;

const DEFAULT_SOURCE: CallEventsGetter = getCallEvents;

let source: CallEventsGetter = DEFAULT_SOURCE;

/** Point the reporter at a different producer (tests; the integration step may use this instead of editing the default). */
export function setCallEventsSource(fn: CallEventsGetter | null): void {
    source = fn ?? DEFAULT_SOURCE;
}

/** Whatever the producer holds right now; `[]` on any failure. */
export function readCallEvents(): CallEventInput[] {
    try {
        const out = source();
        return Array.isArray(out) ? [...out] : [];
    } catch {
        return [];
    }
}

/**
 * The pinned share-context events (start / codec / clamp / crop / display /
 * decoder of the current share), which outlive the ring. Same contract as
 * readCallEvents; the builder merges them in, deduplicated.
 */
export function readPinnedCallEvents(): CallEventInput[] {
    try {
        const out = getPinnedCallEvents();
        return Array.isArray(out) ? [...out] : [];
    } catch {
        return [];
    }
}
