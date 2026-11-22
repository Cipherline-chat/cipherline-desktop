/**
 * The Discord import as an APP-LEVEL job (owner 2026-11-22: "can we make it so
 * you can do other stuff while servers are importing").
 *
 * The wizard (components/server/DiscordGuildImport.tsx) only collects the
 * choices; once the admin presses "Import server" the run lives HERE, in a
 * module-level store, not in the modal's component tree. Closing or
 * minimising the wizard therefore never stops, restarts or duplicates the
 * import, and the progress / report view (DiscordImportProgressView) can be
 * mounted again later (the floating progress pill, the "Import finished"
 * toast) and picks up the very same job.
 *
 * Rules:
 *   - ONE import at a time: `startImportJob` refuses while one runs;
 *   - progress reaches subscribers at most every PROGRESS_EMIT_MS (the history
 *     runner reports every message; a re-render per message while the user
 *     chats would be wasted main-thread work), phase changes at once;
 *   - main is told while an import runs (`setRunning`), so quitting asks first
 *     (electron/discord-import/quit-guard.ts);
 *   - signing out (the Dashboard unmounting) aborts it: the job holds that
 *     account's token and keys.
 *
 * Pure of React (a tiny external store; `useImportJob` is the hook) so it is
 * unit-tested without a DOM.
 */
import { useSyncExternalStore } from 'react';
import {
    ImportAborted, newRunState, runStructureImport,
    type Progress, type RunReport, type RunnerDeps, type RunState,
} from './runner';
import {
    ChannelReadError, HistoryAborted, completeHistoryImport, newHistoryState, retryableChannel, runHistoryImport,
    type ChannelReport, type HistoryProgress, type HistoryState,
} from './history/runner';
import { reportImportDiagnostics } from './importDiagnostics';
import { clearImportSessionMarker, markImportSessionOpen, readImportSessionMarker } from './sessionMarker';
import { secureLocalStore } from '../secureLocalStore';
import { guildImportErrorMessage } from './steps';
import type { DiscordHistoryHost } from './history/host';
import type { DiscordImportApi, GuildImportRequest, GuildImportResponse, GuildSnapshot } from './types';
import type { EncryptedUpload } from './runner';

/** Everything that talks to Cipherline for the structure part (DiscordGuildImportHost minus preview). */
export interface ImportJobHost {
    importGuild(req: GuildImportRequest): Promise<GuildImportResponse>;
    listEmojiNames(serverId: string): Promise<string[]>;
    createEmoji(serverId: string, body: { name: string; attachment_id: string; key_b64: string; nonce_b64: string }): Promise<void>;
    upload(blob: Blob, mime: string, opts?: { serverId?: string; signal?: AbortSignal }): Promise<EncryptedUpload>;
    setRoleIcon?(serverId: string, roleId: string, blob: Blob, mime: string, signal?: AbortSignal): Promise<void>;
    createSticker?: RunnerDeps['createSticker'];
}

export interface ImportJobInput {
    api: DiscordImportApi;
    host: ImportJobHost;
    history?: DiscordHistoryHost;
    guildId: string;
    snapshot: GuildSnapshot;
    serverName: string;
    description: string | null;
    includeImages: boolean;
    includeEmojis: boolean;
    includeStickers: boolean;
    /** Channels whose messages come over (snapshot number + name), in order. Empty: structure only. */
    historyChannels: Array<{ num: number; name: string }>;
    prepareImage: RunnerDeps['prepareImage'];
}

/**
 * "Copy messages from Discord" into a server that ALREADY exists (owner 2026-11-22: his import left two
 * channels empty and he must fill them without deleting the server). No structure phase: only the message
 * copy, into the existing channels the admin mapped (utils/discordImport/copyMapping.ts).
 */
export interface CopyJobInput {
    api: DiscordImportApi;
    history: DiscordHistoryHost;
    guildId: string;
    guildName: string;
    server: { id: string; name: string };
    /** What to copy: the Discord channel (snapshot number), the existing Cipherline channel, the source key. */
    channels: Array<{ num: number; name: string; channelId: string; sourceKey?: string }>;
    /** `c:<snapshot number>` -> existing channel id, for #channel mentions (every name match, not only the copied ones). */
    channelRefs: Record<string, string>;
}

/** The job's input once started: a copy carries its targets (Discord channel number -> existing channel id). */
type JobInput = ImportJobInput & { copyTargets?: Record<number, string> };

