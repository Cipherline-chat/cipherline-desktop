/**
 * Renderer-side view of the Discord structure importer's IPC (the main-process
 * half is electron/discord-import/). Types only plus one accessor: the bot
 * token never appears here, in either direction after `connect`.
 */
import type { TemplateBlueprint } from '../discordTemplate';

export interface DiscordIpcFailure {
    ok: false;
    /** `step` / `status` / `errorName`: where a channel read failed (labels only, for the report and diagnostics). */
    error: { code: string; message: string; retryAfterMs?: number; step?: string; status?: number; errorName?: string };
}
export type DiscordIpcResult<T> = ({ ok: true } & T) | DiscordIpcFailure;

export interface DiscordGuildListItem {
    id: string; name: string; owner: boolean; hasIcon: boolean;
    /** The bot holds Administrator there (null: Discord did not say). */
    admin?: boolean | null;
}

/** The bot's application, derived from the token in main (never typed by the user). */
export interface DiscordAppInfo {
    /** OAuth2 client_id: the invite link is built from this. */
    id: string;
    name: string;
    intents: { messageContent: boolean; members: boolean };
}

export interface NotMappedItem { item: string; reason: string }

/**
 * A Discord member whose roles / member overwrites / nickname come over (D5b).
 * `id` is the Discord user id: posted once with import-guild, where the API
 * keeps only its keyed hash. Never shown, never stored on this device.
 */
export interface GuildSnapshotMember {
    id: string; ref: number; roles: number[]; nick?: string;
    /** The day they joined the Discord server (`YYYY-MM-DD`, UTC): "Member since" once claimed. */
    joined_at?: string;
}
export interface GuildSnapshotBan { id: string; reason?: string }
/** A Discord guild sticker: `name` is already a Cipherline sticker name, unique in the list. */
export interface GuildSnapshotSticker { id: string; name: string; description?: string; tags: string[]; animated: boolean }

export interface GuildSnapshot {
    guild: { id: string; name: string; description: string | null; hasIcon: boolean; hasBanner: boolean };
    /** Template-shaped guild structure, posted to preview-guild / import-guild. */
    body: Record<string, unknown>;
    emojis: Array<{ id: string; name: string; animated: boolean }>;
    /** Absent from an older main process. */
    members?: GuildSnapshotMember[];
    bans?: GuildSnapshotBan[];
    /** Snapshot role numbers (`r:N`) whose role has an icon PICTURE: fetched from
     *  Discord's CDN by main and uploaded after the server exists. Absent from an
     *  older main process. */
    roleIcons?: number[];
    /** Guild stickers that come over (PNG / APNG / GIF; Lottie is left out). Absent from an older main process. */
    stickers?: GuildSnapshotSticker[];
    /** Message channel number -> opaque source key (hex SHA-256 made in main; never the Discord id). Absent from an older main process. */
    channelKeys?: Record<number, string>;
    counts: { roles: number; categories: number; channels: number; emojis: number; members?: number; bans?: number };
    notMapped: NotMappedItem[];
}

/** One Discord message as the main process hands it over (electron/discord-import/history.ts). */
export interface ImportAuthorInfo { id: string; name: string; username: string | null; kind: 'user' | 'webhook' | 'app'; avatarRef: string | null }
export interface ImportFileInfo { ref: string; filename: string; size: number; mime: string; voice: boolean; embedImage?: boolean }
export interface ImportMessage {
    id: string;
    ts: string;
    edited: boolean;
    author: ImportAuthorInfo;
    content: string;
    mentionNames: Record<string, string>;
    replyTo: string | null;
    files: ImportFileInfo[];
    embeds: Array<{ title: string | null; description: string | null; url: string | null; fields: Array<{ name: string; value: string }>; author: string | null; footer: string | null }>;
    stickers: string[];
    /** The message's stickers by Discord id; `ref` fetches the picture, null for Lottie. Absent from an older main process. */
    stickerItems?: Array<{ id: string; name: string; format: number; ref: string | null }>;
    /** A forward's original words (its files and embeds are in `files` / `embeds`). Absent from an older main process. */
    forwarded?: { content: string; ts: string | null } | null;
    poll: { question: string; answers: Array<{ text: string; votes: number }> } | null;
    pinned: boolean;
    /** Absent from an older main process. `users` = the first 100 who reacted ([] past the read budget). */
    reactions?: Array<{ emoji: { id: string | null; name: string; animated: boolean }; count: number; users: Array<{ id: string; name: string; kind: 'user' | 'app' }> }>;
}
export interface ChannelHistory {
    messages: ImportMessage[];
    /** Newest pin first (Discord's order). */
    pins: ImportMessage[];
    truncated: boolean;
    /** Stopped by the 25,000-message safety ceiling (absent from an older main process). */
    ceilingHit?: boolean;
    reactionRequests?: number;
    /** What a best-effort part of the read (pins, who reacted) could not get; shown in the report. */
    notes?: string[];
    /** Messages Discord sent that could not be read (left out). */
    unreadable?: number;
    /** Discord stopped answering partway: only the newest messages came (labels only). */
    partial?: { kind: string; status?: number };
    /** `roleNums` / `channelNums`: Discord id -> snapshot number (absent from an older main process). */
    names: { roles: Record<string, string>; channels: Record<string, string>; roleNums?: Record<string, number>; channelNums?: Record<string, number> };
}

