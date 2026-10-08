/**
 * Coalesces many per-emoji URL resolutions into a few published snapshots.
 *
 * The emoji picker hands emoji-mart a `custom` category; emoji-mart treats
 * ANY change to it as a full reset (re-inits its ~1,900-emoji dataset and
 * rebuilds the grid). The picker used to publish one new map per resolved
 * emoji, so a server with 100 un-cached emojis rebuilt the picker up to 100
 * times while it loaded. This publishes:
 *   - at most once per `flushMs` while resolutions trickle in (trailing), and
 *   - immediately once every expected id has settled (resolved or failed).
 * Pure timer logic, no React — unit-tested in emojiUrlBatcher.test.ts.
 */
export interface UrlBatcher {
    resolve(id: string, url: string): void;
    fail(id: string): void;
    /** Publish now if anything changed since the last publish. */
    flushIfDirty(): void;
    dispose(): void;
}

export function createUrlBatcher(
    expectedIds: string[],
    flushMs: number,
    publish: (snapshot: Record<string, string>) => void,
): UrlBatcher {
    const expected = new Set(expectedIds);
    const settled = new Set<string>();
    const urls: Record<string, string> = {};
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!dirty || disposed) return;
        dirty = false;
        publish({ ...urls });
    };
    const allSettled = () => {
        for (const id of expected) if (!settled.has(id)) return false;
        return true;
    };
    const changed = () => {
        if (disposed) return;
        if (allSettled()) { flush(); return; }
        if (!timer) timer = setTimeout(flush, flushMs);
    };

    return {
        resolve(id, url) {
            if (disposed || urls[id] === url) { settled.add(id); return; }
            urls[id] = url;
            settled.add(id);
            dirty = true;
            changed();
        },
        fail(id) {
            if (disposed || settled.has(id)) return;
            settled.add(id);
            changed();
        },
        flushIfDirty: flush,
        dispose() {
            disposed = true;
            if (timer) { clearTimeout(timer); timer = null; }
        },
    };
}
