/**
 * Runs the "Import from Discord" structure import once the user has consented.
 *
 *   1. fetch icon + banner from Discord's CDN (main process), prepare + upload
 *      them encrypted exactly like Server Settings does;
 *   2. ONE API call builds the new server (roles, categories, channels,
 *      overrides in a single transaction: private channels exist with their
 *      overrides from the first instant, nothing is ever briefly public);
 *   3. custom emojis, one at a time, paced under the server's 20/min limit.
 *
 * Idempotent retries: `state` outlives a failed attempt. After the server
 * exists a retry never creates a second one, and emojis already on the server
 * (by name) are not uploaded again. Cancel stops further work and KEEPS what
 * exists; the importer only ever adds, it never deletes anything.
 *
 * Everything external is injected (IPC, uploads, API, sleep), so this is
 * tested without Electron, a network or a canvas.
 */
import { deriveEmojiName, retryAfterMs, uniqueEmojiName } from '../emojiBulk/batch';

/**
 * Gap between two emoji creates in the structure import: the API's import
 * path allows 90 / 60 s (importEmoji), so 700 ms (~86 / min) stays under it.
 * Was 3,100 ms (the interactive 20 / min): 200 emojis ~10.3 min -> ~2.3 min
 * plus upload time. An older API answers 429 on the interactive bucket and
 * the retry-after handling below paces it.
 */
export const IMPORT_EMOJI_GAP_MS = 700;

/**
 * Gap between two role-icon uploads: PUT roles/:rid/icon is on the API's
 * `roleIcon` bucket (5 / 10 s, an image decode per call), so 2,100 ms stays
 * under it; a 429 is still honoured through retry-after below. Discord role
 * icons are a boost perk, so a server rarely has more than a handful.
 */
export const IMPORT_ROLE_ICON_GAP_MS = 2_100;

/**
 * Gap between two server-sticker creates: POST .../stickers/import is on the
 * API's `importSticker` bucket (10 / 10 s), so 1,050 ms stays under it; a 429
 * is honoured through retry-after like the emoji loop.
 */
export const IMPORT_STICKER_GAP_MS = 1_050;
import { isEmojiCountLimitError, isStorageQuotaError } from '../serverStorageCopy';
import { EMOJI_MAX_BYTES } from '../imageUploadValidation';
import type { GuildImportRequest, GuildImportResponse, GuildSnapshot, MemberGrantsResult } from './types';

export interface EncryptedUpload { attachmentId: string; keyB64: string; nonceB64: string }

export interface RunnerDeps {
    fetchImage(req: { kind: 'icon' | 'banner' | 'emoji' | 'role_icon' | 'sticker'; emojiId?: string; role?: number; stickerId?: string }): Promise<{ ok: true; mime: string; dataB64: string; note?: string } | { ok: false; message: string }>;
    /** Crop / resize a fetched icon or banner to Cipherline's preset (canvas, in the app). */
    prepareImage(blob: Blob, kind: 'icon' | 'banner'): Promise<{ blob: Blob; mime: string }>;
    upload(blob: Blob, mime: string, opts?: { serverId?: string; signal?: AbortSignal }): Promise<EncryptedUpload>;
    importGuild(req: GuildImportRequest): Promise<GuildImportResponse>;
    listEmojiNames(serverId: string): Promise<string[]>;
    createEmoji(serverId: string, body: { name: string; attachment_id: string; key_b64: string; nonce_b64: string }): Promise<void>;
    /** Upload + set one role's icon picture (absent: an older host; pictures are reported instead). */
    setRoleIcon?(serverId: string, roleId: string, blob: Blob, mime: string, signal?: AbortSignal): Promise<void>;
    /** Create one server sticker from its bytes (the import route); absent: an older host, stickers are reported. */
    createSticker?(serverId: string, input: { bytes: Uint8Array; name: string; description?: string; tags?: string[]; signal?: AbortSignal }): Promise<{ sticker_id: string; name: string }>;
    sleep?(ms: number): Promise<void>;
}

export interface RunInput {
    snapshot: GuildSnapshot;
    serverName: string;
    description: string | null;
    includeImages: boolean;
    includeEmojis: boolean;
    /** Copy the guild's stickers (default: on when the snapshot has any). */
    includeStickers?: boolean;
}

