/**
 * channelMentionRecovery — make an @mention count even when the channel key
 * arrives AFTER the message does.
 *
 * Why this exists (owner report 2026-10-11: "someone @mentioned me in a server
 * set to @mentions only and it just showed a grey unread, not a red 1"):
 *
 * Mentions in server channels can only be detected on the client, AFTER
 * decryption — the server routes ciphertext and never learns who a message
 * pings (only the sender-set `mentions_everyone` flag is plaintext). Two paths
 * decide a channel's mention count, and both silently gave up when this
 * device did not hold the message's epoch key at that moment:
 *
 *  1. LIVE (`channel:message_new` → Dashboard.handleChannelMessage): a decrypt
 *     failure rendered a "waiting for key" placeholder and returned — no
 *     unread, no mention, no notification. When the key landed later, only
 *     the channel ON SCREEN was re-read; a background channel's message was
 *     never looked at again, so its mention was lost for good.
 *  2. RECONCILE (boot / wake / reconnect → GET /servers/:id/unread, then
 *     Dashboard.reconcileChannelMentions): the server's count RAISES the
 *     unread badge — on an @mentions-only server that is exactly the quiet
 *     grey badge — and the newest N rows are decrypted to find mentions. Rows
 *     that could not be decrypted yet (boot races the key pull; a rotation
 *     happened while this device was away) counted as "no mention", and
 *     nothing ever rescanned them once the key arrived. Grey forever.
 *
 * This module remembers both kinds of unfinished work and hands it back once
 * the epoch it was waiting for is actually held, so the caller can finish it:
 * a live event is REPLAYED through the normal live handler (same decision,
 * same counters, same notification rules), a reconcile is simply RE-RUN.
 *
 * Privacy: nothing new leaves the device. The ciphertext kept here is what the
 * WS already delivered; a rescan is the same GET the reconcile already makes.
 * Pure and in-memory — no DOM, no React, no persistence — so it is testable
 * under vitest's node environment (see channelMentionRecovery.test.ts).
 */

import { decideChannelMessage } from './notificationDecision';

/** The fields a pending live event must carry to be routed back. */
export interface PendingChannelEvent {
    channel_id: string;
    server_id: string;
    message_id: string;
    epoch: number;
}

/** Upper bound on remembered live events per channel. A channel that stays
 *  undecryptable for a very long burst keeps only the newest ones; the
 *  reconcile path (server count + rescan) still covers the rest. */
export const MAX_PENDING_PER_CHANNEL = 100;

/**
 * A replayed message older than this still COUNTS (badge), but no longer
 * plays a sound or raises a toast: a ding for something said half an hour ago
 * is noise, not a notification.
 */
export const LATE_ALERT_WINDOW_MS = 10 * 60 * 1000;

export function shouldAlertForReplay(createdAt: string | undefined, now: number): boolean {
    const t = createdAt ? new Date(createdAt).getTime() : NaN;
    if (!Number.isFinite(t)) return false;
    return now - t <= LATE_ALERT_WINDOW_MS;
}

interface LiveEntry<E> { evt: E; receivedAt: number }
interface RescanEntry { serverId: string; epochs: Set<number> }

export interface ReadyWork<E> {
    /** Live events whose epoch is now held, oldest-received first. */
    replay: E[];
    /** Non-null when a reconcile for this channel should be re-run now. */
    rescan: { serverId: string } | null;
}

export class ChannelMentionRecovery<E extends PendingChannelEvent> {
    private live = new Map<string, Map<string, LiveEntry<E>>>();
    private rescan = new Map<string, RescanEntry>();

    /** A live channel message could not be decrypted for lack of a key. */
    addLive(evt: E, receivedAt: number): void {
        let ch = this.live.get(evt.channel_id);
        if (!ch) { ch = new Map(); this.live.set(evt.channel_id, ch); }
        if (ch.has(evt.message_id)) return;
        ch.set(evt.message_id, { evt, receivedAt });
        while (ch.size > MAX_PENDING_PER_CHANNEL) {
            // Map iterates in insertion order: the first key is the oldest.
            const oldest = ch.keys().next().value as string;
            ch.delete(oldest);
        }
    }

    /**
     * A reconcile scanned this channel. `missingEpochs` = epochs of rows it
     * could NOT decrypt for lack of a key (other people's rows only). Empty
     * means the scan was complete, so any earlier pending rescan is settled.
     */
    noteReconcile(channelId: string, serverId: string, missingEpochs: Iterable<number>): void {
        const epochs = new Set(missingEpochs);
        if (epochs.size === 0) { this.rescan.delete(channelId); return; }
        this.rescan.set(channelId, { serverId, epochs });
    }

    /**
     * The server's unread count for this channel was just folded in from a
     * request issued at `requestedAt`. Every live event received before that
     * is included in that count, and the rescan that follows covers its
     * mention — replaying it as well would count its unread twice.
     */
    dropLiveReceivedBefore(channelId: string, requestedAt: number): void {
        const ch = this.live.get(channelId);
        if (!ch) return;
        for (const [id, e] of ch) if (e.receivedAt < requestedAt) ch.delete(id);
        if (ch.size === 0) this.live.delete(channelId);
    }

