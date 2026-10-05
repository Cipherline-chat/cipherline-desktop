/**
 * Shared user-gesture unlock registry for AudioContexts created before any
 * click/keydown has happened yet (cold app launch, auto-join a voice
 * channel on startup). Chrome/Electron suspend such contexts and only ever
 * resume() them in response to a genuine user gesture.
 *
 * Why this exists: `voiceProcessor.ts`'s `init()` used to `await
 * ctx.resume()` directly. If no gesture had occurred yet, that await never
 * settles — and because `setProcessor()` holds LiveKit's `trackChangeLock`
 * while it runs, the mic stayed published raw (no NS) for the entire call,
 * with mute/device-switch silently wedged behind the same lock. Clicking
 * "leave" was incidentally the first gesture, which is why rejoining
 * "fixed" it.
 *
 * The fix: never block on resume(). Fire it non-blockingly and register the
 * context here instead; a persistent (not one-shot) gesture listener drains
 * this registry on every click/keydown for the lifetime of the app. It has
 * to be persistent rather than one-shot because the mic's AudioContext is
 * frequently created well AFTER the very first gesture in the app (e.g. the
 * user clicked around the UI, THEN auto-joined a voice channel) — a
 * one-shot listener that already fired and removed itself would never catch
 * that later context.
 */

const pending = new Set<AudioContext>();

/**
 * Register a suspended AudioContext to be resumed on the next user gesture.
 * No-op if the context is already running (or already closed) — callers can
 * call this unconditionally right after creating a context without checking
 * state themselves.
 */
export function registerCtxForUnlock(ctx: AudioContext): void {
    if (ctx.state !== 'suspended') return;
    pending.add(ctx);
}

/**
 * Drive every pending context toward 'running'. Cheap to call on every
 * gesture — resuming an already-running context is a no-op, and this prunes
 * anything closed or already resumed from the pending set.
 */
export function unlockPendingContexts(): void {
    if (pending.size === 0) return;
    for (const ctx of Array.from(pending)) {
        if (ctx.state === 'closed') {
            pending.delete(ctx);
            continue;
        }
        if (ctx.state === 'suspended') {
            ctx.resume()
                .then(() => pending.delete(ctx))
                .catch(() => { /* still suspended — stays registered, next gesture retries */ });
        } else {
            pending.delete(ctx);
        }
    }
}