/** Survives retries. */
export interface RunState {
    serverId?: string;
    serverName?: string;
    icon?: EncryptedUpload | null;
    banner?: EncryptedUpload | null;
    imagesTried?: boolean;
    emojiDone: Set<string>;
    /** Blueprint channel ref (`c:<snapshot number>`) -> the new channel's id (history import). */
    channelRefs?: Record<string, string>;
    /** Blueprint role ref (`r:<snapshot number>`) -> the new role's id (role mentions). */
    roleRefs?: Record<string, string>;
    people?: MemberGrantsResult;
    channelSettings?: GuildImportResponse['channel_settings'];
    /** Snapshot role numbers whose icon picture is set (a retry skips them). */
    roleIconDone?: Set<number>;
    /** Discord sticker id -> the server sticker created for it (a retry skips it; the history import references it). */
    stickerRefs?: Record<string, { id: string; name: string }>;
}
export const newRunState = (): RunState => ({ emojiDone: new Set(), roleIconDone: new Set() });

export type ProgressStep = 'images' | 'server' | 'roleIcons' | 'emojis' | 'stickers' | 'done';
export interface Progress { step: ProgressStep; done: number; total: number; label: string }

export interface SkippedEmoji { name: string; reason: string }
export interface RunReport {
    serverId: string;
    serverName: string;
    iconDone: boolean;
    bannerDone: boolean;
    emojisAdded: number;
    emojisSkipped: SkippedEmoji[];
    notes: string[];
    cancelled: boolean;
    /** The people side (roles, overrides, nicknames, bans) as the API recorded it. */
    people?: MemberGrantsResult;
    /** Role icon pictures set on the new server. */
    roleIconsAdded?: number;
    /** Server stickers created from the guild's stickers. */
    stickersAdded?: number;
    stickersSkipped?: SkippedEmoji[];
}

export class ImportAborted extends Error { constructor() { super('Cancelled'); } }

const b64ToBlob = (b64: string, mime: string): Blob => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
};

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function messageOf(err: unknown): string {
    const e = err as { response?: { data?: { message?: unknown; code?: string } }; message?: string } | null;
    const m = e?.response?.data?.message;
    const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
    return text || e?.message || 'Upload failed';
}

/** A 400 from an API that predates the members' join day ("members.0.property joined_at should not exist"). */
export function isUnknownJoinedAt(err: unknown): boolean {
    const e = err as { response?: { status?: number; data?: { message?: unknown } } } | null;
    if (e?.response?.status !== 400) return false;
    const m = e.response.data?.message;
    const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
    return /property joined_at should not exist/.test(text);
}

/** A 400 from an API that predates the people fields ("property members should not exist"). */
export function isUnknownPeopleFields(err: unknown): boolean {
    const e = err as { response?: { status?: number; data?: { message?: unknown } } } | null;
    if (e?.response?.status !== 400) return false;
    const m = e.response.data?.message;
    const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
    return /property (members|bans) should not exist/.test(text);
}

/** One line for the report about the people side, or null when there was nothing to carry. */
export function peopleNote(r: MemberGrantsResult | undefined, sent: number): string | null {
    if (!r || sent === 0) return null;
    if (r.status === 'saved') {
        const parts = [`${r.roles} role${r.roles === 1 ? '' : 's'}`];
        if (r.overrides) parts.push(`${r.overrides} channel permission${r.overrides === 1 ? '' : 's'}`);
        if (r.nicknames) parts.push(`${r.nicknames} nickname${r.nicknames === 1 ? '' : 's'}`);
        if (r.bans) parts.push(`${r.bans} ban${r.bans === 1 ? '' : 's'}`);
        if (r.member_since) parts.push(`${r.member_since.toLocaleString()} “member since” date${r.member_since === 1 ? '' : 's'}`);
        return `Saved for ${r.people.toLocaleString()} ${r.people === 1 ? 'person' : 'people'} (${parts.join(', ')}): each gets theirs when they join and link the same Discord account.`;
    }
    if (r.status === 'none') return null;
    return 'Members\' roles, nicknames and bans could not be saved on this Cipherline server right now. The server itself was built.';
}

