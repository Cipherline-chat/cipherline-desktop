import { encryptBlobOffThread, decryptBlobOffThread } from './attachmentCryptoWorker';
import secureLocalStore from './secureLocalStore';
import * as messageStore from './messageStore';
import { collectIncludedKv, applyIncludedKv, repairSoundPaths, APP_PREF_KEYS } from '../services/backupRegistry';
import { extractPortableSaves, portableSavesFromVault, applyRestoredSaves, type PortableRetentionSaves } from './retentionPortability';
import { snapshotWarnings, mergeWarnings } from './senderWarningStore';
import { classifyHistoryPayload } from './historyPayloadFormat';
import { isKlipyRefEntry } from './gifLibrarySync';
/**
 * WebCrypto AES-GCM (256-bit) Blob Encryption Utilities
 * 
 * Provides client-side E2EE for media attachments. The backend MinIO
 * server never receives the raw file, only the cipher-text blob.
 */

export async function generateAesGcmKey(): Promise<CryptoKey> {
    return await window.crypto.subtle.generateKey(
        {
            name: "AES-GCM",
            length: 256
        },
        true, // extractable so we can send it to peers
        ["encrypt", "decrypt"]
    );
}

export async function generateCallKey(): Promise<string> {
    const key = await generateAesGcmKey();
    return await exportKeyToBase64(key);
}

export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
    const exported = await window.crypto.subtle.exportKey("raw", key);
    return bufferToBase64(exported);
}

export async function importKeyFromBase64(base64Key: string): Promise<CryptoKey> {
    const buffer = base64ToBuffer(base64Key) as ArrayBuffer;
    return await window.crypto.subtle.importKey(
        "raw",
        buffer,
        { name: "AES-GCM" },
        false, // not extractable once imported for decryption
        ["encrypt", "decrypt"]
    );
}

export async function encryptBlob(file: Blob, key: CryptoKey, bundleIv: boolean = false): Promise<{ encryptedBlob: Blob, ivB64: string }> {
    // Off the UI thread (falls back to in-thread) — see utils/attachmentCryptoWorker.ts.
    // M9: `bundleIv` prepends the 12-byte IV into the MinIO / on-disk payload.
    return encryptBlobOffThread(file, key, bundleIv);
}

// M6: allowlist of MIME types safe to construct as Blobs — prevents a malicious
// sender from injecting arbitrary types (e.g. text/html, application/javascript).
// image/svg+xml is deliberately excluded — SVGs can embed <script>, and unlike
// the img-tag rendering path here, any future preview surface that moves SVG
// into <object>/<iframe>/inline markup would execute it. imageUploadValidation.ts
// (avatar/banner uploads) already excludes SVG for the same reason; this keeps
// the sender-controlled MIME on attachments (never re-validated against actual
// content) consistent with that policy rather than a landmine waiting on a
// future preview-surface change. Excluded senders fall through to a forced
// download (application/octet-stream) instead of inline image rendering.
const SAFE_MIME_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/apng', 'image/avif',
    // Raster formats Chromium renders natively. None are scriptable, so they
    // carry the same risk profile as the PNG/JPEG above. Their absence meant a
    // .bmp/.ico attachment decrypted to application/octet-stream and rendered
    // as a permanently broken <img>.
    'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm',
    'audio/aac', 'audio/mp4', 'audio/flac', 'audio/x-flac',
    'video/mp4', 'video/webm', 'video/ogg',
    // Containers Chromium will at least attempt (H.264 in a QuickTime wrapper
    // is what every iPhone and most screen recorders produce). Forcing these
    // to octet-stream guaranteed a dead player; passing the real type through
    // lets the browser sniff and usually play it, and when it can't, the
    // player surfaces a real decode error instead of silently showing nothing.
    'video/quicktime', 'video/x-m4v', 'video/mpeg',
    // Matroska/AVI. Chromium plays MKV whenever the streams inside are ones it
    // already supports (H.264/VP9 + AAC/Opus), which covers most real files —
    // it's the container it's fussy about, not usually the contents. Worth
    // attempting: FileViewer falls back to the download card if the decode
    // genuinely fails, so a hopeless file costs one failed <video> load rather
    // than never offering a player at all. Both spellings appear in the wild.
    'video/x-matroska', 'video/matroska', 'video/x-msvideo', 'video/avi',
    'application/pdf', 'text/plain',
    'application/zip', 'application/x-zip-compressed',
    'application/octet-stream',
]);

/**
 * Clamp a sender-controlled MIME to a known-safe set before it becomes a Blob
 * type. Anything unrecognised becomes application/octet-stream, which forces a
 * download rather than inline rendering.
 *
 * Exported because any UI that decides "is this an image / a video" MUST make
 * that decision on the SAME string. FileViewer used to branch on the raw
 * message mime while the blob had been silently downgraded here, so an
 * attachment whose type wasn't on this list rendered a <video>/<img> pointing
 * at an octet-stream blob — a player that would never play and an image that
 * would never load, with no error anywhere. Use this to pick the renderer.
 */
