/**
 * pinSync — conflict resolution for pins arriving from your other devices.
 *
 * A pin is a personal bookmark, so it syncs device-to-device through the
 * existing E2EE envelope (a `pin` ClientContent addressed only to your own
 * devices) rather than through any server-side pin state. That transport is
 * per-device and store-and-forward, which means ops are NOT globally ordered:
 * pin on the laptop and unpin on the desktop within the same minute and the
 * two devices can apply them in opposite orders. Without a tiebreak they
 * disagree permanently, and nothing ever reconciles them.
 *
 * So each op carries the sending device's clock and the newest one wins.
 * Clocks between a user's own devices are close enough for this — and the
 * failure mode of a skewed clock is "the pin ends up in the state the skewed
 * device chose", not corruption.
 *
 * The pinned-id map keeps its existing `Record<containerId, msgId[]>` shape.
 * The renderer, the backup vault and `sweepRetention` all read it, and
 * changing it would ripple through all three; the timestamps live in a
 * separate ledger alongside instead. Both are plain data — no React, no DOM —
 * so this file is unit-testable under vitest's node environment.
 */

/** `Record<containerId, msgId[]>` — conversation_id or channel_id. */
export type PinMap = Record<string, string[]>;
/** `Record<containerId, Record<msgId, appliedAtMs>>`. */
export type PinLedger = Record<string, Record<string, number>>;

export interface PinOp {
    container_id: string;
    target_id: string;
    action: 'add' | 'remove';
    /** Sender's wall clock in ms. */
    at: number;
}

export interface PinState {
    pins: PinMap;
    ledger: PinLedger;
}

/**
 * Apply one op. Returns the SAME object references when nothing changed, so a
 * caller can use identity to skip a re-render and a persist write.
 *
 * An op is ignored when the ledger already holds an entry at or after its
 * timestamp. Using `>=` rather than `>` makes replays idempotent: the poll
 * loop can hand us the same envelope twice (delivery is at-least-once) and
 * the second application is a no-op rather than a flip-flop.
 */
export function applyPinOp(state: PinState, op: PinOp): PinState {
    const { container_id, target_id, action, at } = op;
    if (!container_id || !target_id) return state;
    if (!Number.isFinite(at)) return state;

    const lastAt = state.ledger[container_id]?.[target_id];
    if (lastAt !== undefined && at <= lastAt) return state;

    const current = state.pins[container_id] ?? [];
    const has = current.includes(target_id);
    const wants = action === 'add';

    const nextLedger: PinLedger = {
        ...state.ledger,
        [container_id]: { ...(state.ledger[container_id] ?? {}), [target_id]: at },
    };

    // Record the timestamp even when the id set doesn't move. Otherwise a
    // later, OLDER op would find no ledger entry and get applied.
    if (has === wants) return { pins: state.pins, ledger: nextLedger };

    const nextList = wants
        ? [...current, target_id]
        : current.filter(id => id !== target_id);

    const nextPins: PinMap = { ...state.pins };
    if (nextList.length > 0) nextPins[container_id] = nextList;
    else delete nextPins[container_id];   // don't leave empty arrays behind

    return { pins: nextPins, ledger: nextLedger };
}

/** Apply a batch in order. A single poll can deliver several ops at once. */
export function applyPinOps(state: PinState, ops: readonly PinOp[]): PinState {
    return ops.reduce(applyPinOp, state);
}

/**
 * A React state updater for the pinned-id map whose LWW ledger lives in a ref
 * beside it — safe to run more than once.
 *
 * React may call a state updater twice (StrictMode in every dev build, which
 * is what the Windows test PC runs) or again when it rebases a render. The old
 * inline pattern
 *
 *     setPins(prev => { const n = applyPinOp({ pins: prev, ledger: ref.current }, op);
 *                       ref.current = n.ledger; return n.pins; })
 *
 * wrote the op's timestamp into the ledger on the first call, so the second
 * call found `at <= lastAt`, treated its own op as a stale replay and returned
 * `prev` unchanged — and React keeps the second result. Measured under
 * React 19 StrictMode: Unpin did nothing (the pin stayed), and with any other
 * update queued first Pin did nothing either ("same with unpinning",
 * 2026-10-08). The same applied to pin ops synced from your other devices and
 * to the `personal_saves` merge.
 *
 * Fix: every invocation computes from the ledger as it stood when THIS
 * updater first ran. React replays a queue's updaters in the same order, so
 * an earlier updater's replay has already restored that same ledger by the
 * time this one replays; the result is identical on every call.
 */