    /** Channels with any pending work, optionally limited to one server. */
    channels(serverId?: string): string[] {
        const out = new Set<string>();
        for (const [cid, ch] of this.live) {
            if (!serverId) { out.add(cid); continue; }
            for (const e of ch.values()) { if (e.evt.server_id === serverId) { out.add(cid); break; } }
        }
        for (const [cid, r] of this.rescan) if (!serverId || r.serverId === serverId) out.add(cid);
        return [...out];
    }

    /**
     * Take (and forget) the work for `channelId` that `heldEpochs` can now
     * complete. A live event is ready when its own epoch is held; a rescan is
     * ready as soon as ANY epoch it was missing is held (a rescan re-reads the
     * whole unread tail, and whatever is still missing is re-noted by it).
     * Work for epochs still not held stays put.
     */
    takeReady(channelId: string, heldEpochs: ReadonlySet<number>): ReadyWork<E> {
        const replay: E[] = [];
        const ch = this.live.get(channelId);
        if (ch) {
            for (const [id, e] of ch) {
                if (heldEpochs.has(e.evt.epoch)) { replay.push(e.evt); ch.delete(id); }
            }
            if (ch.size === 0) this.live.delete(channelId);
        }
        let rescan: ReadyWork<E>['rescan'] = null;
        const r = this.rescan.get(channelId);
        if (r && [...r.epochs].some(ep => heldEpochs.has(ep))) {
            this.rescan.delete(channelId);
            rescan = { serverId: r.serverId };
        }
        return { replay, rescan };
    }

    /** Count of pending live events + pending rescans (diagnostics / tests). */
    size(): number {
        let n = this.rescan.size;
        for (const ch of this.live.values()) n += ch.size;
        return n;
    }
}

/**
 * Drive the recovery for every pending channel (optionally one server's): ask
 * which epochs this device now holds, then replay / rescan whatever that
 * unlocked. Replays run in received order, one at a time — each is one
 * decrypt on the main process, which also paints the window.
 *
 * Cheap to call often: no network unless a rescan became possible, and only
 * one `listEpochs` IPC per channel that has pending work.
 */
export async function recoverChannelMentions<E extends PendingChannelEvent>(
    recovery: ChannelMentionRecovery<E>,
    deps: {
        serverId?: string;
        listEpochs: (channelId: string) => Promise<number[]>;
        replay: (evt: E) => Promise<void> | void;
        rescan: (serverId: string, channelId: string) => void;
    },
): Promise<void> {
    for (const channelId of recovery.channels(deps.serverId)) {
        let held: Set<number>;
        try {
            held = new Set(await deps.listEpochs(channelId));
        } catch {
            continue;
        }
        const work = recovery.takeReady(channelId, held);
        for (const evt of work.replay) {
            try { await deps.replay(evt); } catch { /* the live handler owns its own failures */ }
        }
        if (work.rescan) deps.rescan(work.rescan.serverId, channelId);
    }
}

/**
 * The mention half of a boot / reconnect reconcile: given the decrypted newest
 * page of a channel the server says is unread, how many of those rows mention
 * the viewer, and which epochs kept rows from being read at all.
 *
 * Uses decideChannelMessage — the live path's own decision — so a message
 * counts as a mention here exactly when it would have live (including user
 * keywords, which this path used to ignore).
 */
export function scanReconcilePage(
    rows: ReadonlyArray<{ id: string; sender_user_id?: string | null; content?: unknown }>,
    ctx: {
        userId: string | null | undefined;
        myRoleIds: ReadonlySet<string>;
        keywords: string[];
        mentionsEveryone: (rowId: string) => boolean;
    },
): { mentionHits: number; missingEpochs: number[] } {
    let mentionHits = 0;
    for (const m of rows) {
        const decision = decideChannelMessage({
            content: m.content as { type?: string; text?: string } | null | undefined,
            senderUserId: m.sender_user_id,
            userId: ctx.userId,
            mentionsEveryone: ctx.mentionsEveryone(m.id),
            myRoleIds: ctx.myRoleIds,
            keywords: ctx.keywords,
            // Only isMention is read here; the delivery context is irrelevant.
            mode: 'all',
            windowFocused: false,
            isActiveConversation: false,
            suppressWhenActiveConv: false,
            dndActive: false,
            dndLetMentionsThrough: false,
        });
        if (decision?.isMention) mentionHits++;
    }
    return { mentionHits, missingEpochs: missingKeyEpochs(rows, ctx.userId) };
}

/**
 * Epochs of rows in a decrypted reconcile page that are still waiting on a
 * key — only OTHER people's rows (our own never count as unread or mention).
 */
export function missingKeyEpochs(
    rows: ReadonlyArray<{ sender_user_id?: string | null; content?: unknown }>,
    userId: string | null | undefined,
): number[] {
    const out = new Set<number>();
    for (const r of rows) {
        if (!r.sender_user_id || r.sender_user_id === userId) continue;
        const c = r.content as { type?: string; kind?: string; data?: { reason?: unknown; epoch?: unknown } } | undefined;
        if (c?.type !== 'system' || c.kind !== 'encrypted') continue;
        const reason = c.data?.reason;
        // A legacy placeholder (no reason) was always a key wait.
        if (reason !== undefined && reason !== 'key_missing') continue;
        if (typeof c.data?.epoch === 'number') out.add(c.data.epoch);
    }
    return [...out];
}
