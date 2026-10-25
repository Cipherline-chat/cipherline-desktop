/**
 * The keyless side of channel-key delivery: asking again, soon, when nothing
 * arrived.
 *
 * A device that holds no key for a channel files a persistent key request;
 * every online holder is pushed it and answers. Before this module, if that
 * first answer did not land — the holder's POST was refused (a 403 from a
 * fail-closed permission check while the API's DB pool was timing out, seen
 * on prod 2026-10-11), it failed and the holder backed off, the holder missed
 * the push, or its envelope would not install — the device asked again only
 * on the 75 s retry timer (60 s per-channel dedup), and holders answer a
 * re-ask, not a repeat of an ask they already answered. So one lost answer
 * cost 75 s, two cost 150 s.
 *
 * Worse, a joiner whose NEWEST-epoch envelope failed while the history after it
 * landed held "a key" — so its gate lifted, the channel counted as merely
 * stale, and stale channels are deliberately never timer-driven (the
 * 2026-10-07 storm): nothing re-asked at all until the user re-opened the
 * channel, and sends were refused (409 STALE_EPOCH) meanwhile.
 *
 * Now, from the moment a request is filed for a channel this device holds NO
 * key for, the device re-checks on a short capped schedule (2.5 s, 6 s, 12 s,
 * 30 s, then every 30 s for 5 minutes, after which the 75 s timer and the
 * 10-minute fallback rotation take over as before). Each check pulls first,
 * and then:
 *   • every channel asked for that way holds the newest epoch the API named
 *     when it was asked for → done;
 *   • one of them got its newest epoch since the last check → a holder is
 *     delivering: ask nobody anything (no storm while delivery is in flight;
 *     history landing does NOT count — a holder busy sending history while a
 *     refused newest epoch is still missing must be asked again);
 *   • otherwise → re-ask (a new request version, which every online holder is
 *     pushed and answers at once) for a few of the channels still short of
 *     their newest epoch — the open one first, then least-recently-asked —
 *     within an account-wide budget.
 *
 * Bounds (why this cannot become the 2026-10-07/09 storms): a channel is only
 * ever re-asked here if this device held NO key for it when it asked — a
 * long-time member's stale channel (holds an older epoch; the newest's holder
 * is gone) is never a target, so the 2026-10-07 loop cannot come back; at most
 * KEY_REASK_MAX_PER_TICK per server per check and KEY_REASK_BUDGET_PER_MIN per
 * account per minute (the API allows a user 60 key-request POSTs a minute); a
 * channel asked by any path in the last KEY_REASK_MIN_GAP_MS is skipped; a
 * window that ends unsatisfied is not re-opened for KEY_REASK_REARM_AFTER_MS.
 * Holders coalesce pushes into one serve pass per server, so a re-ask costs
 * each online holder one GET plus the envelopes the device is actually
 * missing.
 */

/** Check times, measured from when the schedule was armed (first request). */
export const KEY_REASK_AT_MS: readonly number[] = [2_500, 6_000, 12_000, 30_000];
/** After the last fixed check, every this often… */
export const KEY_REASK_STEADY_MS = 30_000;
/** …until this long after arming. The 75 s retry timer covers anything older. */
export const KEY_REASK_WINDOW_MS = 5 * 60_000;
/** A window that ran out without keys is not re-opened for this long. */
export const KEY_REASK_REARM_AFTER_MS = 10 * 60_000;
export const KEY_REASK_MAX_PER_TICK = 6;
export const KEY_REASK_BUDGET_PER_MIN = 30;
export const KEY_REASK_MIN_GAP_MS = 2_000;
/** Spacing between the re-ask POSTs of one check. */
export const KEY_REASK_SPACING_MS = 150;

/** Sliding one-minute budget for re-asks, account-wide. */
export class ReaskBudget {
    private stamps: number[] = [];
    private readonly perMinute: number;
    constructor(perMinute: number = KEY_REASK_BUDGET_PER_MIN) {
        this.perMinute = perMinute;
    }