export function sanitizeMime(mime: string): string {
    const lower = (mime || '').toLowerCase().split(';')[0].trim();
    return SAFE_MIME_TYPES.has(lower) ? lower : 'application/octet-stream';
}

export async function decryptBlob(encryptedBlob: Blob, key: CryptoKey, ivB64: string | null, mimeType: string): Promise<Blob> {
    // ivB64 null = IV bundled in the first 12 bytes (M9 offline recovery /
    // saved GIFs). Off the UI thread, falls back to in-thread — see
    // utils/attachmentCryptoWorker.ts. The MIME clamp stays here, before
    // anything leaves this module.
    return decryptBlobOffThread(encryptedBlob, key, ivB64, sanitizeMime(mimeType));
}

// M11: JWK serialization for caching the vault key in localStorage
export async function exportKeyToJWK(key: CryptoKey): Promise<string> {
    const jwk = await window.crypto.subtle.exportKey('jwk', key);
    return JSON.stringify(jwk);
}

export async function importKeyFromJWK(jwkStr: string): Promise<CryptoKey> {
    const jwk = JSON.parse(jwkStr) as JsonWebKey;
    return await window.crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt']
    );
}

/** Version stamp inside the decrypted vault JSON. Bumped whenever the schema
 *  gains new fields. The restore path is additive, so readers from older
 *  versions silently ignore fields they don't know about.
 *  v3 = multi-device selective-history transfer (channelHistory +
 *  attachmentBlobs + transferMeta).
 *  v4 = registry-driven settings (`kv`, `appPrefs`) — see
 *  services/backupRegistry.ts. */
export const VAULT_VERSION = 4;

export interface BackupVault {
    version: number;
    userId: string;
    deviceId: string;
    /** LEGACY — NEVER WRITTEN, NEVER READ. Vaults written before 2026-09-24
     *  carried this device's `cipherline_private_key` / `cipherline_public_key`
     *  pair, which copied per-device key material into every backup and every
     *  device-to-device transfer (CLAUDE.md "Multi-device": nothing is copied
     *  between devices). Typed only so old vaults still parse; the importers
     *  ignore it and each device keeps its own. */
    privateKey?: never;
    publicKey?: never;
    // Message + conversation state (v1 baseline — always present).
    topics: any[];
    history: Record<string, any[]>;
    // Preferences (v2 — all optional so legacy vaults still restore cleanly).
    voiceSettings?: any;
    keybinds?: any;
    gameSettings?: any;
    /** LEGACY (≤ 2026-09): the whole StoragePolicy. Retention is per-device
     *  now, so this is never WRITTEN, and on restore only its saved-id lists
     *  are read (retentionPortability.portableSavesFromVault) — its retention
     *  windows and unsaved lists are ignored. Kept in the type so old vaults
     *  still parse. */
    retentionPolicy?: unknown;
    /** Messages/attachments the user explicitly SAVED ("keep forever"). User
     *  intent about content, not a device setting, so it travels; restore
     *  unions it into this device's policy. See retentionPortability.ts. */
    retentionSaves?: PortableRetentionSaves;
    userStatus?: { status?: string; text?: string; emoji?: string };
    hiddenConversations?: string[];
    mutedConversations?: string[];
    pinnedMessages?: Record<string, string[]>;
    /** Personal per-channel pins, Record<channelId, msgId[]>. Was omitted from
     *  the vault entirely, so a restore or a device migration silently dropped
     *  every channel pin — and, because the range filter keyed off
     *  `pinnedMessages` only, could drop the pinned messages themselves too. */
    localChannelPins?: Record<string, string[]>;
    // GIF library (v2).
    gifFavorites?: any[];
    gifKeys?: Record<string, string>;   // gifId → base64 AES key
    gifFiles?: Record<string, string>;  // gifId → base64 of on-disk `.enc` bytes
    /** LWW ledger for GIF-library sync, `Record<gifId, lastOpAtMs>`. Carried so
     *  a restore keeps its deletion tombstones — without them the next sync
     *  from a device that still holds a deleted GIF would resurrect it. */
    gifLedger?: Record<string, number>;
    // Attachment keys (v2).
    avatarKeys?: Record<string, { keyB64: string; nonceB64: string }>;
    // Channel messages (v3) — Record<channelId, Message[]>. Subject to the
    // same time-range filter as `history` during selective transfer.
    channelHistory?: Record<string, any[]>;
    // Encrypted attachment ciphertext bundle (v3) — attachment_id → base64
    // of the raw encrypted bytes. New device decrypts with `file_key_b64`
    // embedded in the originating message's content. Optional: the source
    // device may omit this if the new device chose "metadata only".
    attachmentBlobs?: Record<string, string>;
    // Selective-transfer metadata (v3) — drives the receiving device's
    // "Restored 142 messages from Desktop · Windows" toast.
    transferMeta?: {
        range_days: number | null;
        include_attachments: boolean;
        included_message_count: number;
        included_attachment_count: number;
        included_byte_size: number;
        exported_at: string;
    };
    /** v4 — every secureLocalStore setting the registry includes
     *  (notification prefs, per-server/channel overrides, home pins,
     *  appearance, privacy, safety-number state, …). Retention overrides
     *  are NOT among them — per-device since 2026-09 — and an old vault's
     *  entries for them are ignored by applyIncludedKv on restore.
     *  keyed portably with `{uid}` in place of the account id. */
    kv?: Record<string, string>;
    /** v4 — Electron SecureStore app preferences (tray, start-minimized,
     *  update channel, custom game list). Never key material. */
    appPrefs?: Record<string, string>;
}