export type ImportJobPhase =
    | 'structure'          // building the server (images, server, role icons, emojis, stickers)
    | 'structure-failed'   // "Try again" resumes; never a second server
    | 'cancelled'          // Cancel before the server existed: nothing was created
    | 'history'            // copying messages
    | 'history-failed'     // the server and what was copied are kept
    | 'done';

export interface ImportJob {
    readonly id: number;
    /** 'import': a new server from Discord; 'copy': messages into an existing server. */
    kind: 'import' | 'copy';
    phase: ImportJobPhase;
    /** The new server's name (the report's once it exists). */
    serverName: string;
    guildName: string;
    progress: Progress | null;
    hProgress: HistoryProgress | null;
    report: RunReport | null;
    hReports: ChannelReport[] | null;
    error: string | null;
    hError: string | null;
    /** Set once the server exists. */
    created: { id: string; name: string } | null;
    stopped: { deleted: number } | null;
    stopping: boolean;
    /** The whole job, 0-100 (the pill). */
    percent: number;
    /** What the report needs from the choices. */
    counts: GuildSnapshot['counts'];
    emojiTotal: number;
    stickerTotal: number;
    includeEmojis: boolean;
    includeStickers: boolean;
    withHistory: boolean;
    importId: string | null;
    /** The finished result has been on screen (a view was open when it finished, or opened since). */
    seen: boolean;
    /** A progress / report view is on screen right now (the pill steps aside). */
    viewing: boolean;
}

/** The history runner reports per message; subscribers hear about it at most this often. */
export const PROGRESS_EMIT_MS = 250;
/** With messages, the structure part is this share of the pill's percentage. */
const STRUCTURE_SHARE = 10;

interface Ctx {
    input: JobInput; runState: RunState; historyState: HistoryState; ctl: AbortController;
    /** Each target channel's source key (sent with the session, stored by the API only as a keyed hash). */
    sources?: Record<string, string>;
    /** Removes the page-unload guard (installed once per job while a session may be open). */
    unguard?: () => void;
    /** The message copy in flight (settles, never rejects): Stop waits for it so the stopped channel is in the report. */
    historyRun?: Promise<void>;
}
/** How long Stop waits for the copy to notice (its in-flight request) before reporting anyway. */
const STOP_SETTLE_MS = 8_000;

let job: ImportJob | null = null;
/** What subscribers see: only replaced on emit (useSyncExternalStore needs a stable snapshot). */
let published: ImportJob | null = null;
let ctx: Ctx | null = null;
let nextId = 1;
let viewers = 0;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const finishListeners = new Set<(j: ImportJob) => void>();

export const isRunningPhase = (p: ImportJobPhase | undefined): boolean => p === 'structure' || p === 'history';

export function jobPercent(j: Pick<ImportJob, 'phase' | 'progress' | 'hProgress' | 'withHistory'>): number {
    if (j.phase === 'done') return 100;
    const sFrac = j.progress && j.progress.total > 0 ? Math.min(1, j.progress.done / j.progress.total) : 0;
    const hp = j.hProgress;
    const hFrac = hp ? (hp.channelIndex + (hp.total > 0 ? Math.min(1, hp.done / hp.total) : 0)) / Math.max(1, hp.channels) : 0;
    if (!j.withHistory) return Math.round(sFrac * 100);
    if (j.phase === 'structure' || j.phase === 'structure-failed' || j.phase === 'cancelled') return Math.round(sFrac * STRUCTURE_SHARE);
    return Math.round(STRUCTURE_SHARE + hFrac * (100 - STRUCTURE_SHARE));
}

function emitNow(): void {
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    published = job;
    for (const l of [...listeners]) l();
}

function set(patch: Partial<ImportJob>, throttle = false): void {
    if (!job) return;
    const next = { ...job, ...patch };
    next.percent = jobPercent(next);
    job = next;
    if (!throttle) { emitNow(); return; }
    if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; emitNow(); }, PROGRESS_EMIT_MS);
}

/** What main was last told (a retry or the history phase after the structure one does not repeat it). */
let toldMain = false;
function tellMain(running: boolean): void {
    if (toldMain === running) return;
    toldMain = running;
    try { void ctx?.input.api.setRunning?.(running)?.catch?.(() => undefined); } catch { /* an older preload: no quit prompt */ }
}

/** Is `c` still the live job (not replaced, dismissed or signed out)? */
const live = (c: Ctx): boolean => ctx === c;