export function replaySafePinUpdater(
    ledgerRef: { current: PinLedger },
    step: (state: PinState) => PinState,
): (prev: PinMap) => PinMap {
    let before: PinLedger | null = null;
    return (prev: PinMap) => {
        if (before === null) before = ledgerRef.current;
        const next = step({ pins: prev, ledger: before });
        ledgerRef.current = next.ledger;
        return next.pins;
    };
}

/**
 * Build the op for a LOCAL pin toggle, to be both applied locally and sent to
 * your other devices. Local actions are authoritative at the moment they
 * happen; callers must apply the returned op through applyPinOp too, or the
 * ledger won't know about their own change and a stale remote op could undo it.
 *
 * Pass the current `ledger` and the op is stamped `max(now, lastAt + 1)`. A
 * plain `now` lost to a ledger entry written by a device whose clock runs
 * ahead: applyPinOp ignores `at <= lastAt`, so the user's own unpin silently
 * did nothing (multi-device audit 2026-10-03).
 */
export function localPinOp(containerId: string, targetId: string, action: 'add' | 'remove', now: number, ledger?: PinLedger): PinOp {
    const lastAt = ledger?.[containerId]?.[targetId];
    const at = typeof lastAt === 'number' && Number.isFinite(lastAt) && lastAt >= now ? lastAt + 1 : now;
    return { container_id: containerId, target_id: targetId, action, at };
}

/** One decrypted DM/group row, as far as pin sync cares. */
export interface PinCarrier {
    conversation_id?: string;
    sender_user_id?: string | null;
    content?: { type?: unknown; conversation_id?: unknown; target_id?: unknown; action?: unknown; at?: unknown } | null;
}

/**
 * The pin ops in a pulled batch that this device may apply: only those its
 * OWN user sent (a personal pin is a bookmark between your own devices), and
 * only for the conversation the envelope travelled in.
 *
 * Before this, the desktop applied every decrypted `pin` content regardless
 * of sender. Any DM or group member could send one and add or remove pins on
 * the victim's devices (and force a save-forever on them) — and with a
 * far-future `at` win the LWW ledger permanently, then ride the victim's own
 * `personal_saves` sync to every other device they own. Mobile already
 * checked (`fromOwnDevice`). Sender identity here is the one sealed inside
 * the envelope, so it cannot be claimed by the server.
 */
export function ownPinOps(batch: Record<string, readonly PinCarrier[]>, myUserId: string | null | undefined): PinOp[] {
    const out: PinOp[] = [];
    if (!myUserId) return out;
    for (const [conversationId, msgs] of Object.entries(batch)) {
        for (const m of msgs) {
            const c = m?.content;
            if (!c || c.type !== 'pin') continue;
            if (m.sender_user_id !== myUserId) continue;
            if (c.conversation_id !== conversationId) continue;
            if (typeof c.target_id !== 'string' || !c.target_id) continue;
            if (c.action !== 'add' && c.action !== 'remove') continue;
            if (typeof c.at !== 'number' || !Number.isFinite(c.at)) continue;
            out.push({ container_id: conversationId, target_id: c.target_id, action: c.action, at: c.at });
        }
    }
    return out;
}

/**
 * Drop ledger entries for containers/messages that are no longer pinned and
 * whose last op is older than `maxAgeMs`. The ledger is write-mostly and would
 * otherwise grow forever with tombstones for every message ever unpinned.
 * Entries for currently-pinned ids are always kept, however old.
 */
export function pruneLedger(state: PinState, now: number, maxAgeMs: number): PinState {
    const nextLedger: PinLedger = {};
    let changed = false;

    for (const [containerId, entries] of Object.entries(state.ledger)) {
        const pinned = new Set(state.pins[containerId] ?? []);
        const kept: Record<string, number> = {};
        for (const [msgId, at] of Object.entries(entries)) {
            if (pinned.has(msgId) || (now - at) < maxAgeMs) kept[msgId] = at;
            else changed = true;
        }
        if (Object.keys(kept).length > 0) nextLedger[containerId] = kept;
        else if (Object.keys(entries).length > 0) changed = true;
    }

    return changed ? { pins: state.pins, ledger: nextLedger } : state;
}