/** Options that drive selective history transfer. When omitted, the export
 *  is unfiltered (V1/V2 behavior) so existing callers like `BackupTool` /
 *  manual export keep working unchanged. */
export interface ExportLocalHistoryOpts {
    /** Time-range filter; `null` = all, omitted = no filtering. */
    rangeDays?: number | null;
    /** Legacy global attachment flag — used by Drive backup. Per-type flags below take
     *  precedence when rangeDays is set; this flag is the fallback for unfiltered exports. */
    includeAttachments?: boolean;
    /** Per-type content flags (all default to true when not set). Only applied when rangeDays is set. */
    includeDmMessages?: boolean;
    includeDmAttachments?: boolean;
    includeGroupMessages?: boolean;
    includeGroupAttachments?: boolean;
    includeServerMessages?: boolean;
    includeServerAttachments?: boolean;
    /** Skip individual attachment blobs larger than this byte threshold. Omit = no limit. */
    maxAttachmentSizeBytes?: number;
    /** Required when any attachments are included — needed to fetch bytes not in IndexedDB. */
    token?: string;
    /** Inline the on-disk GIF library as base64 (`gifFiles`). Defaults to
     *  true. The single-file backup (backupRecords.ts) passes false and
     *  streams the raw `.enc` bytes as their own records instead — no base64
     *  inflation, no giant JSON string. */
    includeGifFiles?: boolean;
    /** Progress callback for the attachment-bundling phase. */
    onAttachmentProgress?: (done: number, total: number, bytes: number) => void;
}

/** Safely JSON.parse; returns `fallback` on invalid/missing data. */
function parseOr<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Scan for this account's `cipherline_gif_key_<uid>_*` entries and emit
 *  `{gifId → base64 key}` — used by the backup to carry GIF decryption keys.
 *
 *  Scoped to `userId`: these keys used to be device-global, so on a machine
 *  with two accounts an unscoped scan put the OTHER account's GIF keys into
 *  this account's vault. The legacy prefix is still read (once, for ids this
 *  account actually owns) so a library saved before the scoping change is not
 *  lost from the first backup taken after it. */
function collectGifKeys(userId: string, ownedIds: Set<string>): Record<string, string> {
    const out: Record<string, string> = {};
    const scoped = `cipherline_gif_key_${userId}_`;
    const legacy = 'cipherline_gif_key_';
    for (let i = 0; i < secureLocalStore.length; i++) {
        const k = secureLocalStore.key(i);
        if (!k) continue;
        if (k.startsWith(scoped)) {
            const v = secureLocalStore.getItem(k);
            if (v) out[k.slice(scoped.length)] = v;
        } else if (k.startsWith(legacy)) {
            // Legacy device-global key: only claim it for an id this account's
            // own favorites list references.
            const id = k.slice(legacy.length);
            if (!ownedIds.has(id) || out[id]) continue;
            const v = secureLocalStore.getItem(k);
            if (v) out[id] = v;
        }
    }
    return out;
}

/** Base64-encode a Uint8Array without intermediate large strings. */
function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    return window.btoa(binary);
}

/** Pull every on-disk encrypted GIF file via IPC and emit
 *  `{gifId → base64 bytes}`. Safe no-op if electronAPI is unavailable. */