function finish(c: Ctx, patch: Partial<ImportJob>): void {
    if (!live(c)) return;
    tellMain(false);
    set({ ...patch, seen: viewers > 0 });
    const j = job!;
    for (const l of [...finishListeners]) { try { l(j); } catch { /* a listener never breaks the job */ } }
}

// ── Reading ──────────────────────────────────────────────────────────────

export const getImportJob = (): ImportJob | null => published;
export const importJobRunning = (): boolean => isRunningPhase(job?.phase);
/** The bridges the report view needs (forget the token, the "server save" popup). */
export const importJobDeps = (): { api: DiscordImportApi; history?: DiscordHistoryHost } | null =>
    ctx ? { api: ctx.input.api, history: ctx.input.history } : null;

export function subscribeImportJob(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Called once each time an import finishes (done, or messages stopped by an error). */
export function onImportJobFinished(fn: (j: ImportJob) => void): () => void {
    finishListeners.add(fn);
    return () => { finishListeners.delete(fn); };
}

/** A progress / report view is on screen while the returned function has not been called. */
export function attachImportJobViewer(): () => void {
    viewers++;
    if (job) set({ viewing: true, ...(!isRunningPhase(job.phase) ? { seen: true } : {}) });
    let done = false;
    return () => {
        if (done) return;
        done = true;
        viewers = Math.max(0, viewers - 1);
        if (job) set({ viewing: viewers > 0 });
    };
}
export const importJobViewers = (): number => viewers;

export function useImportJob(): ImportJob | null {
    return useSyncExternalStore(subscribeImportJob, getImportJob, getImportJob);
}

// ── Running ──────────────────────────────────────────────────────────────

async function structurePhase(c: Ctx): Promise<void> {
    const { input } = c;
    const signal = c.ctl.signal;
    set({ phase: 'structure', error: null });
    tellMain(true);
    const deps: RunnerDeps = {
        fetchImage: async (req) => {
            // Only the keys this kind uses: main refuses any unknown key, so an
            // older main process must never see `role: undefined` on an emoji.
            const r = await input.api.image({
                guildId: input.guildId, kind: req.kind,
                ...(req.emojiId !== undefined ? { emojiId: req.emojiId } : {}),
                ...(req.role !== undefined ? { role: req.role } : {}),
                ...(req.stickerId !== undefined ? { stickerId: req.stickerId } : {}),
            });
            return r.ok ? r : { ok: false, message: r.error.message };
        },
        prepareImage: input.prepareImage,
        upload: (blob, mime, opts) => input.host.upload(blob, mime, opts),
        importGuild: input.host.importGuild,
        listEmojiNames: input.host.listEmojiNames,
        createEmoji: input.host.createEmoji,
        ...(input.host.setRoleIcon ? { setRoleIcon: input.host.setRoleIcon } : {}),
        ...(input.host.createSticker ? { createSticker: input.host.createSticker } : {}),
    };
    try {
        const rep = await runStructureImport(deps, {
            snapshot: input.snapshot, serverName: input.serverName, description: input.description,
            includeImages: input.includeImages, includeEmojis: input.includeEmojis, includeStickers: input.includeStickers,
        }, c.runState, (p) => { if (live(c)) set({ progress: p }, true); }, signal);
        if (!live(c)) return;
        set({ report: rep, serverName: rep.serverName, created: { id: rep.serverId, name: rep.serverName } });
        // Stopped during the extras (the server exists): no messages after a Cancel.
        if (rep.cancelled || signal.aborted || !input.history || input.historyChannels.length === 0) { finish(c, { phase: 'done' }); return; }
        await historyPhase(c, rep.serverId);
    } catch (err) {
        if (!live(c)) return;
        if (err instanceof ImportAborted) {
            tellMain(false);
            set({ phase: 'cancelled', error: 'Cancelled. Nothing was created.' });
            return;
        }
        const st = c.runState;
        tellMain(false);
        set({
            phase: 'structure-failed', error: guildImportErrorMessage(err),
            created: st.serverId ? { id: st.serverId, name: st.serverName ?? input.serverName } : null,
        });
    }
}

/** Is the API session still open (created, not completed / cancelled)? */
const sessionOpen = (c: Ctx): boolean => !!c.historyState.importId && !c.historyState.completed;

/**
 * While a session may be open (messages being copied, or a report with a failed channel waiting for Retry):
 * if the page goes away (Quit anyway, a reload), end the API session KEEPING what was posted, so the
 * account's next import is not refused as "already running". Installed once per job; removed on close.
 */
function guardUnload(c: Ctx, serverId: string): void {
    if (c.unguard || typeof window === 'undefined' || !c.input.history?.cancelOnUnload) return;
    const onHide = () => {
        const iid = c.historyState.importId;
        if (live(c) && iid && sessionOpen(c)) {
            c.input.history!.cancelOnUnload!(serverId, iid);
            c.historyState.completed = true;
            clearImportSessionMarker();
        }
    };
    window.addEventListener('pagehide', onHide);
    c.unguard = () => { window.removeEventListener('pagehide', onHide); c.unguard = undefined; };
}

/**
 * Close the session once the person moves on (Open server, dismiss, sign-out). The runner leaves it open
 * while a channel failed with nothing posted, so "Retry" can post into it. Best effort: the API also
 * supersedes an idle session (15 min) when the next import starts, and the next launch ends it (marker).
 */
function closeSession(c: Ctx): void {
    c.unguard?.();
    const sid = c.runState.serverId;
    if (!sid || !c.input.history || !sessionOpen(c)) { if (c.historyState.completed) clearImportSessionMarker(); return; }
    void completeHistoryImport(c.input.history.api(sid), c.historyState)
        .then(() => clearImportSessionMarker(), () => undefined);
}

/** The channels whose messages come over, as the runner wants them (a copy: the admin's mapping). */
function chosenChannels(c: Ctx): Array<{ channel: number; channelId: string; name: string }> {
    const refs = c.runState.channelRefs ?? {};
    const copy = c.input.copyTargets;
    return c.input.historyChannels
        .map(ch => ({ channel: ch.num, channelId: copy ? copy[ch.num] : refs[`c:${ch.num}`], name: ch.name }))
        .filter(ch => !!ch.channelId);
}

/** A channel this device cannot encrypt for (no current key): failed with nothing posted, so Retry works. */
export const NO_CHANNEL_KEY_MESSAGE = 'This computer doesn’t have the channel’s current encryption key yet. Open the channel once so it arrives, then retry.';
function noKeyReport(ch: { channelId: string; name: string }): ChannelReport {
    return {
        channelId: ch.channelId, name: ch.name, messages: 0, rows: 0, filesImported: 0, filesSkipped: [], pinsSaved: 0, pinsNoRoom: 0,
        truncated: false, ceilingHit: false, reactionsSkipped: 0, savable: [], error: NO_CHANNEL_KEY_MESSAGE,
    };
}

async function historyPhase(c: Ctx, serverId: string, only?: Set<string>): Promise<void> {
    const { input } = c;
    const history = input.history!;
    const signal = c.ctl.signal;
    const chosen = chosenChannels(c).filter(ch => !only || only.has(ch.channelId));
    if (chosen.length === 0) { finish(c, { phase: 'done' }); return; }
    set({ phase: 'history', hError: null, hProgress: { channelIndex: 0, channels: chosen.length, channelName: chosen[0].name, phase: 'reading', done: 0, total: 1 } });
    tellMain(true);
    guardUnload(c, serverId);
    try {
        let runnable = chosen;
        if (input.copyTargets) {
            // Existing channels: NEVER mint a key here (that would rotate a live channel). A channel this device
            // holds no current key for fails on its own, with nothing posted (retryable once the key arrives).
            const missing = new Set(history.existingChannelKeys ? await history.existingChannelKeys(serverId, chosen.map(ch => ch.channelId)) : []);
            runnable = chosen.filter(ch => !missing.has(ch.channelId));
            c.historyState.reports = [
                ...c.historyState.reports.filter(r => !missing.has(r.channelId)),
                ...chosen.filter(ch => missing.has(ch.channelId)).map(noKeyReport),
            ];
            if (runnable.length === 0) {
                if (!live(c)) return;
                finish(c, { phase: 'done', hReports: orderedReports(c), importId: c.historyState.importId ?? null });
                return;
            }
        } else {
            await history.prepareChannelKeys(serverId, chosen.map(ch => ch.channelId));
            // Record which Discord channel filled each new channel, so a later "Copy messages from Discord"
            // matches them and never copies the same channel twice (keyed hash server-side).
            const keys = input.snapshot.channelKeys;
            if (keys && !c.sources) {
                const s: Record<string, string> = {};
                for (const ch of chosenChannels(c)) { const k = keys[ch.channel]; if (typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)) s[ch.channelId] = k; }
                if (Object.keys(s).length) c.sources = s;
            }
        }
        const emojiIds = await history.emojiIds(serverId).catch(() => ({}));
        const run = runHistoryImport({
            api: history.api(serverId),
            readChannel: async (num) => {
                const r = await input.api.history({ guildId: input.guildId, channel: num });
                if (!r.ok) {
                    // Where and why (labels from main) ride along for the issues list and the diagnostics event.
                    throw new ChannelReadError(r.error.message, {
                        step: r.error.step ?? 'read', code: r.error.code,
                        ...(typeof r.error.status === 'number' ? { status: r.error.status } : {}),
                        ...(r.error.errorName ? { errorName: r.error.errorName } : {}),
                    });
                }
                return r;
            },
            fetchMedia: async (ref) => {
                const r = await input.api.media({ ref });
                return r.ok ? { ok: true as const, mime: r.mime, bytes: r.bytes } : { ok: false as const, code: r.error.code, message: r.error.message };
            },
            encryptFile: history.encryptFile,
            upload: history.upload,
            sealRow: history.sealRow,
            deviceId: history.deviceId,
            maxFileBytes: history.maxFileBytes,
        }, {
            serverId, channels: runnable, roleRefs: c.runState.roleRefs, channelRefs: c.runState.channelRefs ?? {},
            ...(c.sources ? { channelSources: c.sources } : {}),
            convert: { emojiIds, stickerRefs: c.runState.stickerRefs ?? {} },
        }, c.historyState, (p) => {
            if (!live(c)) return;
            if (c.historyState.importId && job?.importId !== c.historyState.importId) markImportSessionOpen(serverId);
            set({ hProgress: p, importId: c.historyState.importId ?? null }, true);
        }, signal);
        c.historyRun = run.then(() => undefined, () => undefined);
        const st = await run;
        if (!live(c) || signal.aborted) return;
        if (st.completed) { clearImportSessionMarker(); c.unguard?.(); }
        // What went wrong (labels and counts only) reaches us next time instead of a silent 0/0 channel.
        reportImportDiagnostics(st.reports.filter(r => runnable.some(ch => ch.channelId === r.channelId)), { job: c.input.copyTargets ? 'copy' : 'import', retry: !!only });
        finish(c, { phase: 'done', hReports: orderedReports(c), importId: st.importId ?? null, stopped: null });
    } catch (err) {
        if (err instanceof HistoryAborted || signal.aborted || !live(c)) return; // stopHistoryJob / sign-out handles it
        reportImportDiagnostics([], { job: c.input.copyTargets ? 'copy' : 'import', retry: !!only, stopped: err });
        const generic = guildImportErrorMessage(err);
        finish(c, {
            phase: 'history-failed', hReports: [...c.historyState.reports], importId: c.historyState.importId ?? null,
            hError: generic === 'Something went wrong. Try again.' ? (apiMessageOf(err) || 'Something went wrong.') : generic,
        });
    }
}

