import { useEffect, useRef } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import { CoalescedWriter } from '../utils/coalescedWriter';

/**
 * How long a burst has to go quiet before the snapshot is serialized and
 * written. Long enough to swallow a boot backlog drain (messages arrive in
 * rapid succession), short enough that a normal quit-right-after-typing still
 * lands well inside the flush-on-teardown safety net below.
 */
const PERSIST_DEBOUNCE_MS = 600;

/**
 * Persist `value` to `key` in secureLocalStore, coalescing bursts into a
 * single serialize + write. See CoalescedWriter for why this matters (every
 * write is a full snapshot, so intermediate ones are pure waste).
 *
 * `skipEmpty` preserves the original persist effects' guard: on first mount the
 * state is `{}` before the restore effect populates it, and both effects run in
 * the same commit — writing the empty object would wipe the cache before the
 * loaded data could be written back. Intentional clears bypass this hook and
 * call secureLocalStore.removeItem directly, so ignoring `{}` is safe.
 *
 * Passing a null `key` (no user yet) disables persistence entirely.
 */
export function useCoalescedPersist(
    key: string | null,
    value: Record<string, unknown>,
    opts: {
        skipEmpty?: boolean;
        /** Override how the snapshot is written. Message history uses this to
         *  persist per-conversation records via messageStore instead of one
         *  blob under `key` — the coalescing and flush-on-teardown guarantees
         *  are identical either way, only the destination differs. */
        write?: (key: string, value: Record<string, unknown>) => void;
    } = {},
): void {
    const skipEmpty = opts.skipEmpty ?? true;

    // Held in a ref so the writer closure always calls the LATEST `write` prop
    // without having to rebuild the CoalescedWriter (which would drop a
    // pending snapshot on every render).
    const writeRef = useRef(opts.write);
    useEffect(() => { writeRef.current = opts.write; }, [opts.write]);

    const writerRef = useRef<CoalescedWriter<Record<string, unknown>> | null>(null);
    if (writerRef.current === null) {
        writerRef.current = new CoalescedWriter<Record<string, unknown>>((k, v) => {
            try {
                const custom = writeRef.current;
                if (custom) custom(k, v);
                else secureLocalStore.setItem(k, JSON.stringify(v));
            } catch { /* quota / serialization — non-fatal, same as before */ }
        }, PERSIST_DEBOUNCE_MS);
    }

    // Durability net. A delivered message exists ONLY in this cache (the
    // server drops the envelope once ACKed), so a pending snapshot must
    // survive the window closing, the app quitting, or this component going
    // away. All three funnel into the same synchronous flush.
    useEffect(() => {
        const writer = writerRef.current!;
        const flush = () => writer.flush();
        const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };

        window.addEventListener('beforeunload', flush);
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onHidden);
        return () => {
            window.removeEventListener('beforeunload', flush);
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onHidden);
            flush(); // unmount is a teardown too
        };
    }, []);

    useEffect(() => {
        if (!key) return;
        if (skipEmpty && Object.keys(value).length === 0) return;
        writerRef.current!.schedule(key, value);
    }, [key, value, skipEmpty]);
}