async function collectGifFiles(ownedIds?: Set<string>): Promise<Record<string, string>> {
    const api = (window as any).electronAPI;
    if (!api?.listGifFiles || !api?.readGifFile) return {};
    try {
        const all: string[] = await api.listGifFiles();
        // The gif directory is shared by every account on the machine, so an
        // unfiltered read would pack another account's (undecryptable) blobs
        // into this account's vault. Keep only what this library references.
        const ids = ownedIds ? all.filter(id => ownedIds.has(id)) : all;
        const out: Record<string, string> = {};
        for (const id of ids) {
            try {
                const buf: Uint8Array = await api.readGifFile(id);
                out[id] = u8ToBase64(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
            } catch (e) {
                console.warn('[backup] failed to read gif', id, e);
            }
        }
        return out;
    } catch { return {}; }
}

/** Pull every avatar_key:* entry from the Electron secure store via IPC. */
async function collectAvatarKeys(): Promise<Record<string, { keyB64: string; nonceB64: string }>> {
    const api = (window as any).electronAPI;
    if (!api?.listAvatarKeys) return {};
    try { return await api.listAvatarKeys(); } catch { return {}; }
}

/** App-level preferences held in the Electron SecureStore (registry
 *  APP_PREF_KEYS). Only those keys — never anything else in that store. */
async function collectAppPrefs(): Promise<Record<string, string>> {
    const api = window.electronAPI;
    if (!api?.secureGetMany) return {};
    try {
        const got = await api.secureGetMany([...APP_PREF_KEYS]);
        const out: Record<string, string> = {};
        for (const k of APP_PREF_KEYS) if (typeof got?.[k] === 'string') out[k] = got[k]!;
        return out;
    } catch { return {}; }
}

/**
 * Build the full encrypted-backup payload for a given user. Pulls every
 * client-side state slice that should follow the user across reinstalls — see
 * `/home/antigravity/.claude/plans/glistening-churning-valiant.md` for the
 * in-scope / out-of-scope matrix.
 *
 * V3 selective transfer: when `opts.rangeDays` is provided, only messages
 * (DM/group + channel) within the window are included. Pinned messages
 * bypass the filter. When `opts.includeAttachments` is true, the encrypted
 * ciphertext for every referenced attachment is bundled into the vault so
 * the receiving device can view files offline.
 *
 * Async because it reaches into the main process via IPC to pull avatar keys
 * and on-disk GIF files.
 */
export async function exportLocalHistory(
    userId: string,
    opts: ExportLocalHistoryOpts = {},
): Promise<Blob> {
    return new Blob([JSON.stringify(await buildLocalVault(userId, opts))], { type: 'application/json' });
}

/**
 * The vault `exportLocalHistory` serialises, as an object. The scheduled backup
 * (services/backupRecords.ts) consumes it directly: it used to take the Blob,
 * read it back as text and JSON.parse it — two synchronous passes over the
 * user's ENTIRE message history on the UI thread, on top of the per-record
 * serialisation it needs anyway. Every value in here comes from fresh
 * JSON.parse calls (messageStore.loadAll, secureLocalStore reads), so it is
 * plain JSON data and nothing else holds a reference to it.
 */
export async function buildLocalVault(
    userId: string,
    opts: ExportLocalHistoryOpts = {},
): Promise<BackupVault> {
    const topics = parseOr<any[]>(secureLocalStore.getItem(`cipherline_convs_${userId}`), []);
    // Read through messageStore so the export sees every per-conversation
    // record (and migrates a legacy blob first if this device still has one).
    // Awaiting matters: history hydrates in secureLocalStore's second phase, so
    // a synchronous read could silently produce an EMPTY backup — the kind of
    // failure that only surfaces when someone tries to restore it.
    const fullHistory = await messageStore.loadAll('dm', userId);
    const fullChannelHistory = await messageStore.loadAll('channel', userId);
    const pinnedMessages = parseOr<Record<string, string[]>>(secureLocalStore.getItem(`cipherline_pinned_${userId}`), {});
    // Personal channel pins. Same Record<containerId, msgId[]> shape as the
    // DM/group map above, but keyed by channel_id — which is exactly why it
    // needs its own pin set below: `pinnedMessages` only ever holds
    // conversation ids, so it protects nothing in the channel history.
    const localChannelPins = parseOr<Record<string, string[]>>(secureLocalStore.getItem(`cipherline_local_channel_pins_${userId}`), {});
    // GIF library metadata. Read from the account-scoped key, falling back to
    // the pre-scoping device-global one so a library saved before the split is
    // still captured by the first backup taken after it.
    const gifFavorites = ((): any[] => {
        const scoped = parseOr<any[]>(secureLocalStore.getItem(`cipherline_gif_favorites_${userId}`), []);
        if (Array.isArray(scoped) && scoped.length > 0) return scoped;
        const legacy = parseOr<any[]>(secureLocalStore.getItem('cipherline_gif_favorites'), []);
        return Array.isArray(legacy) ? legacy : [];
    })();

    // `cipherline_private_key` / `cipherline_public_key` are deliberately NOT
    // read here. They are this device's own keypair; every vault used to carry
    // them, so any backup or transfer handed one device's private key to the
    // next. See BackupVault.privateKey.
    const deviceId = secureLocalStore.getItem('cipherline_device_id') || '';

    // Apply the range filter when caller asked for selective transfer.
    let history = fullHistory;
    let channelHistory = fullChannelHistory;
    let transferMeta: BackupVault['transferMeta'] | undefined;
    let attachmentBlobs: Record<string, string> | undefined;

    if (opts.rangeDays !== undefined) {
        // Lazy-imported to avoid a circular dep — historyTransfer reaches into
        // attachmentCache.ts which already lives downstream of crypto.ts.
        const { filterMessagesByRange, buildPinnedSet, collectAttachmentBlobs, countMessages, partitionHistoryByType } =
            await import('./historyTransfer');
        const pinSet = buildPinnedSet(pinnedMessages);
        // Channel history is keyed by channel_id, so it needs the channel pin
        // map — passing `pinSet` here (as this did) exempted nothing, and a
        // locally pinned channel message older than rangeDays was trimmed out
        // of its own backup.
        const channelPinSet = buildPinnedSet(localChannelPins);

        // Per-type filtering: split DM/group history, apply per-type flags.
        const hasPerTypeFlags = opts.includeDmMessages !== undefined
            || opts.includeGroupMessages !== undefined
            || opts.includeServerMessages !== undefined;

        if (hasPerTypeFlags) {
            const { dm: dmHistory, group: groupHistory } = partitionHistoryByType(fullHistory, topics);
            const mergedForMessages: Record<string, any[]> = {
                ...(opts.includeDmMessages !== false ? dmHistory : {}),
                ...(opts.includeGroupMessages !== false ? groupHistory : {}),
            };
            history = filterMessagesByRange(mergedForMessages, opts.rangeDays, pinSet);
            channelHistory = opts.includeServerMessages !== false
                ? filterMessagesByRange(fullChannelHistory, opts.rangeDays, channelPinSet)
                : {};
        } else {
            history = filterMessagesByRange(fullHistory, opts.rangeDays, pinSet);
            channelHistory = filterMessagesByRange(fullChannelHistory, opts.rangeDays, channelPinSet);
        }

        let attachmentCount = 0;
        let byteSize = 0;
        const wantAttachments = opts.token && (opts.includeAttachments
            || opts.includeDmAttachments !== false
            || opts.includeGroupAttachments !== false
            || opts.includeServerAttachments !== false);

        if (wantAttachments && opts.token) {
            // Build per-type attachment history views when per-type flags are set.
            let attHistory = history;
            let attChannelHistory = channelHistory;
            if (hasPerTypeFlags) {
                const { dm: dmH, group: grpH } = partitionHistoryByType(history, topics);
                attHistory = {
                    ...(opts.includeDmAttachments !== false ? dmH : {}),
                    ...(opts.includeGroupAttachments !== false ? grpH : {}),
                };
                attChannelHistory = opts.includeServerAttachments !== false ? channelHistory : {};
            }
            const r = await collectAttachmentBlobs(
                attHistory,
                attChannelHistory,
                opts.token,
                opts.onAttachmentProgress,
                opts.maxAttachmentSizeBytes,
            );
            attachmentBlobs = r.blobs;
            attachmentCount = r.count;
            byteSize = r.totalBytes;
        }

        transferMeta = {
            range_days: opts.rangeDays,
            include_attachments: !!wantAttachments,
            included_message_count: countMessages(history) + countMessages(channelHistory),
            included_attachment_count: attachmentCount,
            included_byte_size: byteSize,
            exported_at: new Date().toISOString(),
        };
    }

    const vault: BackupVault = {
        version: VAULT_VERSION,
        userId,
        deviceId,
        topics,
        history,
        channelHistory: Object.keys(channelHistory).length > 0 ? channelHistory : undefined,

        voiceSettings:       parseOr<any>(secureLocalStore.getItem('cipherline_voice_settings'),  null) ?? undefined,
        keybinds:            parseOr<any>(secureLocalStore.getItem('cipherline_keybinds'),        null) ?? undefined,
        gameSettings:        parseOr<any>(secureLocalStore.getItem(`cipherline_game_settings_${userId}`) ?? secureLocalStore.getItem('cipherline_game_settings'), null) ?? undefined,
        // Retention SETTINGS are per-device and deliberately not exported —
        // only the explicitly-saved ids travel (retentionPortability.ts).
        retentionSaves:      extractPortableSaves(secureLocalStore.getItem(`cipherline_storage_policy_${userId}`)),
        userStatus:          (() => {
            const status = secureLocalStore.getItem(`cipherline_status_${userId}`);
            const text   = secureLocalStore.getItem(`cipherline_status_text_${userId}`);
            const emoji  = secureLocalStore.getItem(`cipherline_status_emoji_${userId}`);
            if (!status && !text && !emoji) return undefined;
            return {
                status: status ?? undefined,
                text:   text   ?? undefined,
                emoji:  emoji  ?? undefined,
            };
        })(),
        hiddenConversations: parseOr<string[]>(secureLocalStore.getItem(`cipherline_hidden_convs_${userId}`), []),
        mutedConversations:  parseOr<string[]>(secureLocalStore.getItem(`cipherline_muted_convs_${userId}`),  []),
        pinnedMessages,
        localChannelPins,

        gifFavorites: gifFavorites,
        gifKeys: collectGifKeys(userId, new Set(gifFavorites.map(g => g?.id).filter(Boolean))),
        gifLedger: parseOr<Record<string, number>>(secureLocalStore.getItem(`cipherline_gif_ledger_${userId}`), {}),
        // KLIPY references have no file and must never gain one in a backup
        // (KLIPY's terms: store the reference, not the media).
        gifFiles: opts.includeGifFiles === false
            ? undefined
            : await collectGifFiles(new Set(gifFavorites.filter(g => !isKlipyRefEntry(g)).map(g => g?.id).filter(Boolean))),

        avatarKeys: await collectAvatarKeys(),

        attachmentBlobs,
        transferMeta,

        // v4: everything else the registry says follows the user.
        kv: collectIncludedKv(secureLocalStore, userId),
        appPrefs: await collectAppPrefs(),
    };

    return vault;
}

export async function importLocalHistory(userId: string, blob: Blob): Promise<void> {
    const text = await blob.text();

    // Classify and validate the WHOLE payload before the first write — see
    // utils/historyPayloadFormat.ts. This used to branch on
    // `!!(vault.history && vault.topics)` and treat everything else as the
    // pre-wrapper bare dump, which cleared this account's DM history before
    // looking at what it had been handed: a mobile vault (no `topics`) wiped
    // the desktop's DMs and imported nothing. Every refusal (mobile format,
    // another account, a missing account id, a damaged or foreign file)
    // throws from here, with nothing on this device changed.
    const payload = classifyHistoryPayload(text, userId);

    if (payload.kind === 'legacy-bare') {
        // Genuine pre-wrapper dump (no envelope, so no account id to bind):
        // `text` is the raw history JSON. Rather than re-serialise it, clear the
        // account and hand the blob to the legacy slot, which messageStore
        // splits into per-thread records on the next read. The clear is what
        // keeps this a replace rather than a merge.
        messageStore.clearAll('dm', userId);
        secureLocalStore.setItem(`cipherline_msgs_${userId}`, text);
        return;
    }

    const vault = payload.vault;

    // replaceAll, not a merge: a restore has to be authoritative. A
    // conversation absent from the vault must not survive underneath it.
    //
    // `vault.privateKey` / `vault.publicKey` (old vaults only) are deliberately
    // never read: that pair belongs to the device that exported it, and this
    // device keeps its own. See BackupVault.privateKey.
    messageStore.replaceAll('dm', userId, vault.history);
    secureLocalStore.setItem(`cipherline_convs_${userId}`, JSON.stringify(vault.topics));

    // V3: channel messages, mirroring the DM/group history slot.
    if (vault.channelHistory && typeof vault.channelHistory === 'object') {
        messageStore.replaceAll('channel', userId, vault.channelHistory);
    }

    // V3: rehydrate attachment ciphertexts into IndexedDB so they decrypt
    // without round-tripping to MinIO (the server may have already swept them).
    if (vault.attachmentBlobs && typeof vault.attachmentBlobs === 'object') {
        try {
            const { base64ToBlob } = await import('./historyTransfer');
            const { putEncryptedAttachment } = await import('./attachmentCache');
            const entries = Object.entries(vault.attachmentBlobs as Record<string, string>);
            for (const [id, b64] of entries) {
                try {
                    const blob = base64ToBlob(b64);
                    await putEncryptedAttachment(id, blob);
                } catch (e) {
                    console.warn('[importLocalHistory] failed to rehydrate attachment', id, e);
                }
            }
        } catch (e) {
            console.warn('[importLocalHistory] attachment rehydrate skipped:', e);
        }
    }

    // V2 carryovers (prefs, GIFs, avatar keys). Each is optional so legacy
    // vaults restore cleanly without these fields.
    if (vault.voiceSettings)   secureLocalStore.setItem('cipherline_voice_settings',                JSON.stringify(vault.voiceSettings));
    if (vault.keybinds)        secureLocalStore.setItem('cipherline_keybinds',                     JSON.stringify(vault.keybinds));
    if (vault.gameSettings)    secureLocalStore.setItem(`cipherline_game_settings_${userId}`,      JSON.stringify(vault.gameSettings));
    // Retention is per-device: a vault's retention windows (legacy
    // `retentionPolicy`) are NEVER applied — this device keeps whatever it
    // chose (or asks, via the first-run storage prompt). Only explicitly
    // saved ids are merged in, and only additively. See retentionPortability.ts.
    applyRestoredSaves(userId, portableSavesFromVault(vault));
    if (vault.hiddenConversations) secureLocalStore.setItem(`cipherline_hidden_convs_${userId}`,   JSON.stringify(vault.hiddenConversations));
    if (vault.mutedConversations)  secureLocalStore.setItem(`cipherline_muted_convs_${userId}`,    JSON.stringify(vault.mutedConversations));
    if (vault.pinnedMessages)      secureLocalStore.setItem(`cipherline_pinned_${userId}`,         JSON.stringify(vault.pinnedMessages));
    if (vault.localChannelPins)   secureLocalStore.setItem(`cipherline_local_channel_pins_${userId}`, JSON.stringify(vault.localChannelPins));
    if (vault.userStatus?.status) secureLocalStore.setItem(`cipherline_status_${userId}`,          vault.userStatus.status);
    if (vault.userStatus?.text)   secureLocalStore.setItem(`cipherline_status_text_${userId}`,     vault.userStatus.text);
    if (vault.userStatus?.emoji)  secureLocalStore.setItem(`cipherline_status_emoji_${userId}`,    vault.userStatus.emoji);

    // Restore into the account-scoped namespace, never the legacy device-global
    // keys — writing those back would re-share this account's library with every
    // other account on the machine.
    if (vault.gifFavorites) secureLocalStore.setItem(`cipherline_gif_favorites_${userId}`, JSON.stringify(vault.gifFavorites));
    if (vault.gifLedger) secureLocalStore.setItem(`cipherline_gif_ledger_${userId}`, JSON.stringify(vault.gifLedger));
    if (vault.gifKeys) {
        for (const [id, keyB64] of Object.entries(vault.gifKeys as Record<string, string>)) {
            secureLocalStore.setItem(`cipherline_gif_key_${userId}_${id}`, keyB64);
        }
    }
    if (vault.gifFiles && window.electronAPI?.writeGifFile) {
        for (const [id, b64] of Object.entries(vault.gifFiles as Record<string, string>)) {
            try {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                await window.electronAPI.writeGifFile(id, bytes);
            } catch (e) {
                console.warn('[importLocalHistory] failed to write gif file', id, e);
            }
        }
    }
    if (vault.avatarKeys && window.electronAPI?.setAvatarKey) {
        for (const [attId, v] of Object.entries(vault.avatarKeys as Record<string, { keyB64: string; nonceB64: string }>)) {
            try { await window.electronAPI.setAvatarKey(attId, v.keyB64, v.nonceB64); }
            catch (e) { console.warn('[importLocalHistory] failed to save avatar key', attId, e); }
        }
    }

    // V4: registry-driven settings. applyIncludedKv only writes keys the
    // registry includes, so a crafted vault can't plant session material.
    //
    // ONE key is not a straight overwrite: unresolved sender-identity
    // warnings. A backup is a snapshot of an earlier moment, and replacing the
    // warning record with it would drop every alarm raised on this device
    // since — the recovery path silencing a live "their key changed" warning
    // while restoring, in the same breath, the pins that make the contact look
    // verified again. So snapshot the local record first and union it back
    // afterwards. See senderWarningStore.mergeWarnings for the full argument,
    // including why the converse (a warning the user already resolved coming
    // back from an old backup) is the acceptable direction: it is one click to
    // dismiss, and loadWarnings retires it automatically if the resolution was
    // an out-of-band verification, because the restored pins carry that.
    const localWarnings = snapshotWarnings(userId);
    if (vault.kv && typeof vault.kv === 'object') {
        applyIncludedKv(secureLocalStore, vault.kv as Record<string, string>, userId);
    }
    mergeWarnings(userId, localWarnings);
    if (vault.appPrefs && typeof vault.appPrefs === 'object' && window.electronAPI?.secureReplaceMany) {
        const entries: Record<string, string> = {};
        for (const k of APP_PREF_KEYS) {
            const v = (vault.appPrefs as Record<string, unknown>)[k];
            if (typeof v === 'string') entries[k] = v;
        }
        if (Object.keys(entries).length) {
            try { await window.electronAPI.secureReplaceMany(entries); }
            catch (e) { console.warn('[importLocalHistory] failed to apply app prefs', e); }
        }
    }
    // Notification prefs reference custom sound files by absolute path on
    // the machine that exported them. Re-point them at this machine's copies
    // (restored just before this by the container reader) or fall back to
    // the bundled default so nothing references a file that isn't here.
    await repairCustomSoundPaths(userId);
}

async function repairCustomSoundPaths(userId: string): Promise<void> {
    const key = `cipherline_notif_global_prefs_${userId}`;
    const raw = secureLocalStore.getItem(key);
    if (!raw) return;
    try {
        const prefs = JSON.parse(raw);
        const available = await window.electronAPI?.listCustomSounds?.().catch(() => []) ?? [];
        // Lazy: previously pulled DEFAULT_PREFS from NotificationContext
        // (which imports React) and rebuilt a category→file map from it by
        // hand. DEFAULT_SOUNDS is that same map already, one level lower —
        // notificationSounds.ts has no React dependency, but the import stays
        // dynamic to keep this module's static graph unchanged.
        const { DEFAULT_SOUNDS } = await import('./notificationSounds');
        const repaired = repairSoundPaths(prefs, available, DEFAULT_SOUNDS);
        if (repaired.changed) secureLocalStore.setItem(key, JSON.stringify(repaired.prefs));
    } catch (e) {
        console.warn('[importLocalHistory] could not repair custom sound paths', e);
    }
}

// Helpers
function bufferToBase64(buffer: ArrayBuffer | ArrayBufferLike): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
}