/** The report in the chosen channel order (a retried channel keeps its place). */
function orderedReports(c: Ctx): ChannelReport[] {
    const order = new Map(chosenChannels(c).map((ch, i) => [ch.channelId, i]));
    return [...c.historyState.reports].sort((a, b) => (order.get(a.channelId) ?? 0) - (order.get(b.channelId) ?? 0));
}

/** The API's own words for a refusal (e.g. "An import is already running…"), else the error's message. */
function apiMessageOf(err: unknown): string {
    const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null;
    const m = e?.response?.data?.message;
    const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
    return text || (typeof e?.message === 'string' ? e.message : '');
}

/**
 * Start the import. Refuses while another one runs (one at a time). A finished
 * job that was never dismissed is replaced.
 */
export function startImportJob(input: ImportJobInput): ImportJob {
    if (importJobRunning()) throw new Error('An import is already running.');
    const c: Ctx = { input, runState: newRunState(), historyState: newHistoryState(), ctl: new AbortController() };
    ctx = c;
    job = {
        id: nextId++, kind: 'import', phase: 'structure', serverName: input.serverName, guildName: input.snapshot.guild.name,
        progress: null, hProgress: null, report: null, hReports: null, error: null, hError: null,
        created: null, stopped: null, stopping: false, percent: 0,
        counts: input.snapshot.counts, emojiTotal: input.snapshot.emojis.length, stickerTotal: input.snapshot.stickers?.length ?? 0,
        includeEmojis: input.includeEmojis, includeStickers: input.includeStickers,
        withHistory: !!input.history && input.historyChannels.length > 0,
        importId: null, seen: false, viewing: viewers > 0,
    };
    emitNow();
    void structurePhase(c);
    return job;
}