export async function runStructureImport(
    deps: RunnerDeps, input: RunInput, state: RunState,
    onProgress: (p: Progress) => void, signal: AbortSignal,
): Promise<RunReport> {
    const sleep = deps.sleep ?? realSleep;
    const check = () => { if (signal.aborted) throw new ImportAborted(); };
    const notes: string[] = [];

    // ── 1. Icon + banner (best effort: a missing image never blocks the server) ──
    if (!state.serverId && input.includeImages && !state.imagesTried) {
        const wants: Array<'icon' | 'banner'> = [];
        if (input.snapshot.guild.hasIcon) wants.push('icon');
        if (input.snapshot.guild.hasBanner) wants.push('banner');
        let i = 0;
        for (const kind of wants) {
            check();
            onProgress({ step: 'images', done: i++, total: wants.length, label: kind === 'icon' ? 'Copying the server icon' : 'Copying the server banner' });
            try {
                const img = await deps.fetchImage({ kind });
                if (!img.ok) { notes.push(`The ${kind} could not be copied: ${img.message}`); continue; }
                const prepared = await deps.prepareImage(b64ToBlob(img.dataB64, img.mime), kind);
                state[kind] = await deps.upload(prepared.blob, prepared.mime, { signal });
            } catch (err) {
                if (signal.aborted) throw new ImportAborted();
                notes.push(`The ${kind} could not be copied (${messageOf(err)}). You can add it in Server Settings.`);
            }
        }
        state.imagesTried = true;
    }

    // ── 2. The server itself: once ───────────────────────────────────────
    if (!state.serverId) {
        check();
        onProgress({ step: 'server', done: 0, total: 1, label: 'Building roles, categories and channels' });
        const req: GuildImportRequest = { guild: input.snapshot.body, name: input.serverName };
        if (input.snapshot.members?.length) req.members = input.snapshot.members;
        if (input.snapshot.bans?.length) req.bans = input.snapshot.bans;
        if (input.description !== null) req.description = input.description;
        if (state.icon) { req.icon_attachment = state.icon.attachmentId; req.icon_key_b64 = state.icon.keyB64; req.icon_nonce_b64 = state.icon.nonceB64; }
        if (state.banner) { req.banner_attachment = state.banner.attachmentId; req.banner_key_b64 = state.banner.keyB64; req.banner_nonce_b64 = state.banner.nonceB64; }
        let created: Awaited<ReturnType<RunnerDeps['importGuild']>>;
        try {
            try {
                created = await deps.importGuild(req);
            } catch (err) {
                // An API with the people fields but not the join day ("member
                // since"): keep everyone's roles, drop only the days.
                if (!req.members?.some(mm => mm.joined_at) || !isUnknownJoinedAt(err)) throw err;
                req.members = req.members.map(mm => { const c = { ...mm }; delete c.joined_at; return c; });
                created = await deps.importGuild(req);
                notes.push('“Member since” dates could not be carried over: this Cipherline server does not support them yet.');
            }
        } catch (err) {
            // An older API refuses the unknown `members` / `bans` fields (400,
            // forbidNonWhitelisted): build the server without the people side
            // rather than not at all, and say so.
            if (!(req.members || req.bans) || !isUnknownPeopleFields(err)) throw err;
            delete req.members; delete req.bans;
            created = await deps.importGuild(req);
            notes.push('Members\' roles, nicknames and bans could not be carried over: this Cipherline server does not support it yet.');
        }
        state.serverId = created.server_id;
        state.serverName = created.name;
        state.channelRefs = created.channel_refs ?? {};
        state.roleRefs = created.role_refs ?? {};
        state.people = created.member_grants;
        state.channelSettings = created.channel_settings;
        onProgress({ step: 'server', done: 1, total: 1, label: 'Server created' });
    }
    const serverId = state.serverId;

    const report: RunReport = {
        serverId, serverName: state.serverName ?? input.serverName,
        iconDone: !!state.icon, bannerDone: !!state.banner,
        emojisAdded: 0, emojisSkipped: [], notes, cancelled: false,
        ...(state.people ? { people: state.people } : {}),
    };
    const pn = peopleNote(state.people, (input.snapshot.members?.length ?? 0) + (input.snapshot.bans?.length ?? 0));
    if (pn && !notes.includes(pn)) notes.push(pn);
    const cs = channelSettingsNote(state.channelSettings, input.snapshot);
    if (cs && !notes.includes(cs)) notes.push(cs);

    // ── 2b. Role icon pictures (Discord `icon`; an emoji icon came with the server) ──
    const iconRoles = (input.snapshot.roleIcons ?? []).filter(n => Number.isSafeInteger(n) && n > 0);
    if (iconRoles.length > 0) {
        if (!state.roleIconDone) state.roleIconDone = new Set();
        const done = state.roleIconDone;
        const roleName = (n: number) => {
            const r = (Array.isArray(input.snapshot.body.roles) ? input.snapshot.body.roles : [])
                .find((x: unknown) => (x as { id?: unknown })?.id === n) as { name?: unknown } | undefined;
            return typeof r?.name === 'string' ? r.name : `role ${n}`;
        };
        const setIcon = deps.setRoleIcon;
        if (!setIcon) {
            notes.push(`${iconRoles.length} role icon picture${iconRoles.length === 1 ? '' : 's'} could not be copied by this version of Cipherline. You can add them in Server Settings, Roles.`);
        } else {
            let i = 0;
            for (const n of iconRoles) {
                if (signal.aborted) { report.cancelled = true; break; }
                i++;
                if (done.has(n)) { report.roleIconsAdded = (report.roleIconsAdded ?? 0) + 1; continue; }
                const roleId = state.roleRefs?.[`r:${n}`];
                if (!roleId) { notes.push(`The icon of “${roleName(n)}” was not copied: the role was not created.`); continue; }
                onProgress({ step: 'roleIcons', done: i - 1, total: iconRoles.length, label: `Copying role icon ${i} of ${iconRoles.length}` });
                try {
                    const img = await deps.fetchImage({ kind: 'role_icon', role: n });
                    if (!img.ok) { notes.push(`The icon of “${roleName(n)}” could not be copied: ${img.message}`); continue; }
                    const blob = b64ToBlob(img.dataB64, img.mime);
                    let attempts = 0;
                    for (;;) {
                        try { await setIcon(serverId, roleId, blob, img.mime, signal); break; }
                        catch (err) {
                            const wait = retryAfterMs(err);
                            if (wait !== null && attempts++ < 3 && !signal.aborted) { await sleep(wait); continue; }
                            throw err;
                        }
                    }
                    done.add(n);
                    report.roleIconsAdded = (report.roleIconsAdded ?? 0) + 1;
                } catch (err) {
                    if (signal.aborted) { report.cancelled = true; break; }
                    notes.push(`The icon of “${roleName(n)}” could not be copied (${messageOf(err)}). You can add it in Server Settings, Roles.`);
                }
                if (i < iconRoles.length) await sleep(IMPORT_ROLE_ICON_GAP_MS);
            }
        }
    }

    // ── 3. Emojis ────────────────────────────────────────────────────────
    if (input.includeEmojis && input.snapshot.emojis.length > 0) {
        const list = input.snapshot.emojis;
        // Names already on the server when this run (or retry) starts, and the
        // names THIS run hands out in Discord order. Assigning from `claimed`
        // alone keeps every emoji's final name identical across retries
        // ("Tractor" and "tractor" become tractor and tractor_2 every time).
        const existing = new Set<string>(await deps.listEmojiNames(serverId).catch(() => []));
        const claimed = new Set<string>();
        const gap = list.length > 1 ? IMPORT_EMOJI_GAP_MS : 0;
        let n = 0;
        let stopAll: string | null = null;
        for (const e of list) {
            if (signal.aborted) { report.cancelled = true; break; }
            n++;
            onProgress({ step: 'emojis', done: n - 1, total: list.length, label: `Adding emoji ${n} of ${list.length}` });
            const name = uniqueEmojiName(deriveEmojiName(e.name), claimed);
            claimed.add(name);
            if (state.emojiDone.has(e.id)) { report.emojisAdded++; continue; }
            if (stopAll) { report.emojisSkipped.push({ name: e.name, reason: stopAll }); continue; }
            // Already on the server under that name (a previous attempt whose answer was lost): done.
            if (existing.has(name)) { state.emojiDone.add(e.id); report.emojisAdded++; continue; }
            try {
                const img = await deps.fetchImage({ kind: 'emoji', emojiId: e.id });
                if (!img.ok) { report.emojisSkipped.push({ name: e.name, reason: img.message }); continue; }
                const blob = b64ToBlob(img.dataB64, img.mime);
                if (blob.size > EMOJI_MAX_BYTES) { report.emojisSkipped.push({ name: e.name, reason: 'Image is over the size limit' }); continue; }
                let attempts = 0;
                for (;;) {
                    try {
                        const up = await deps.upload(blob, img.mime, { serverId, signal });
                        await deps.createEmoji(serverId, { name, attachment_id: up.attachmentId, key_b64: up.keyB64, nonce_b64: up.nonceB64 });
                        break;
                    } catch (err) {
                        const wait = retryAfterMs(err);
                        if (wait !== null && attempts++ < 3 && !signal.aborted) { await sleep(wait); continue; }
                        throw err;
                    }
                }
                state.emojiDone.add(e.id);
                report.emojisAdded++;
                if (img.note) report.notes.push(`:${name}: ${img.note}`);
            } catch (err) {
                if (signal.aborted) { report.cancelled = true; break; }
                const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
                if (isStorageQuotaError(data)) { stopAll = 'The server is out of storage'; report.emojisSkipped.push({ name: e.name, reason: stopAll }); continue; }
                if (isEmojiCountLimitError(data)) { stopAll = 'The server reached its emoji limit'; report.emojisSkipped.push({ name: e.name, reason: stopAll }); continue; }
                report.emojisSkipped.push({ name: e.name, reason: messageOf(err) });
                continue;
            }
            if (gap > 0 && n < list.length) await sleep(gap);
        }
    }

    // ── 4. Server stickers (PNG / APNG / GIF; Lottie never reaches here) ──
    const stickerList = input.snapshot.stickers ?? [];
    if ((input.includeStickers ?? true) && stickerList.length > 0 && !report.cancelled) {
        if (!state.stickerRefs) state.stickerRefs = {};
        const refs = state.stickerRefs;
        report.stickersAdded = 0; report.stickersSkipped = [];
        const create = deps.createSticker;
        if (!create) {
            notes.push(`${stickerList.length} sticker${stickerList.length === 1 ? '' : 's'} could not be copied by this version of Cipherline.`);
        } else {
            let n = 0; let stopAll: string | null = null;
            for (const st of stickerList) {
                if (signal.aborted) { report.cancelled = true; break; }
                n++;
                if (refs[st.id]) { report.stickersAdded++; continue; }
                if (stopAll) { report.stickersSkipped.push({ name: st.name, reason: stopAll }); continue; }
                onProgress({ step: 'stickers', done: n - 1, total: stickerList.length, label: `Adding sticker ${n} of ${stickerList.length}` });
                try {
                    const img = await deps.fetchImage({ kind: 'sticker', stickerId: st.id });
                    if (!img.ok) { report.stickersSkipped.push({ name: st.name, reason: img.message }); continue; }
                    const bin = atob(img.dataB64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    let attempts = 0;
                    for (;;) {
                        try {
                            const made = await create(serverId, { bytes, name: st.name, ...(st.description ? { description: st.description } : {}), ...(st.tags.length ? { tags: st.tags } : {}), signal });
                            refs[st.id] = { id: made.sticker_id, name: made.name };
                            break;
                        } catch (err) {
                            const wait = retryAfterMs(err);
                            if (wait !== null && attempts++ < 3 && !signal.aborted) { await sleep(wait); continue; }
                            throw err;
                        }
                    }
                    report.stickersAdded++;
                } catch (err) {
                    if (signal.aborted) { report.cancelled = true; break; }
                    const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
                    if (isStorageQuotaError(data)) { stopAll = 'The server is out of storage'; report.stickersSkipped.push({ name: st.name, reason: stopAll }); continue; }
                    report.stickersSkipped.push({ name: st.name, reason: messageOf(err) });
                }
                if (n < stickerList.length) await sleep(IMPORT_STICKER_GAP_MS);
            }
            const sk = report.stickersSkipped;
            if (sk.length) notes.push(`${sk.length} sticker${sk.length === 1 ? '' : 's'} not copied: ${sk.slice(0, 5).map(x => `${x.name} (${x.reason})`).join(', ')}${sk.length > 5 ? ', ...' : ''}`);
        }
    }

    onProgress({ step: 'done', done: 1, total: 1, label: report.cancelled ? 'Stopped' : 'Done' });
    return report;
}

/** One line when the channels' slowmode / age-restriction could not be set, or null. */
export function channelSettingsNote(status: GuildImportResponse['channel_settings'], snapshot: Pick<GuildSnapshot, 'body'>): string | null {
    if (status !== 'unavailable' && status !== 'failed') return null;
    const chans = Array.isArray(snapshot.body.channels) ? snapshot.body.channels as Array<{ nsfw?: unknown; rate_limit_per_user?: unknown }> : [];
    const n = chans.filter(c => c?.nsfw === true || (typeof c?.rate_limit_per_user === 'number' && c.rate_limit_per_user > 0)).length;
    if (n === 0) return null;
    return `Slowmode and age-restricted settings of ${n} channel${n === 1 ? '' : 's'} could not be set on this Cipherline server yet. You can set them in each channel's settings.`;
}
