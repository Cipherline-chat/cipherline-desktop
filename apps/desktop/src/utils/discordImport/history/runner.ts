/**
 * Posts a Discord server's recent history into the Cipherline server the
 * structure import just built (Discord import phase 2; plan B4, B5, B6.1).
 *
 * Per channel:
 *   1. read the window + pins from Discord (main process, the user's own bot);
 *   2. register the channel's authors with the API (it keeps a keyed hash of
 *      each Discord id, never the id; we get one opaque `author_ref` each);
 *   3. per author, the avatar once: an ordinary encrypted upload in this channel;
 *   4. per message, its files (encrypted here, exactly like a normal upload)
 *      and its rows: the words as a `text` row, then one `attachment` row per
 *      file, each carrying an `imported_from` block (name, avatar, original
 *      time) INSIDE the encrypted content;
 *   5. every row encrypted with the channel's normal sender key and signed by
 *      THIS device (`sealRow`, the same path as a normal send), then posted in
 *      ordered, idempotent batches of up to 100 (`seq`);
 *   6. the source app's pins: server-saved and pinned in one quota transaction,
 *      newest pin first so the newest are kept if the storage quota runs out.
 *
 * The server never sees plaintext, names or avatars. Everything external is
 * injected, so this is tested without Electron, a network or the API.
 */
import {
    IMPORT_BATCH_MAX_ROWS, IMPORT_CAPS, IMPORT_CONSENT_VERSION, IMPORTED_REACTIONS_MAX, IMPORTED_REACTORS_MAX,
    parseImportedReactions, stickerFallbackText, stickerPayloadProblem, type ImportedFrom, type ImportedReaction, type StickerPayload,
} from '@cipherline/shared';
import { retryAfterMs } from '../../emojiBulk/batch';
import type { ChannelHistory, ImportMessage } from '../types';
import { importedMessageText, postingOrder, sizeLabel, type ConvertContext, type ConvertSink } from './convert';
import { importedLinkEmbeds } from './linkEmbeds';
import { reencodeThumb, type EncodedThumb } from '../../linkEmbeds/thumb';

/** Request bodies stay under the API's 1 MiB batch limit with room to spare. */
export const BATCH_BYTES_SOFT_LIMIT = 900 * 1024;
const MAX_POST_ATTEMPTS = 4;
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface SealedRow { epoch: number; nonce_b64: string; ciphertext_b64: string; signature_b64: string; commitment_b64?: string }
export interface EncryptedFile { blob: Blob; keyB64: string; nonceB64: string; sha256B64: string | null }

export interface HistoryApi {
    createSession(body: {
        source: 'discord'; consent_version: string; channel_ids: string[]; declared_rows: number; declared_attachment_bytes: number;
        /** Which Discord channel each target is copied from, as an opaque source key (stored only as a keyed hash). */
        channel_sources?: Array<{ channel_id: string; source_key: string }>;
    }): Promise<{ id: string }>;
    registerAuthors(importId: string, authors: Array<{ discord_user_id: string; kind: 'user' | 'webhook' | 'app' }>): Promise<{ author_ids: string[] }>;
    postBatch(importId: string, body: { channel_id: string; sender_device_id: string; epoch: number; seq_start: number; rows: Array<Record<string, unknown>> }): Promise<{ ids: string[]; seq_next: number }>;
    initiateFiles(importId: string, channelId: string, files: Array<{ size_bytes: number; mime_type: string }>): Promise<Array<{ attachment_id: string; upload_url: string } | { error: { code: string; message: string } }>>;
    save(importId: string, body: { channel_id: string; pin: boolean; items: Array<{ message_id: string; attachment_ids: string[] }> }): Promise<{ results: Array<{ message_id: string; status: string }>; used_bytes: number | null; limit_bytes: number | null }>;
    complete(importId: string): Promise<unknown>;
}

export interface HistoryDeps {
    api: HistoryApi;
    readChannel(channel: number): Promise<ChannelHistory>;
    fetchMedia(ref: string): Promise<{ ok: true; mime: string; bytes: Uint8Array } | { ok: false; code: string; message: string }>;
    encryptFile(bytes: Uint8Array, mime: string): Promise<EncryptedFile>;
    upload(url: string, blob: Blob, mime: string, signal: AbortSignal): Promise<void>;
    /** Encrypt + sign one content JSON for a channel, exactly like a normal send (franking included). */
    sealRow(contentJson: string, channelId: string): Promise<SealedRow>;
    deviceId: string;
    /** The importer's per-file upload limit (getEntitlements().maxUploadBytes). */
    maxFileBytes: number;
    newId?(): string;
    /** Test seam: the link-preview picture re-encode (default: utils/linkEmbeds/thumb reencodeThumb, a browser canvas). */
    reencodeThumb?(bytes: Uint8Array): Promise<EncodedThumb | null>;
    sleep?(ms: number): Promise<void>;
}