/** "The icon / banner / emoji N / the icon of role N" of the guild main read: never a URL. */
export interface DiscordImageRequest { guildId: string; kind: 'icon' | 'banner' | 'emoji' | 'role_icon' | 'sticker'; emojiId?: string; role?: number; stickerId?: string }

export interface DiscordImportApi {
    status(): Promise<DiscordIpcResult<{ hasToken: boolean; bot: { id: string; name: string } | null; app?: DiscordAppInfo | null; storageReady: boolean }>>;
    connect(token: string): Promise<DiscordIpcResult<{ bot: { id: string; name: string }; app: DiscordAppInfo }>>;
    /** Optional so an older preload (without the channel) degrades instead of crashing. */
    checkApp?(): Promise<DiscordIpcResult<{ app: DiscordAppInfo }>>;
    forget(): Promise<DiscordIpcResult<object>>;
    listGuilds(): Promise<DiscordIpcResult<{ guilds: DiscordGuildListItem[] }>>;
    snapshot(guildId: string): Promise<DiscordIpcResult<{ snapshot: GuildSnapshot }>>;
    image(req: DiscordImageRequest): Promise<DiscordIpcResult<{ mime: string; dataB64: string; note?: string }>>;
    cancel(): Promise<DiscordIpcResult<object>>;
    history(req: { guildId: string; channel: number }): Promise<DiscordIpcResult<ChannelHistory>>;
    media(req: { ref: string }): Promise<DiscordIpcResult<{ mime: string; bytes: Uint8Array }>>;
    /** Tell main an import is (not) running, so quitting asks first. Optional: an older preload has no prompt. */
    setRunning?(running: boolean): Promise<DiscordIpcResult<object>>;
}

/** The preload bridge, or null where it does not exist (the website, tests). */
export function getDiscordImportApi(): DiscordImportApi | null {
    const api = (globalThis as { window?: { electronAPI?: { discordImport?: DiscordImportApi } } }).window?.electronAPI?.discordImport;
    return api ?? null;
}

// ── API (Cipherline) request / response shapes ───────────────────────────

export interface GuildPreview {
    template: { name: string; description: string | null };
    blueprint: TemplateBlueprint;
}

export interface GuildImportRequest {
    guild: Record<string, unknown>;
    /** People whose roles / overrides / nickname are recorded for when they claim (D5b). */
    members?: GuildSnapshotMember[];
    bans?: GuildSnapshotBan[];
    name: string;
    description?: string;
    icon_attachment?: string;
    icon_key_b64?: string;
    icon_nonce_b64?: string;
    banner_attachment?: string;
    banner_key_b64?: string;
    banner_nonce_b64?: string;
}

/** What import-guild says about the people it recorded (absent from an older API). */
export interface MemberGrantsResult {
    status: 'saved' | 'none' | 'disabled' | 'unavailable' | 'failed';
    people: number; roles: number; overrides: number; nicknames?: number; bans?: number;
    /** People whose Discord join day was recorded ("Member since"). Newer APIs only. */
    member_since?: number;
}

/**
 * What POST .../import-guild answers, as the wizard needs it. Every field
 * past `server_id` / `name` is additive (an older API omits it). The host
 * (Dashboard via makeImportGuildHandler) must hand ALL of it to the wizard:
 * `member_grants` feeds the "Saved for N people" report line, `role_refs`
 * the role mentions and role icons, `channel_refs` the history import.
 */
export interface GuildImportResponse {
    server_id: string;
    name: string;
    channel_refs?: Record<string, string>;
    role_refs?: Record<string, string>;
    member_grants?: MemberGrantsResult;
    /** Slowmode / age-restricted: 'unavailable' = this API's database lacks the columns. */
    channel_settings?: 'none' | 'applied' | 'unavailable' | 'failed';
}