export function utf8ToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
    return btoa(binString);
}

export function base64ToUtf8(b64: string): string {
    const binString = atob(b64);
    const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0)!);
    return new TextDecoder().decode(bytes);
}

// ============================================================================
// Local Recovery Backup Protocol
//
// v1 (legacy): [16-byte salt][12-byte IV][ciphertext]
//              PBKDF2-SHA-256 / 100 000 iterations
// v2 (current): [0x43 0x4C 0x02][16-byte salt][12-byte IV][ciphertext]
//              PBKDF2-SHA-512 / 600 000 iterations
//              Magic "CL" prefix distinguishes v2 from v1.
//
// TODO post-launch: replace PBKDF2 with Argon2id (hash-wasm) for memory-hard
// resistance; add v3 format byte.
// ============================================================================

const BACKUP_MAGIC = new Uint8Array([0x43, 0x4c, 0x02]); // "CL" + version 2

/** Derive an AES-256-GCM key via PBKDF2. Exported (was a private `deriveKey`)
 *  so callers that need to encrypt/decrypt MANY ciphertexts sharing one
 *  backup generation — incrementalBackup.ts's per-chunk files — can derive
 *  ONCE and reuse the CryptoKey, instead of paying PBKDF2's 600k iterations
 *  again for every chunk. AES-GCM itself is cheap; PBKDF2 is the expensive
 *  part this is designed to amortize. Also reused by other local-only PIN/
 *  password verifiers (e.g. useScreenLock.ts) instead of hand-rolling their
 *  own PBKDF2 setup. */