export interface HistoryChannelInput { channel: number; channelId: string; name: string }

/** Where a channel's copy stopped: labels and numbers only (the report's plain words live in `error`). */
export type ImportStep = 'session' | 'read' | 'probe' | 'pins_read' | 'reactions' | 'authors' | 'avatars' | 'files' | 'post' | 'pins';
export interface ImportFailureInfo {
    step: ImportStep | string;
    /** Our code ('history_hidden', 'discord_down', 'internal', 'IMPORT_CAP_REACHED', 'http'…). */
    code: string;
    /** HTTP status (Discord's for a read, Cipherline's for a post), when there was one. */
    status?: number;
    /** The error class (TypeError…) or the Discord error kind (discord_server…). */
    errorName?: string;
}

/** Why one file of a message was left out (the message itself still came over, with a line saying so). */
export type FileSkipCode = 'too_large' | 'expired' | 'download_failed' | 'unsupported' | 'refused' | 'upload_failed' | 'other';
export interface FileSkip { filename: string; reason: string; code?: FileSkipCode; size?: number }

/**
 * A channel read that failed (thrown by the host's `readChannel`), carrying where and why for the report and
 * the beta diagnostics event.
 */
export class ChannelReadError extends Error {
    readonly info: ImportFailureInfo;
    constructor(message: string, info: ImportFailureInfo) { super(message); this.name = 'ChannelReadError'; this.info = info; }
}

/** fetchMedia's failure code (main's IPC codes) -> why the file was left out. */
export function fileSkipCodeOf(code: string | undefined): FileSkipCode {
    switch (code) {
        case 'too_large': return 'too_large';
        case 'not_found': return 'expired';
        case 'discord_down': case 'network': case 'timeout': case 'rate_limited': case 'invalid_response': return 'download_failed';
        case 'bad_request': return 'unsupported';
        default: return 'other';
    }
}

/** The placeholder line's reason, in plain words. */
export function fileSkipWords(code: FileSkipCode, limitBytes: number): string {
    switch (code) {
        case 'too_large': return `too large to copy, the limit is ${sizeLabel(limitBytes)}`;
        case 'expired': return 'Discord no longer has it';
        case 'download_failed': return 'the download from Discord failed';
        case 'unsupported': return 'Discord gave an address Cipherline can’t download from';
        case 'refused': return 'Cipherline refused the upload';
        case 'upload_failed': return 'the upload failed';
        default: return 'it could not be copied';
    }
}

/** "File couldn’t be copied: holiday.mp4 · 612.0 MB (too large to copy…)": the line the message carries instead. */
export function filePlaceholder(filename: string, size: number, why: string): string {
    return `File couldn’t be copied: ${filename}${size > 0 ? ` · ${sizeLabel(size)}` : ''} (${why})`;
}

export interface ChannelReport {
    channelId: string;
    name: string;
    messages: number;
    rows: number;
    filesImported: number;
    /** Files left out one by one; each message still came over, with a "File couldn’t be copied" line. */
    filesSkipped: FileSkip[];
    pinsSaved: number;
    pinsNoRoom: number;
    truncated: boolean;
    /** The channel had more than the 25,000-message ceiling in its window. */
    ceilingHit: boolean;
    /** Link previews Discord had made that came over as previews (link embeds phase 4). */
    linkPreviews?: number;
    /** Reactions with a custom emoji this server does not have (left out). */
    reactionsSkipped: number;
    /**
     * Why the channel did not (fully) come over, null when it did. A channel with
     * an error is a FAILED channel in the report, never a success line; when
     * `rows` is 0 nothing of it was posted and it can be retried in place.
     */
    error: string | null;
    /** Where / why it failed (labels only), for the issues list and the beta diagnostics event. */
    failure?: ImportFailureInfo;
    /** Messages Discord sent that could not be read (left out by the read). */
    unreadable?: number;
    /** Discord stopped answering partway through the read: only the newest messages came over. */
    partial?: boolean;
    /** Messages left out one by one (the rest of the channel still came over), with the first reason. */
    messagesSkipped?: number;
    skipReason?: string;
    /** What the read could not get (pins, who reacted), said in the report. */
    notes?: string[];
    /** Every row posted, for the post-import "save all" (message id, its files, approximate bytes). */
    savable: Array<{ message_id: string; attachment_ids: string[]; bytes: number }>;
    /** Sticker rows posted that point at an imported server sticker. */
    stickers?: number;
    /** Lottie stickers left as a text line (no picture exists). */
    stickersSkipped?: number;
}

