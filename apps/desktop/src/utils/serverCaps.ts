/**
 * What the CONNECTED server has said it understands, for fields an older server
 * would reject outright.
 *
 * `message:read` is validated strictly (unknown field = the whole event is
 * silently dropped, so the read, its receipt and the phone badge clear are all
 * lost). The optional `idle_ms` on it is therefore sent ONLY once the server has
 * announced `read_idle_ms` in a `presence:ack` (the heartbeat reply, which every
 * connection gets within 15 s). Until then reads go out without it: the server
 * treats a read with no proof as "defer the phone 2 min", never as a failure,
 * and this client's own idle gate still withholds auto reads from an idle PC.
 * Reset on every (re)connect: the next socket may land on an older pod.
 */
let readIdleMs = false;

export function noteServerCaps(ackData: unknown): void {
    if (ackData && typeof ackData === 'object' && (ackData as Record<string, unknown>).read_idle_ms === true) readIdleMs = true;
}
export function serverAcceptsReadIdleMs(): boolean { return readIdleMs; }
export function resetServerCaps(): void { readIdleMs = false; }
