/**
 * Late link previews (2026-11-23, page-snapshots).
 *
 * Sending never waits more than ~1.5 s for a preview. A preview that was not
 * ready (a slow page), or a page SNAPSHOT still being taken for a page with no
 * picture of its own, goes out late: the message is sent with what was ready
 * (or the minimal card), and when the better preview arrives (within
 * LATE_EMBED_WAIT_MS of the send) the sender's app ATTACHES it with an
 * embeds-only edit: the same text, channel refs, font and size, the improved
 * `embeds`, flagged `embeds_only: true`. Readers do not mark that edit
 * "(edited)" (packages/shared link-embeds.ts isEmbedsOnlyEdit); a real text
 * edit always is.
 *
 * runLateAttach does the wait and the edit with injected pieces (ChatPane
 * gives it the chat's rows and its send; unit-tested without either).
 */
import { sanitizeLinkEmbeds, type ChannelRef, type LinkEmbed, type MessageFont, type MessageSize } from '@cipherline/shared';
import { embedUrlsOf } from '../formatting/plainText';
import { fontField, messageFontOf } from '../formatting/messageFont';
import { messageSizeOf, sizeField } from '../formatting/messageSize';
import type { PreparedEmbed, ThumbUploader } from './prepare';
import { isCopyPending } from './mediaCopy';

/** After this long from the send, a late preview is given up on. */
export const LATE_EMBED_WAIT_MS = 10_000;
/** Uploading the late picture (encrypted, like any thumbnail) may take this much on top. */
export const LATE_EMBED_UPLOAD_MS = 5_000;
/**
 * A COPY of an expiring link's media (2026-11-24, mediaCopy.ts): downloading it
 * may take this long after the send, and uploading it (up to 25 MB) this much
 * on top. Until it lands, readers see the embed with the link.
 */
export const LATE_EMBED_COPY_WAIT_MS = 30_000;
export const LATE_EMBED_COPY_UPLOAD_MS = 60_000;

// The DESIGNED picture (designedThumb.ts) is what went out when nothing better
// was ready: a real one (a frame, a snapshot) arriving later improves on it.
const hasPictureSent = (e: LinkEmbed | undefined) => !!(e && ((e.thumb && !e.thumb.designed) || e.images?.length || (e.kind === 'post' && !e.media && e.author_icon)));
const hasPicturePrepared = (p: PreparedEmbed) => !!((p.thumb && !p.thumb.designed) || p.images?.length || (p.embed.kind === 'post' && !p.embed.media && p.icon));
const isMinimal = (e: Pick<LinkEmbed, 'kind' | 'title' | 'description'>) => e.kind === 'card' && !e.title && !e.description;

/** Is the late `next` worth an edit over what went out for its link (`sent`, maybe nothing)? */
export function improvesOn(sent: LinkEmbed | undefined, next: PreparedEmbed): boolean {
    if (!sent) return true;
    // The copy of an expiring link's media arrived (or finished uploading) after the send.
    if (next.copy && !sent.media?.file) return true;
    if (hasPicturePrepared(next) && !hasPictureSent(sent)) return true;
    return isMinimal(sent) && !isMinimal(next.embed);
}

/**
 * The message's embeds once the late ones (already finalized: pictures
 * uploaded) are in: link order, a late one replacing what went out for its
 * link, everything run through the reader's own validator.
 */
export function mergeLateEmbeds(text: string, sent: readonly LinkEmbed[], late: readonly LinkEmbed[]): LinkEmbed[] {
    const urls = embedUrlsOf(text);
    const merged = urls.map((u) => late.find((e) => e.url === u) ?? sent.find((e) => e.url === u)).filter((e): e is LinkEmbed => !!e);
    return sanitizeLinkEmbeds(merged, urls);
}

/** The message as sent is still the message on screen: same text, same previews (not edited, no preview removed meanwhile). */
export function unchangedSinceSend(content: unknown, text: string, sent: readonly LinkEmbed[]): boolean {
    if (!content || typeof content !== 'object') return false;
    const c = content as { type?: unknown; text?: unknown; embeds?: unknown };
    if (c.type !== 'text' || c.text !== text) return false;
    const now = sanitizeLinkEmbeds(c.embeds, embedUrlsOf(text));
    return JSON.stringify(now) === JSON.stringify(sanitizeLinkEmbeds([...sent], embedUrlsOf(text)));
}