/**
 * "Copy messages from Discord" into an existing server: the message copy alone, as a job like any other
 * (one at a time, the pill, the toast, the quit prompt, Stop, Retry, the report).
 */
export function startCopyJob(input: CopyJobInput): ImportJob {
    if (importJobRunning()) throw new Error('An import is already running.');
    const copyTargets: Record<number, string> = {};
    const sources: Record<string, string> = {};
    for (const ch of input.channels) {
        copyTargets[ch.num] = ch.channelId;
        if (ch.sourceKey) sources[ch.channelId] = ch.sourceKey;
    }
    const notUsed = async (): Promise<never> => { throw new Error('not used by a copy'); };
    const jobInput: JobInput = {
        api: input.api, history: input.history, guildId: input.guildId,
        // A copy has no structure phase: only `guild.name` is read from the snapshot.
        snapshot: { guild: { id: input.guildId, name: input.guildName, description: null, hasIcon: false, hasBanner: false }, body: {}, emojis: [], counts: { roles: 0, categories: 0, channels: 0, emojis: 0 }, notMapped: [] },
        serverName: input.server.name, description: null, includeImages: false, includeEmojis: false, includeStickers: false,
        historyChannels: input.channels.map(ch => ({ num: ch.num, name: ch.name })),
        prepareImage: notUsed,
        host: { importGuild: notUsed, listEmojiNames: async () => [], createEmoji: async () => undefined, upload: notUsed },
        copyTargets,
    };
    const runState = newRunState();
    runState.serverId = input.server.id;
    runState.serverName = input.server.name;
    runState.channelRefs = { ...input.channelRefs };
    const c: Ctx = { input: jobInput, runState, historyState: newHistoryState(), ctl: new AbortController(), sources: Object.keys(sources).length ? sources : undefined };
    ctx = c;
    const report: RunReport = { serverId: input.server.id, serverName: input.server.name, iconDone: false, bannerDone: false, emojisAdded: 0, emojisSkipped: [], notes: [], cancelled: false };
    job = {
        id: nextId++, kind: 'copy', phase: 'history', serverName: input.server.name, guildName: input.guildName,
        progress: null, hProgress: null, report, hReports: null, error: null, hError: null,
        created: { id: input.server.id, name: input.server.name }, stopped: null, stopping: false, percent: 0,
        counts: jobInput.snapshot.counts, emojiTotal: 0, stickerTotal: 0, includeEmojis: false, includeStickers: false,
        withHistory: true, importId: null, seen: false, viewing: viewers > 0,
    };
    emitNow();
    void historyPhase(c, input.server.id);
    return job;
}

