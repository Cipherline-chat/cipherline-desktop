/**
 * `gift:updated` fan-out inside the renderer.
 *
 * The API pushes `{ event: 'gift:updated', data: { gift_id } }` to the buyer's
 * and the recipient's sockets when a gift is paid / accepted / refunded. It
 * carries the id only; whoever shows that gift (a chat card, the Settings
 * list) re-fetches it through the buyer/recipient-only read. useRealtime calls
 * `emitGiftUpdated`; components subscribe with `onGiftUpdated`.
 */
type Listener = (giftId: string) => void;

const listeners = new Set<Listener>();

export function onGiftUpdated(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function emitGiftUpdated(giftId: unknown): void {
    if (typeof giftId !== 'string' || giftId.length > 64) return;
    for (const fn of [...listeners]) {
        try { fn(giftId); } catch { /* one bad listener must not stop the rest */ }
    }
}