export interface HistoryProgress { channelIndex: number; channels: number; channelName: string; phase: 'reading' | 'files' | 'posting' | 'pins' | 'done'; done: number; total: number }

/**
 * `completed`: the session was closed (POST .../complete). It is NOT closed while
 * a channel failed with nothing posted, so "Retry" can still post into it; the
 * wizard closes it when the person moves on (completeHistoryImport).
 */
export interface HistoryState { importId?: string; channelsDone: Set<string>; reports: ChannelReport[]; completed?: boolean }
export const newHistoryState = (): HistoryState => ({ channelsDone: new Set(), reports: [] });

export class HistoryAborted extends Error { constructor() { super('Cancelled'); } }

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function apiMessage(err: unknown): string {
    const e = err as { response?: { data?: { message?: unknown } }; message?: string } | null;
    const m = e?.response?.data?.message;
    return (Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '') || e?.message || 'Something went wrong';
}
const httpStatus = (err: unknown): number | undefined =>
    (err as { response?: { status?: number } } | null)?.response?.status;

/** A channel that failed with nothing posted: the wizard offers to retry it into the same session. */
export const retryableChannel = (r: ChannelReport): boolean => r.error !== null && r.rows === 0;

/** Close the session (idempotent on the server; a no-op once closed). */
export async function completeHistoryImport(api: Pick<HistoryApi, 'complete'>, state: HistoryState): Promise<void> {
    if (!state.importId || state.completed) return;
    await api.complete(state.importId);
    state.completed = true;
}