export async function deriveBackupKey(
    password: string,
    salt: Uint8Array,
    iterations: number,
    hash: 'SHA-256' | 'SHA-512',
): Promise<CryptoKey> {
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey'],
    );
    return window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

export interface ParsedBackupHeader {
    salt: Uint8Array;
    iv: Uint8Array;
    ct: ArrayBuffer;
    iterations: number;
    hash: 'SHA-256' | 'SHA-512';
}

/** Parse a v1/v2 recovery-backup blob's header (salt/IV/ciphertext/KDF
 *  params) WITHOUT decrypting or needing a password — the salt and KDF
 *  params are public metadata by design (standard PBKDF2 practice). Returns
 *  null if the buffer is too small to be a valid blob of either format.
 *  Exported so incrementalBackup.ts can recover an EXISTING manifest's salt
 *  (to reuse the same key for content-addressed chunk dedup across backup
 *  runs) without duplicating this format-detection logic. */
export function parseBackupHeader(buf: ArrayBuffer): ParsedBackupHeader | null {
    const data = new Uint8Array(buf);
    const isV2 = data.length > 3
        && data[0] === BACKUP_MAGIC[0]
        && data[1] === BACKUP_MAGIC[1]
        && data[2] === BACKUP_MAGIC[2];

    if (isV2) {
        if (data.length < 31) return null;
        return {
            salt: data.slice(3, 19),
            iv: data.slice(19, 31),
            ct: buf.slice(31),
            iterations: 600_000,
            hash: 'SHA-512',
        };
    }
    // v1 legacy: no magic, straight [salt 16B][IV 12B][ciphertext]
    if (data.length < 28) return null;
    return {
        salt: data.slice(0, 16),
        iv: data.slice(16, 28),
        ct: buf.slice(28),
        iterations: 100_000,
        hash: 'SHA-256',
    };
}

