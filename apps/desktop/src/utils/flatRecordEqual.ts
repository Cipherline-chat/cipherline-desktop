/**
 * Structural equality for `Record<string, flat object>` snapshots — the shape
 * SidebarConference pushes into CallContext telemetry on every participant
 * event (`identity → { hasCamera, hasScreenShare, isSpeaking, isMuted }` and
 * `identity → ParticipantMeta`).
 *
 * Why it exists: that push used to build fresh objects and set them
 * unconditionally, so every event — including ones that changed nothing a
 * reader could see (a re-subscribe, a TrackPublished for a source the snapshot
 * doesn't model, a second listener for the same transition) — re-rendered
 * every telemetry subscriber (the server's voice roster, the floating huddle
 * card). Comparing first lets the setter keep the previous object, which React
 * treats as "no update".
 *
 * Inner values are compared with Object.is, one level deep — the snapshots are
 * flat by construction (booleans only); a nested object would compare by
 * identity, which is the conservative direction (reports "changed").
 */
export function flatRecordEqual<V extends object>(
    a: Record<string, V> | null | undefined,
    b: Record<string, V> | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        const x = a[k] as Record<string, unknown>;
        const y = b[k] as Record<string, unknown>;
        if (x === y) continue;
        if (!x || !y) return false;
        const xk = Object.keys(x);
        if (xk.length !== Object.keys(y).length) return false;
        for (const f of xk) {
            if (!Object.prototype.hasOwnProperty.call(y, f) || !Object.is(x[f], y[f])) return false;
        }
    }
    return true;
}