/** What the report may offer to retry: channels that failed with nothing posted, while the session is still open. */
export function retryableImportChannels(j: Pick<ImportJob, 'phase' | 'hReports'> | null): ChannelReport[] {
    const c = ctx;
    if (!j || j.phase !== 'done' || !c || !sessionOpen(c)) return [];
    return (j.hReports ?? []).filter(retryableChannel);
}

/**
 * What went wrong in a finished job, for the "issues found" report, toast and pill: channels that failed
 * (and which of those can be retried in place), channels Discord stopped answering partway, files and
 * messages left out.
 */
export interface ImportIssues {
    failed: ChannelReport[];
    retryable: ChannelReport[];
    partial: ChannelReport[];
    filesSkipped: number;
    messagesSkipped: number;
    any: boolean;
}
export function importJobIssues(j: Pick<ImportJob, 'phase' | 'hReports'> | null): ImportIssues {
    const reports = j?.phase === 'done' || j?.phase === 'history-failed' ? (j.hReports ?? []) : [];
    const failed = reports.filter(r => r.error !== null);
    const partial = reports.filter(r => r.error === null && r.partial === true);
    const filesSkipped = reports.reduce((t, r) => t + r.filesSkipped.length, 0);
    const messagesSkipped = reports.reduce((t, r) => t + (r.messagesSkipped ?? 0) + (r.unreadable ?? 0), 0);
    const retryable = j ? retryableImportChannels(j) : [];
    return { failed, retryable, partial, filesSkipped, messagesSkipped, any: failed.length > 0 || partial.length > 0 || filesSkipped > 0 || messagesSkipped > 0 };
}