const apiCode = (err: unknown): string | undefined =>
    (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code as string | undefined;

/** Where / why a channel failed, from whatever was thrown at `step`. Labels only. */
export function failureOf(err: unknown, step: ImportStep): ImportFailureInfo {
    if (err instanceof ChannelReadError) return err.info;
    const code = apiCode(err);
    const status = httpStatus(err);
    const name = (err as { name?: unknown } | null)?.name;
    return {
        step,
        code: typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : status !== undefined ? 'http' : 'error',
        ...(status !== undefined ? { status } : {}),
        ...(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? { errorName: name } : {}),
    };
}

/** One row ready to post, plus what the runner needs to remember about it. */
/** One sealed row of a message, before it joins a batch. */
interface SealedMessageRow { body: Record<string, unknown>; epoch: number; bytes: number; extra: number; atts: string[] }
interface PendingRow { body: Record<string, unknown>; epoch: number; bytes: number; discordId: string; first: boolean; attachmentIds: string[] }

/**
 * A Discord message's reactions as the `imported_from.reactions` block: this
 * server's emoji token for a custom emoji the structure import brought over
 * (by name, as message text does), unicode as is. A custom emoji this server
 * does not have (another server's, or emojis were not imported) is LEFT OUT
 * and counted in `skipped`: a reaction pill holds one glyph, and ":name:"
 * text in it overflows onto its neighbours (seen in the real-app check). Reactors by their opaque author ref + Discord name. Validated with
 * the SAME strict parser readers use, so a block a reader would refuse (and
 * which would make the whole row render as the importer) is never posted.
 */
export function importedReactions(
    m: ImportMessage, refOf: Map<string, string>, ctx: Pick<ConvertContext, 'emojiIds'>, skipped?: { n: number },
): ImportedReaction[] {
    const out: ImportedReaction[] = [];
    const seen = new Set<string>();
    for (const r of (m.reactions ?? []).slice(0, IMPORTED_REACTIONS_MAX)) {
        const local = r.emoji.id ? ctx.emojiIds?.[r.emoji.name.toLowerCase()] : undefined;
        if (r.emoji.id && !local) { if (skipped) skipped.n++; continue; }
        const emoji = r.emoji.id ? `<:${r.emoji.name}:${local}>` : r.emoji.name;
        if (seen.has(emoji)) continue;
        const reactors = r.users
            .filter(u => refOf.has(u.id))
            .slice(0, IMPORTED_REACTORS_MAX)
            .map(u => ({ ref: refOf.get(u.id)!, name: u.name }));
        const one = parseImportedReactions([{ emoji, count: Math.max(r.count, reactors.length), reactors }]);
        if (!one || one.length !== 1) continue;
        seen.add(emoji);
        out.push(one[0]);
    }
    return out;
}

export async function runHistoryImport(
    deps: HistoryDeps,
    input: {
        serverId: string; channels: HistoryChannelInput[]; roleRefs?: Record<string, string>; channelRefs?: Record<string, string>;
        /** Cipherline channel id -> the source key of the Discord channel it is filled from (the API's no-duplicates rule). */
        channelSources?: Record<string, string>;
        convert: Omit<ConvertContext, 'roles' | 'channels'>;
    },
    state: HistoryState,
    onProgress: (p: HistoryProgress) => void,
    signal: AbortSignal,
): Promise<HistoryState> {
    const sleep = deps.sleep ?? realSleep;
    const newId = deps.newId ?? (() => crypto.randomUUID());
    const check = () => { if (signal.aborted) throw new HistoryAborted(); };

    // One API call with a 429 wait, the way every other paced bulk path does it.
    async function call<T>(fn: () => Promise<T>): Promise<T> {
        for (let i = 0; ; i++) {
            check();
            try { return await fn(); } catch (err) {
                const wait = retryAfterMs(err);
                if (wait !== null && i < 5) { await sleep(wait); continue; }
                throw err;
            }
        }
    }

    if (!state.importId) {
        const ids = input.channels.map(c => c.channelId);
        const sources = ids.filter(id => input.channelSources?.[id]).map(id => ({ channel_id: id, source_key: input.channelSources![id] }));
        const body = {
            source: 'discord' as const, consent_version: IMPORT_CONSENT_VERSION, channel_ids: ids,
            declared_rows: Math.min(IMPORT_CAPS.rowsPerImport, ids.length * IMPORT_CAPS.rowsPerChannel),
            declared_attachment_bytes: 0,
        };
        let s: { id: string };
        try {
            s = await call(() => deps.api.createSession(sources.length ? { ...body, channel_sources: sources } : body));
        } catch (err) {
            // An API older than channel sources refuses the unknown field (400, whitelist): import without them.
            if (!sources.length || httpStatus(err) !== 400 || !/channel_sources/.test(apiMessage(err))) throw err;
            s = await call(() => deps.api.createSession(body));
        }
        state.importId = s.id;
    }
    const importId = state.importId;

    for (let ci = 0; ci < input.channels.length; ci++) {
        const ch = input.channels[ci];
        if (state.channelsDone.has(ch.channelId)) continue;
        check();
        // A retry replaces the channel's earlier (failed) report.
        state.reports = state.reports.filter(r => r.channelId !== ch.channelId);
        const report: ChannelReport = {
            channelId: ch.channelId, name: ch.name, messages: 0, rows: 0, filesImported: 0, filesSkipped: [],
            pinsSaved: 0, pinsNoRoom: 0, truncated: false, ceilingHit: false, reactionsSkipped: 0, error: null, savable: [],
        };
        const progress = (phase: HistoryProgress['phase'], done: number, total: number) =>
            onProgress({ channelIndex: ci, channels: input.channels.length, channelName: ch.name, phase, done, total });
        let step: ImportStep = 'read';
        try {
            progress('reading', 0, 1);
            const hist = await deps.readChannel(ch.channel);
            report.truncated = hist.truncated;
            report.ceilingHit = hist.ceilingHit === true;
            if (hist.notes?.length) report.notes = [...hist.notes];
            if (typeof hist.unreadable === 'number' && hist.unreadable > 0) report.unreadable = hist.unreadable;
            if (hist.partial) report.partial = true;
            step = 'authors';
            const ordered = postingOrder(hist.messages, hist.pins);
            // Discord role / channel id -> the Cipherline one the structure import created.
            const roleIds: Record<string, string> = {};
            for (const [did, num] of Object.entries(hist.names.roleNums ?? {})) { const id = input.roleRefs?.[`r:${num}`]; if (id && num > 0) roleIds[did] = id; }
            const channelIds: Record<string, string> = {};
            for (const [did, num] of Object.entries(hist.names.channelNums ?? {})) { const id = input.channelRefs?.[`c:${num}`]; if (id) channelIds[did] = id; }
            const ctx: ConvertContext = { roles: hist.names.roles, channels: hist.names.channels, roleIds, channelIds, ...input.convert };

            // ── Authors (keyed hash on the server; opaque refs back) ──
            // Reactors are registered the same way (they are imported people
            // too: claimable, D27), but get no avatar upload.
            const authors = new Map<string, ImportMessage['author']>();
            for (const m of ordered) if (!authors.has(m.author.id)) authors.set(m.author.id, m.author);
            const reactorOnly = new Map<string, { id: string; kind: 'user' | 'app' }>();
            for (const m of ordered) for (const r of m.reactions ?? []) for (const u of r.users) {
                if (!authors.has(u.id) && !reactorOnly.has(u.id)) reactorOnly.set(u.id, { id: u.id, kind: u.kind });
            }
            const refOf = new Map<string, string>();
            const list = [...authors.values()];
            const toRegister: Array<{ id: string; kind: 'user' | 'webhook' | 'app' }> = [...list, ...reactorOnly.values()];
            for (let i = 0; i < toRegister.length; i += 500) {
                const chunk = toRegister.slice(i, i + 500);
                const r = await call(() => deps.api.registerAuthors(importId, chunk.map(a => ({ discord_user_id: a.id, kind: a.kind }))));
                chunk.forEach((a, k) => refOf.set(a.id, r.author_ids[k]));
            }

            // ── Files: avatars once per author, then each message's files ──
            const uploadOne = async (bytes: Uint8Array, mime: string) => {
                const enc = await deps.encryptFile(bytes, mime);
                const [slot] = await call(() => deps.api.initiateFiles(importId, ch.channelId, [{ size_bytes: enc.blob.size, mime_type: mime }]));
                if (!slot || 'error' in slot) throw Object.assign(new Error(slot && 'error' in slot ? slot.error.message : 'refused'), { refused: true });
                await deps.upload(slot.upload_url, enc.blob, mime, signal);
                return { attachmentId: slot.attachment_id, enc };
            };
            const avatars = new Map<string, NonNullable<ImportedFrom['avatar']>>();
            step = 'avatars';
            let ai = 0;
            for (const a of list) {
                progress('files', ai++, list.length);
                if (!a.avatarRef) continue;
                try {
                    const got = await deps.fetchMedia(a.avatarRef);
                    if (!got.ok || !AVATAR_MIMES.has(got.mime)) continue;
                    const up = await uploadOne(got.bytes, got.mime);
                    avatars.set(a.id, { attachment_id: up.attachmentId, file_key_b64: up.enc.keyB64, file_nonce_b64: up.enc.nonceB64, mime: got.mime as NonNullable<ImportedFrom['avatar']>['mime'] });
                } catch (err) { if (signal.aborted) throw new HistoryAborted(); /* initials avatar instead */ void err; }
            }

            // ── Rows ──
            const firstRowId = new Map<string, string>(); // Discord message id -> Cipherline id of its first row
            const pinnedRows = new Map<string, Array<{ message_id: string; attachment_ids: string[] }>>();
            let pending: PendingRow[] = [];
            let pendingBytes = 0;
            let seq = 0;
            const inBatch = new Set<string>();

            // Discord messages with at least one row the SERVER accepted: the report counts these.
            const postedMessages = new Set<string>();
            const skip = (why: string) => { report.messagesSkipped = (report.messagesSkipped ?? 0) + 1; report.skipReason ??= why; };
            // Single rows the server refused since it last accepted one: 3 in a row means
            // the refusal is about the channel, not a row (no request storm, a real failure).
            let refusedInARow = 0;
            const postRows = async (rows: PendingRow[]): Promise<void> => {
                let attempt = 0;
                for (;;) {
                    check();
                    try {
                        const res = await call(() => deps.api.postBatch(importId, {
                            channel_id: ch.channelId, sender_device_id: deps.deviceId, epoch: rows[0].epoch,
                            seq_start: seq, rows: rows.map(r => r.body),
                        }));
                        seq = res.seq_next;
                        res.ids.forEach((id, k) => {
                            const r = rows[k];
                            if (!r) return;
                            if (r.first) firstRowId.set(r.discordId, id);
                            postedMessages.add(r.discordId);
                            report.savable.push({ message_id: id, attachment_ids: r.attachmentIds, bytes: r.bytes });
                            if (pinnedRows.has(r.discordId)) pinnedRows.get(r.discordId)!.push({ message_id: id, attachment_ids: r.attachmentIds });
                        });
                        report.rows += res.ids.length;
                        report.messages = postedMessages.size;
                        refusedInARow = 0;
                        return;
                    } catch (err) {
                        // A lost answer: the same seq replays and returns the stored ids.
                        const status = httpStatus(err);
                        if (signal.aborted) throw new HistoryAborted();
                        if ((status === undefined || status >= 500) && ++attempt < MAX_POST_ATTEMPTS) { await sleep(1000 * attempt); continue; }
                        // The server refused a row of the batch (all or nothing): find it by
                        // halving, post the rest, leave that one message out and count it.
                        if (status === 400) {
                            if (rows.length > 1) {
                                const half = Math.ceil(rows.length / 2);
                                await postRows(rows.slice(0, half));
                                await postRows(rows.slice(half));
                                return;
                            }
                            if (++refusedInARow >= 3) throw err;
                            skip(apiMessage(err));
                            return;
                        }
                        throw err;
                    }
                }
            };
            const flush = async () => {
                if (pending.length === 0) return;
                const rows = pending;
                pending = []; pendingBytes = 0; inBatch.clear();
                await postRows(rows);
            };

            const skippedReactions = { n: 0 };
            step = 'post';
            const pinIds = new Set(hist.pins.map(p => p.id));
            let mi = 0;
            /**
             * One Discord message -> its sealed rows (files uploaded first). Anything
             * that throws in here costs THAT message only: it is left out and counted
             * (messagesSkipped), never the rest of the channel.
             */
            const prepareMessage = async (m: ImportMessage, author: string, parentId: string | null): Promise<SealedMessageRow[]> => {
                const imported: ImportedFrom = {
                    v: 1, source: 'discord', author_ref: author, kind: m.author.kind, name: m.author.name,
                    ...(m.author.username ? { username: m.author.username } : {}),
                    ...(avatars.has(m.author.id) ? { avatar: avatars.get(m.author.id)! } : {}),
                    original_ts: m.ts,
                    ...(m.edited ? { edited: true as const } : {}),
                };
                const notes: string[] = [];
                // Stickers (plan: owner 2026-11-22). A sticker of THIS guild that the
                // structure import made a server sticker becomes a real sticker row (a
                // `text` row with `sticker`, packages/shared/stickers.ts) pointing at it;
                // any other picture sticker (Discord's own, another server's) rides as an
                // image attachment; a Lottie one stays the "-# Sticker: name" line.
                const stickerRows: Array<Record<string, unknown>> = [];
                const stickerFiles: typeof m.files = [];
                const handledStickers = new Set<string>();
                for (const it of m.stickerItems ?? []) {
                    const made = ctx.stickerRefs?.[it.id];
                    if (made) {
                        const sticker: StickerPayload = { source: 'server', id: made.id, server_id: input.serverId, name: made.name };
                        if (!stickerPayloadProblem(sticker)) {
                            stickerRows.push({ type: 'text', text: stickerFallbackText(made.name), sticker });
                            handledStickers.add(it.name);
                            report.stickers = (report.stickers ?? 0) + 1;
                            continue;
                        }
                    }
                    if (it.ref) {
                        stickerFiles.push({ ref: it.ref, filename: `${it.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'sticker'}.${it.format === 4 ? 'gif' : 'png'}`, size: 0, mime: 'application/octet-stream', voice: false });
                        handledStickers.add(it.name);
                    } else {
                        report.stickersSkipped = (report.stickersSkipped ?? 0) + 1;
                    }
                }
                const fileRows: Array<Record<string, unknown>> = [];
                const fileIds: string[][] = [];
                const fileBytes: number[] = [];
                for (const f of [...m.files, ...stickerFiles]) {
                    // Voice messages ride as ordinary audio attachments (decision in the worklog).
                    const limit = Math.min(deps.maxFileBytes, 100 * 1024 * 1024);
                    // Left out: counted in the report, and the message carries a line saying which file is missing
                    // (an embed's picture gets no line: its link is in the text). Never the message or the channel.
                    const leaveOut = (code: FileSkipCode, size = f.size) => {
                        const why = fileSkipWords(code, limit);
                        report.filesSkipped.push({ filename: f.filename, reason: why, code, ...(size > 0 ? { size } : {}) });
                        if (!f.embedImage) notes.push(filePlaceholder(f.filename, size, why));
                    };
                    if (f.size > limit) { leaveOut('too_large'); continue; }
                    if (!f.ref) { leaveOut('unsupported'); continue; }
                    let got: Awaited<ReturnType<HistoryDeps['fetchMedia']>>;
                    try {
                        progress('files', mi, ordered.length);
                        got = await deps.fetchMedia(f.ref);
                    } catch (err) {
                        if (signal.aborted) throw new HistoryAborted();
                        void err;
                        leaveOut('download_failed');
                        continue;
                    }
                    if (!got.ok) { leaveOut(fileSkipCodeOf(got.code)); continue; }
                    // The real size can exceed what Discord declared (or it declared none).
                    if (got.bytes.length > limit) { leaveOut('too_large', got.bytes.length); continue; }
                    try {
                        const up = await uploadOne(got.bytes, got.mime);
                        fileRows.push({
                            type: 'attachment', attachment_id: up.attachmentId, filename: f.voice && !/\.[A-Za-z0-9]{2,5}$/.test(f.filename) ? `${f.filename}.ogg` : f.filename, byte_size: got.bytes.length,
                            mime: got.mime, file_key_b64: up.enc.keyB64, file_nonce_b64: up.enc.nonceB64, enc_alg: 'aes256gcm', chunk_size: 0,
                            ...(up.enc.sha256B64 ? { content_sha256_b64: up.enc.sha256B64 } : {}),
                        });
                        fileIds.push([up.attachmentId]);
                        fileBytes.push(up.enc.blob.size);
                        report.filesImported++;
                    } catch (err) {
                        if (signal.aborted || err instanceof HistoryAborted) throw new HistoryAborted();
                        leaveOut((err as { refused?: boolean } | null)?.refused ? 'refused' : 'upload_failed', got.bytes.length);
                    }
                }
                let sink: ConvertSink = { mentions: [], channelRefs: [] };
                const shown = handledStickers.size ? { ...m, stickers: m.stickers.filter(n => !handledStickers.has(n)) } : m;
                let text = importedMessageText(shown, ctx, notes, !!m.replyTo && !parentId, sink);
                // Discord's previews of the links become the row's link previews (linkEmbeds.ts); one that
                // cannot be tied to a link in the text is written as quoted text, as before.
                const previews = m.linkEmbeds?.length ? await importedLinkEmbeds(m.linkEmbeds, text, {
                    fetchMedia: (ref) => deps.fetchMedia(ref),
                    reencode: deps.reencodeThumb ?? reencodeThumb,
                    upload: async (bytes, mime) => { const up = await uploadOne(bytes, mime); return { attachmentId: up.attachmentId, keyB64: up.enc.keyB64, nonceB64: up.enc.nonceB64, storedBytes: up.enc.blob.size }; },
                }) : null;
                if (signal.aborted) throw new HistoryAborted();
                if (previews?.unmapped.length) {
                    sink = { mentions: [], channelRefs: [] };
                    const asQuotes = previews.unmapped.map(e => ({ title: e.title, description: e.description, url: e.url, fields: [], author: e.author, footer: null }));
                    text = importedMessageText({ ...shown, embeds: [...shown.embeds, ...asQuotes] }, ctx, notes, !!m.replyTo && !parentId, sink);
                }
                if (previews?.embeds.length) report.linkPreviews = (report.linkPreviews ?? 0) + previews.embeds.length;
                const contents: Array<{ c: Record<string, unknown>; atts: string[]; extra: number }> = [];
                if (text.trim()) {
                    contents.push({
                        c: {
                            type: 'text', text, ...(parentId ? { reply_to_id: parentId } : {}), ...(sink.mentions.length ? { mentions: sink.mentions } : {}), ...(sink.channelRefs.length ? { channel_refs: sink.channelRefs } : {}),
                            ...(previews?.embeds.length ? { embeds: previews.embeds } : {}),
                        },
                        atts: previews?.attachmentIds ?? [], extra: previews?.storedBytes ?? 0,
                    });
                }
                // A sticker row right after the words (its own message in Cipherline), the
                // reply link on the first row only, as for files.
                stickerRows.forEach((c) => contents.push({ c: { ...c, ...(contents.length === 0 && parentId ? { reply_to_id: parentId } : {}) }, atts: [], extra: 0 }));
                fileRows.forEach((c, k) => contents.push({ c, atts: fileIds[k], extra: fileBytes[k] }));
                if (contents.length === 0) return [];
                const avatarId = avatars.get(m.author.id)?.attachment_id;
                const reactions = importedReactions(m, refOf, ctx, skippedReactions);
                const out: SealedMessageRow[] = [];
                for (let k = 0; k < contents.length; k++) {
                    // Reactions ride on the message's FIRST row only (a message with files is several rows).
                    const block: ImportedFrom = k === 0 && reactions.length ? { ...imported, reactions } : imported;
                    const content = { client_msg_id: newId(), ...contents[k].c, imported_from: block };
                    const sealed = await deps.sealRow(JSON.stringify(content), ch.channelId);
                    const body: Record<string, unknown> = {
                        ciphertext_b64: sealed.ciphertext_b64, nonce_b64: sealed.nonce_b64, signature_b64: sealed.signature_b64,
                        author_ref: author,
                        ...(sealed.commitment_b64 ? { franking_commitment_b64: sealed.commitment_b64 } : {}),
                        ...(k === 0 && parentId ? { reply_to_id: parentId } : {}),
                    };
                    const bytes = sealed.ciphertext_b64.length + sealed.nonce_b64.length + sealed.signature_b64.length + 200;
                    out.push({ body, epoch: sealed.epoch, bytes, extra: contents[k].extra, atts: [...contents[k].atts, ...(avatarId ? [avatarId] : [])] });
                }
                return out;
            };
            for (const m of ordered) {
                check();
                progress('posting', mi++, ordered.length);
                if (pinIds.has(m.id)) pinnedRows.set(m.id, []);
                const author = refOf.get(m.author.id);
                if (!author) continue;
                // A reply to a message in the unsent batch: send that batch first, so the parent has an id.
                if (m.replyTo && inBatch.has(m.replyTo)) await flush();
                const parentId = m.replyTo ? firstRowId.get(m.replyTo) ?? null : null;
                let sealedRows: SealedMessageRow[];
                try {
                    sealedRows = await prepareMessage(m, author, parentId);
                } catch (err) {
                    if (err instanceof HistoryAborted || signal.aborted) throw new HistoryAborted();
                    skip((err as Error)?.message || 'could not be copied');
                    continue;
                }
                for (let k = 0; k < sealedRows.length; k++) {
                    const r = sealedRows[k];
                    if (pending.length >= IMPORT_BATCH_MAX_ROWS || pendingBytes + r.bytes > BATCH_BYTES_SOFT_LIMIT || (pending.length && pending[0].epoch !== r.epoch)) {
                        await flush();
                    }
                    pending.push({ body: r.body, epoch: r.epoch, bytes: r.bytes + r.extra, discordId: m.id, first: k === 0, attachmentIds: r.atts });
                    pendingBytes += r.bytes;
                    inBatch.add(m.id);
                }
            }
            await flush();
            report.reactionsSkipped = skippedReactions.n;
            // Every message left out one by one is a failed channel, not "0 messages".
            if (report.rows === 0 && (report.messagesSkipped ?? 0) > 0) {
                throw new ChannelReadError(`None of its messages could be copied (${report.skipReason ?? 'unknown reason'}).`, { step: 'post', code: 'all_messages_skipped' });
            }

            // ── Pins: saved + pinned, newest pin first (D20: newest kept if storage runs out) ──
            const items = hist.pins.flatMap(p => pinnedRows.get(p.id) ?? []);
            step = 'pins';
            progress('pins', 0, items.length);
            const status = new Map<string, string>();
            for (let i = 0; i < items.length; i += 500) {
                const r = await call(() => deps.api.save(importId, { channel_id: ch.channelId, pin: true, items: items.slice(i, i + 500) }));
                for (const x of r.results) status.set(x.message_id, x.status);
            }
            // Rows saved here are no longer candidates for the popup's "Save all".
            const nowSaved = new Set([...status].filter(([, st]) => st === 'pinned' || st === 'saved' || st === 'already').map(([id]) => id));
            report.savable = report.savable.filter(r => !nowSaved.has(r.message_id));
            // Count Discord pins, not rows (a pin with a file is two rows).
            for (const p of hist.pins) {
                const rows = pinnedRows.get(p.id) ?? [];
                if (rows.length === 0) continue;
                const st = rows.map(r => status.get(r.message_id));
                if (st.every(x => x === 'pinned' || x === 'saved' || x === 'already')) report.pinsSaved++;
                else if (st.some(x => x === 'no_room')) report.pinsNoRoom++;
            }
            progress('done', 1, 1);
            state.channelsDone.add(ch.channelId);
        } catch (err) {
            if (err instanceof HistoryAborted || signal.aborted) { state.reports.push(report); throw new HistoryAborted(); }
            report.error = apiCode(err) === 'IMPORT_CAP_REACHED' ? 'This import reached its size limit.' : apiMessage(err);
            report.failure = failureOf(err, step);
        }
        state.reports.push(report);
    }

    // A channel that failed with nothing posted keeps the session open so the
    // wizard's "Retry" can post into it; the wizard closes it when the person moves on.
    if (!state.reports.some(retryableChannel)) await call(() => completeHistoryImport(deps.api, state));
    return state;
}