    available(now: number): number {
        this.stamps = this.stamps.filter(t => now - t < 60_000);
        return Math.max(0, this.perMinute - this.stamps.length);
    }

    consume(n: number, now: number): void {
        for (let i = 0; i < n; i++) this.stamps.push(now);
    }
}

/** Which still-unsatisfied channels to re-ask now (pure). */
export function planReask(args: {
    now: number;
    missing: readonly string[];
    progressed: boolean;
    activeChannelId: string | null;
    lastAskedAt: (channelId: string) => number | undefined;
    budgetAvailable: number;
}): string[] {
    if (args.progressed || !args.missing.length) return [];
    const eligible = args.missing.filter(c => args.now - (args.lastAskedAt(c) ?? 0) >= KEY_REASK_MIN_GAP_MS);
    eligible.sort((a, b) => {
        if (a === args.activeChannelId) return -1;
        if (b === args.activeChannelId) return 1;
        return (args.lastAskedAt(a) ?? 0) - (args.lastAskedAt(b) ?? 0);
    });
    return eligible.slice(0, Math.max(0, Math.min(KEY_REASK_MAX_PER_TICK, args.budgetAvailable)));
}

/**
 * Channels this device asked for while holding NO key, with the newest epoch
 * the API reported for each (the key-request response's latest_epoch). A
 * target is satisfied once that epoch (or a newer one) is held locally.
 */
export class ReaskTargets {
    private readonly byChannel = new Map<string, { serverId: string; latest: number }>();

    add(serverId: string, channelId: string, latest: number): void {
        const prev = this.byChannel.get(channelId);
        this.byChannel.set(channelId, { serverId, latest: Math.max(latest, prev?.latest ?? 0) });
    }

    forServer(serverId: string): string[] {
        return [...this.byChannel].filter(([, t]) => t.serverId === serverId).map(([c]) => c);
    }

    latestOf(channelId: string): number | undefined {
        return this.byChannel.get(channelId)?.latest;
    }

    delete(channelId: string): void {
        this.byChannel.delete(channelId);
    }

    clearServer(serverId: string): void {
        for (const c of this.forServer(serverId)) this.byChannel.delete(c);
    }

    clear(): void {
        this.byChannel.clear();
    }
}

export interface ReaskTickDeps {
    /** pullChannelKeys (single-flight) — installs anything already waiting. */
    pull: (serverId: string) => Promise<void>;
    /** This server's channels asked for while keyless (ReaskTargets.forServer). */
    wantedChannels: (serverId: string) => string[];
    /** Does this device now hold the newest epoch named for that channel? */
    hasNewest: (channelId: string) => Promise<boolean>;
    /** It does: stop tracking it (and lift any gate). */
    onSatisfied: (channelId: string) => void;
    /** When a key request was last POSTed for the channel (any path). */
    lastAskedAt: (channelId: string) => number | undefined;
    activeChannelId: () => string | null;
    /** POST key-request (bypassing the 60 s dedup; this schedule IS the limit). */
    fileKeyRequest: (serverId: string, channelId: string) => Promise<unknown>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    budget: ReaskBudget;
}

export type ReaskTickResult = 'done' | 'waiting' | 'reasked';

/**
 * One check. Targets are only ever removed here (or when the window runs
 * out), so "satisfied in this check" is exactly "got its newest epoch since
 * the last check" — the progress signal.
 */
export async function runReaskTick(deps: ReaskTickDeps, serverId: string): Promise<ReaskTickResult> {
    try { await deps.pull(serverId); } catch { /* the check below still runs */ }
    const missing: string[] = [];
    let satisfied = 0;
    for (const cid of deps.wantedChannels(serverId)) {
        if (await deps.hasNewest(cid)) { deps.onSatisfied(cid); satisfied += 1; }
        else missing.push(cid);
    }
    if (!missing.length) return 'done';
    const now = deps.now();
    const want = planReask({
        now,
        missing,
        progressed: satisfied > 0,
        activeChannelId: deps.activeChannelId(),
        lastAskedAt: deps.lastAskedAt,
        budgetAvailable: deps.budget.available(now),
    });
    if (!want.length) return 'waiting';
    deps.budget.consume(want.length, now);
    for (let i = 0; i < want.length; i++) {
        if (i > 0) await deps.sleep(KEY_REASK_SPACING_MS);
        await deps.fileKeyRequest(serverId, want[i]);
    }
    return 'reasked';
}