/** Encrypt with an ALREADY-DERIVED key + a fresh random IV. Returns
 *  [12-byte IV][ciphertext] — no salt/magic prefix, since the caller is
 *  expected to already know (and separately persist, e.g. in a manifest's
 *  own self-contained header) which key/salt this belongs to. Reusing one
 *  derived key with a fresh IV per call is the standard, safe way to
 *  encrypt many messages under AES-GCM — IVs never repeat under the same
 *  key as long as they're drawn fresh from getRandomValues each time,
 *  which they are here. Used by incrementalBackup.ts for per-chunk
 *  encryption. */
export async function encryptWithKey(payload: string, key: CryptoKey): Promise<Uint8Array> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out;
}

/** Inverse of `encryptWithKey` — expects [12-byte IV][ciphertext]. Throws
 *  on AES-GCM auth-tag mismatch (wrong key or corrupted/tampered data). */
export async function decryptWithKey(bytes: Uint8Array, key: CryptoKey): Promise<string> {
    if (bytes.length < 13) throw new Error('Chunk too small to be a valid encrypted payload');
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
}

export async function encryptBackup(payload: string, password: string): Promise<Blob> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key  = await deriveBackupKey(password, salt, 600_000, 'SHA-512');
    const ivAndCt = await encryptWithKey(payload, key); // [12B IV][ciphertext]

    // v2 format: [magic 3B][salt 16B][IV 12B][ciphertext]
    const out = new Uint8Array(3 + 16 + ivAndCt.length);
    out.set(BACKUP_MAGIC, 0);
    out.set(salt, 3);
    out.set(ivAndCt, 19);
    return new Blob([out], { type: 'application/octet-stream' });
}

export async function decryptBackup(blob: Blob, password: string): Promise<string> {
    const buf = await blob.arrayBuffer();
    const header = parseBackupHeader(buf);
    if (!header) throw new Error('Backup file too small');

    const key = await deriveBackupKey(password, header.salt, header.iterations, header.hash);
    const pt  = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.iv as any }, key, header.ct);
    return new TextDecoder().decode(pt);
}

// ============================================================================
// Zero-Knowledge WebRTC Signaling 
// ============================================================================

export async function encryptSignalingPayload(payload: any, key: CryptoKey): Promise<string> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const str = JSON.stringify(payload);
    const enc = new TextEncoder();

    const ciphertext = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        key,
        enc.encode(str)
    );

    // Bundle IV + Ciphertext
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);

    return bufferToBase64(combined.buffer as ArrayBuffer);
}

export async function decryptSignalingPayload(bundledB64: string, key: CryptoKey): Promise<any> {
    const combined = new Uint8Array(base64ToBuffer(bundledB64));
    const iv = new Uint8Array(combined.buffer.slice(0, 12) as ArrayBuffer);
    const ciphertext = combined.buffer.slice(12) as ArrayBuffer;

    const plaintext = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        key,
        ciphertext
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintext));
}
