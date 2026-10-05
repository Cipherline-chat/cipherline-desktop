import {
    KEYS_QUIPS, KEYS_SLEEPY_POOL,
    KEYS_OBS_MENTIONS, KEYS_OBS_CALLS, KEYS_OBS_LATENIGHT, KEYS_OBS_EARLY,
    KEYS_OBS_NOBACKUP, KEYS_OBS_UNREADS, KEYS_OBS_QUIET, KEYS_OBS_FRIDAY,
    KEYS_OBS_SNOW, pickRotating,
} from './eggPools';

/**
 * keysObservations — what Keys notices before he speaks.
 *
 * A pure priority engine: given a snapshot of LOCAL UI state (counts, the
 * clock, presence — rule 8: never message content, and nothing here leaves
 * the component, let alone the machine), pick the most interesting true
 * observation. Falls back to the generic KEYS_QUIPS pool when nothing stands
 * out. Every pool lives in eggPools.ts so the doctrine tests cover it.
 *
 * Priority reads top-down as "what would a small resident sea creature
 * actually bring up first": someone's saying your name > there's a party you
 * aren't at > it's absurdly late > you STILL have no backup > the pile of
 * unreads > it's very quiet > small talk about the calendar.
 */

export interface KeysContext {
    /** Local hour, 0–23. */
    hour: number;
    /** Local day of week, 0 (Sun) – 6 (Sat). */
    dayOfWeek: number;
    /** Local month, 0–11. */
    month: number;
    mentions: number;
    unreads: number;
    friendsOnline: number;
    friendsTotal: number;
    /** People currently in calls across your servers. */
    callParticipants: number;
    backupConfigured: boolean;
}

function fill(line: string, n: number): string {
    return line.replace(/\{n\}/g, String(n));
}

/** The context-aware line for a speaking poke, or null → use the generic
 *  pool. `seq` drives rotation within whichever pool wins (rule 3). */
export function pickObservation(ctx: KeysContext, seq: number): string | null {
    if (ctx.mentions > 0) return pickRotating(KEYS_OBS_MENTIONS, seq);
    if (ctx.callParticipants > 0) return fill(pickRotating(KEYS_OBS_CALLS, seq), ctx.callParticipants);
    if (ctx.hour < 5) return pickRotating(KEYS_OBS_LATENIGHT, seq);
    if (!ctx.backupConfigured) return pickRotating(KEYS_OBS_NOBACKUP, seq);
    if (ctx.unreads >= 5) return fill(pickRotating(KEYS_OBS_UNREADS, seq), ctx.unreads);
    if (ctx.hour < 8) return pickRotating(KEYS_OBS_EARLY, seq);
    if (ctx.friendsOnline === 0 && ctx.unreads === 0 && ctx.friendsTotal > 0) {
        return pickRotating(KEYS_OBS_QUIET, seq);
    }
    if (ctx.month === 11) return pickRotating(KEYS_OBS_SNOW, seq);
    if (ctx.dayOfWeek === 5) return pickRotating(KEYS_OBS_FRIDAY, seq);
    return null;
}

/** The line for a speaking poke: contextual on the FIRST spoken line of a
 *  streak (that's the "he noticed something" slot), generic rotation after. */
export function pokeLine(ctx: KeysContext, pokes: number, seq: number): string {
    if (pokes === 1) {
        const obs = pickObservation(ctx, seq);
        if (obs) return obs;
    }
    return pickRotating(KEYS_QUIPS, seq);
}

/** The sleepy protest — its own tiny pool, not a generic quip. */
export function sleepyLine(seq: number): string {
    return pickRotating(KEYS_SLEEPY_POOL, seq);
}