interface ArmedServer {
    armedAt: number;
    step: number;
    timer: ReturnType<typeof setTimeout> | null;
}

/**
 * One capped re-check schedule per server, armed whenever this device files a
 * key request there. Arming an armed server is a no-op; a schedule ends when
 * its check reports 'done' or its window runs out (then it stays closed for
 * KEY_REASK_REARM_AFTER_MS, so the 75 s timer's re-requests cannot keep
 * re-opening it for a channel nobody can answer).
 */
export class KeyReaskScheduler {
    private readonly armed = new Map<string, ArmedServer>();
    private readonly exhaustedAt = new Map<string, number>();
    private readonly now: () => number;
    private readonly tick: (serverId: string) => Promise<ReaskTickResult>;
    private readonly onExhausted?: (serverId: string) => void;

    constructor(opts: {
        now?: () => number;
        tick: (serverId: string) => Promise<ReaskTickResult>;
        /** The window ran out unsatisfied (drop that server's targets). */
        onExhausted?: (serverId: string) => void;
    }) {
        this.now = opts.now ?? Date.now;
        this.tick = opts.tick;
        this.onExhausted = opts.onExhausted;
    }

    isArmed(serverId: string): boolean {
        return this.armed.has(serverId);
    }

    arm(serverId: string): void {
        if (this.armed.has(serverId)) return;
        const ended = this.exhaustedAt.get(serverId);
        if (ended !== undefined && this.now() - ended < KEY_REASK_REARM_AFTER_MS) return;
        const now = this.now();
        const s: ArmedServer = { armedAt: now, step: 0, timer: null };
        this.armed.set(serverId, s);
        this.scheduleNext(serverId, s);
    }

    disarm(serverId: string): void {
        const s = this.armed.get(serverId);
        if (s?.timer) clearTimeout(s.timer);
        this.armed.delete(serverId);
    }

    disarmAll(): void {
        for (const id of [...this.armed.keys()]) this.disarm(id);
        this.exhaustedAt.clear();
    }

    /** Offset (from arming) of check number `step`. */
    static offsetOf(step: number): number {
        if (step < KEY_REASK_AT_MS.length) return KEY_REASK_AT_MS[step];
        return KEY_REASK_AT_MS[KEY_REASK_AT_MS.length - 1] + (step - KEY_REASK_AT_MS.length + 1) * KEY_REASK_STEADY_MS;
    }

    private scheduleNext(serverId: string, s: ArmedServer): void {
        const offset = KeyReaskScheduler.offsetOf(s.step);
        if (offset > KEY_REASK_WINDOW_MS) {
            this.armed.delete(serverId);
            this.exhaustedAt.set(serverId, this.now());
            this.onExhausted?.(serverId);
            return;
        }
        const delay = Math.max(0, s.armedAt + offset - this.now());
        s.timer = setTimeout(() => { void this.fire(serverId, s); }, delay);
    }

    private async fire(serverId: string, s: ArmedServer): Promise<void> {
        s.timer = null;
        let result: ReaskTickResult = 'waiting';
        try { result = await this.tick(serverId); } catch { /* keep the schedule */ }
        if (this.armed.get(serverId) !== s) return; // disarmed / re-armed meanwhile
        if (result === 'done') {
            this.armed.delete(serverId);
            this.exhaustedAt.delete(serverId);
            return;
        }
        s.step += 1;
        this.scheduleNext(serverId, s);
    }
}
