import { useEffect, useRef } from 'react';

/**
 * Self-heal for the composer's "Waiting for channel keys…" gate.
 *
 * The gate is raised from many places (opening a channel whose key isn't
 * installed yet, the connect sweep, a failed send) and lowered only by the
 * events that install a key. That left one gap: when the gate was raised on a
 * snapshot that went stale a moment later — a key store still hydrating right
 * after launch, a pull that was already in flight and finished before anything
 * looked again — the key was present but nothing re-read it, so the channel sat
 * on "Waiting for channel keys" until the user left and re-entered it (which
 * re-reads the store and clears the flag).
 *
 * While the OPEN channel is gated, look again: the moment this device holds a
 * key for it, lower the gate. Same rule every other clear-site uses ("a key is
 * held"), and never raises anything — a channel that genuinely has no key keeps
 * its gate (and its key request) exactly as before. Cheap: one local IPC read
 * per tick, only for the one open, gated channel.
 */
export const GATE_HEAL_FAST_MS = 1_500;
export const GATE_HEAL_SLOW_MS = 6_000;
/** Ticks at the fast rate before settling to the slow one. */
export const GATE_HEAL_FAST_TICKS = 20;

export function useChannelKeyGateHeal(opts: {
    /** The open server channel, or null. */
    channelId: string | null;
    /** Is that channel currently gated? */
    awaiting: boolean;
    /** The newest epoch this device holds for a channel, or null for none. */
    getLatestEpoch: (channelId: string) => Promise<number | null>;
    /** A key is held: lower the gate. */
    onHeld: (channelId: string) => void;
}): void {
    const { channelId, awaiting } = opts;
    const latest = useRef(opts);
    useEffect(() => { latest.current = opts; });

    useEffect(() => {
        if (!channelId || !awaiting) return;
        let stopped = false;
        let ticks = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            timer = null;
            if (stopped) return;
            try {
                const held = await latest.current.getLatestEpoch(channelId);
                if (stopped) return;
                if (held !== null && held !== undefined) {
                    latest.current.onHeld(channelId);
                    return;
                }
            } catch { /* the store may be busy: look again */ }
            ticks++;
            timer = setTimeout(() => { void tick(); }, ticks < GATE_HEAL_FAST_TICKS ? GATE_HEAL_FAST_MS : GATE_HEAL_SLOW_MS);
        };
        timer = setTimeout(() => { void tick(); }, GATE_HEAL_FAST_MS);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [channelId, awaiting]);
}