/**
 * "Retry #x" / "Retry all": channels that failed with nothing posted, into the SAME session (nothing of them
 * was posted). `only`: just these channel ids (a per-channel Retry button).
 */
export function retryFailedImportChannels(only?: string[]): void {
    const c = ctx;
    if (!c || !job) return;
    const failed = retryableImportChannels(job).map(r => r.channelId).filter(id => !only || only.includes(id));
    const sid = c.runState.serverId;
    if (!sid || failed.length === 0) return;
    c.ctl = new AbortController();
    void historyPhase(c, sid, new Set(failed));
}

/** "Try again" after a structure failure: continues where it stopped, never a second server. */
export function retryImportJob(): void {
    const c = ctx;
    if (!c || job?.phase !== 'structure-failed') return;
    c.ctl = new AbortController();
    void structurePhase(c);
}

/** Cancel while the server is being built (before messages). */
export function cancelImportJob(): void {
    const c = ctx;
    if (!c || job?.phase !== 'structure') return;
    c.ctl.abort();
    void c.input.api.cancel().catch(() => undefined);
}

/** Stop the message copy: keep what was posted, or delete it all (one server call). */
export async function stopImportJobHistory(deletePosted: boolean): Promise<void> {
    const c = ctx;
    if (!c || job?.phase !== 'history' || job.stopping) return;
    c.ctl.abort();
    void c.input.api.cancel().catch(() => undefined);
    set({ stopping: true });
    const iid = c.historyState.importId;
    const sid = c.runState.serverId;
    let deleted = 0;
    if (iid && sid && c.input.history) {
        try { deleted = (await c.input.history.cancel(sid, iid, deletePosted)).deleted; } catch { /* the session expires on its own after 72 h idle */ }
    }
    // The runner notices the abort after its in-flight request: wait for it (bounded), so the channel it was
    // copying is in the report with what it posted.
    if (c.historyRun) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([c.historyRun, new Promise<void>(r => { timer = setTimeout(r, STOP_SETTLE_MS); })]);
        if (timer) clearTimeout(timer);
    }
    // The cancel call ended the session (or it is superseded later): nothing left to close or retry.
    c.historyState.completed = true;
    clearImportSessionMarker();
    c.unguard?.();
    finish(c, { phase: 'done', stopping: false, stopped: { deleted }, hReports: orderedReports(c), importId: iid ?? null });
}

/** Forget a finished (or cancelled / failed) job: the pill goes away. A running job is never dismissed. */
export function dismissImportJob(): void {
    if (importJobRunning()) return;
    if (ctx) closeSession(ctx);
    ctx = null;
    job = null;
    emitNow();
}

/** Signing out / switching account: stop everything now, quietly. */
export function abortImportJob(): void {
    const c = ctx;
    if (!c) return;
    const wasRunning = importJobRunning();
    c.ctl.abort();
    if (wasRunning) { void c.input.api.cancel().catch(() => undefined); tellMain(false); }
    closeSession(c);
    ctx = null;
    job = null;
    emitNow();
}

/**
 * At sign-in: an import session this device left open (the app crashed or was killed mid-copy, so no
 * keepalive cancel ran) is ended now, keeping what it copied, so the next import is not refused. A
 * network failure keeps the marker for next time; any API answer (ended, nothing open, no permission,
 * server gone) clears it. The API's 15-minute idle rule is the backstop either way.
 */
export async function endInterruptedImportSession(end: (serverId: string) => Promise<unknown>): Promise<'ended' | 'none' | 'kept'> {
    await secureLocalStore.whenAccountReady();
    if (getImportJob()) return 'none';                    // a job of this run owns its session
    const m = readImportSessionMarker();
    if (!m) return 'none';
    try {
        await end(m.serverId);
        clearImportSessionMarker();
        return 'ended';
    } catch (err) {
        if ((err as { response?: unknown } | null)?.response) { clearImportSessionMarker(); return 'ended'; }
        return 'kept';
    }
}

/** Tests only. */
export function resetImportJobForTests(): void {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    ctx?.ctl.abort();
    ctx?.unguard?.();
    ctx = null; job = null; published = null; viewers = 0; toldMain = false;
    listeners.clear(); finishListeners.clear();
}
