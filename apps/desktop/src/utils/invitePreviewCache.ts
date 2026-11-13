/**
 * A recent invite preview, kept for a minute and shared between cards: the same
 * invite in two places, or a card that remounts as you scroll or switch channels
 * and back, asks the server once. Only successes are kept, so a 429 or a dead
 * invite is never remembered. In memory, and only what the preview endpoint
 * already answers to anyone holding the code.
 */
export const INVITE_PREVIEW_TTL_MS = 60_000;
const MAX_KEPT = 200;

const kept = new Map<string, { data: unknown; at: number }>();
const asking = new Map<string, Promise<unknown>>();

export function sharedInvitePreview<T>(
    code: string,
    fetchIt: () => Promise<T>,
    fresh = false,
    now: () => number = Date.now,
): Promise<T> {
    if (!fresh) {
        const hit = kept.get(code);
        if (hit && now() - hit.at < INVITE_PREVIEW_TTL_MS) return Promise.resolve(hit.data as T);
        const running = asking.get(code);
        if (running) return running as Promise<T>;
    }
    const p = fetchIt().then((data) => {
        kept.delete(code);
        kept.set(code, { data, at: now() });
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
        return data;
    }).finally(() => { if (asking.get(code) === p) asking.delete(code); });
    asking.set(code, p);
    return p;
}

export function clearInvitePreviews(): void {
    kept.clear();
    asking.clear();
}