/** What the chat gives runLateAttach (ChatPane; the harness passes the same pieces). */
export interface LateAttachDeps {
    /** The best preview of a link by the deadline (useComposerEmbeds awaitFinalPreview). */
    awaitFinal: (url: string, deadlineAt: number) => Promise<PreparedEmbed | null>;
    /** Pictures inline or uploaded (prepare.ts finalizeEmbeds); copies of media get `copyBudgetMs`. */
    finalize: (text: string, prepared: PreparedEmbed[], upload: ThumbUploader | null, budgetMs: number, copyBudgetMs?: number) => Promise<LinkEmbed[]>;
    /** The sent row as the chat has it now; null when the chat is no longer the one it was sent in. */
    findRow: () => { id: string; content?: unknown; send_state?: string } | null;
    /** Send the edit (encrypted, like any edit). */
    send: (edit: EmbedsOnlyEdit) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface LateAttachJob {
    text: string;
    /** The embeds the message went out with. */
    sent: LinkEmbed[];
    /** The links whose better preview was still coming. */
    late: string[];
    /** When the message was sent (default: now). */
    startedAt?: number;
    upload: ThumbUploader | null;
}

export interface EmbedsOnlyEdit {
    type: 'edit'; target_id: string; text: string; channel_refs?: ChannelRef[];
    font?: MessageFont; size?: MessageSize; embeds: LinkEmbed[]; embeds_only: true;
}

export type LateAttachOutcome = 'attached' | 'nothing-better' | 'moved-on' | 'changed' | 'undelivered';

/**
 * Wait (until LATE_EMBED_WAIT_MS after the send) for the late previews; when
 * one is better than what went out, upload its picture and send the
 * embeds-only edit. Gives up, sending nothing, when the chat changed, the
 * message never got delivered, or it was edited / had a preview removed
 * meanwhile (a real edit always wins).
 */
export async function runLateAttach(job: LateAttachJob, deps: LateAttachDeps): Promise<LateAttachOutcome> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    // A copy of media still downloading gets longer (LATE_EMBED_COPY_WAIT_MS).
    const copying = job.late.some((u) => isCopyPending(u));
    const deadline = (job.startedAt ?? now()) + (copying ? LATE_EMBED_COPY_WAIT_MS : LATE_EMBED_WAIT_MS);
    const finals = await Promise.all(job.late.map((u) => deps.awaitFinal(u, deadline)));
    const better = finals.filter((p): p is PreparedEmbed => !!p && improvesOn(job.sent.find((e) => e.url === p.url), p));
    if (better.length === 0) return 'nothing-better';
    const withCopy = better.some((p) => !!p.copy);
    const built = await deps.finalize(job.text, better, job.upload, LATE_EMBED_UPLOAD_MS, withCopy ? LATE_EMBED_COPY_UPLOAD_MS : LATE_EMBED_UPLOAD_MS);
    if (built.length === 0) return 'nothing-better';
    // A copy that still did not make it is no improvement on its own.
    if (withCopy && !better.some((p) => !p.copy || built.find((e) => e.url === p.url)?.media?.file)) return 'nothing-better';
    const embeds = mergeLateEmbeds(job.text, job.sent, built);
    // A channel edit names the server's id for the row: wait for the delivery to land.
    let row = deps.findRow();
    const until = deadline + (withCopy ? LATE_EMBED_COPY_UPLOAD_MS : LATE_EMBED_UPLOAD_MS);
    while (row && row.send_state === 'sending' && now() < until) {
        await sleep(250);
        row = deps.findRow();
    }
    if (!row) return 'moved-on';
    if (row.send_state === 'sending' || row.send_state === 'failed') return 'undelivered';
    if (!unchangedSinceSend(row.content, job.text, job.sent)) return 'changed';
    const c = row.content as { channel_refs?: unknown };
    await deps.send({
        type: 'edit', target_id: row.id, text: job.text,
        ...(Array.isArray(c.channel_refs) && c.channel_refs.length > 0 ? { channel_refs: c.channel_refs as ChannelRef[] } : {}),
        ...fontField(messageFontOf(row.content)), ...sizeField(messageSizeOf(row.content)),
        embeds, embeds_only: true,
    });
    return 'attached';
}
