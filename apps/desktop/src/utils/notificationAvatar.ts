/**
 * notificationAvatar — the sender's profile picture on OS notifications.
 *
 * Two halves, kept apart so the rules are testable without a DOM:
 *
 *   1. `selectNotificationAvatarId` — PURE. Decides WHETHER a toast may carry
 *      an avatar and WHICH attachment it is. It never causes a request.
 *   2. `getNotificationIconDataUrl` — turns that attachment into a small
 *      circle-cropped PNG data URL for the main process, from caches only.
 *
 * ── Privacy rules (selection) ───────────────────────────────────────────────
 *   - Only when the toast shows the FULL message (`show_preview: 'full'`).
 *     Owner decision 2026-10-08: anyone who turns message content off in
 *     notification settings — 'sender_only' as well as 'hidden' — gets no
 *     picture either.
 *   - Its own opt-out, `show_sender_avatar`, for anyone who wants names but not
 *     faces in their OS notification history.
 *   - The same friend-or-self gate EncryptedAvatar applies on screen. A
 *     stranger in a server channel renders as the coloured silhouette in the
 *     chat, so their picture must not appear in a toast either. Blocked users
 *     are not accepted friends, so they fall out here too. The gate FAILS
 *     CLOSED: no gate supplied → no avatar.
 *   - Only plain attachment ids. An `http(s):`, `data:` or `blob:` value is not
 *     something the E2EE avatar cache holds and would need other handling.
 *
 * ── No network, ever (rendering) ────────────────────────────────────────────
 * The picture comes from the session memory cache (`peekAvatarUrl`), or failing
 * that the persistent encrypted blob cache via `warmAvatarsFromDiskCache` —
 * which by construction makes no request. If neither has it, the toast goes
 * out with the generic app icon: a notification is never held for a download,
 * and raising one never tells the server whose avatar we wanted.
 *
 * The wait is bounded (NOTIF_ICON_WAIT_MS). Work that outlives it still lands
 * in the small icon cache, so the next toast from that person has it.
 *
 * ── What crosses to main ────────────────────────────────────────────────────
 * Only the 96x96 PNG data URL. Main re-validates it (electron/notificationIcon.ts)
 * and falls back to the app icon on anything unexpected. This module writes
 * nothing to disk; see electron/notifications.ts for what the OS notification
 * plumbing itself does with the image on Windows and macOS.
 */

export type ShowPreview = 'full' | 'sender_only' | 'hidden';

export interface NotifAvatarSelectionInput {
    /** NotificationPrefs.show_preview. */
    showPreview: ShowPreview;
    /** NotificationPrefs.show_sender_avatar (undefined on old blobs = on). */
    showSenderAvatar: boolean | undefined;
    /** The person who sent the message / placed the call. */
    senderUserId: string | null | undefined;
    /** An avatar attachment id the caller already has (e.g. the call path's profile fetch). */
    avatarIdHint?: string | null;
    /** Synchronous, network-free id lookup (peerIdentityCache.lookupUserAvatarId). */
    lookupAvatarId: (userId: string) => string | null;
    /** EncryptedAvatar's friend-or-self gate. Missing → no avatar (fail closed). */
    isFriendOrSelf: ((userId: string) => boolean) | null | undefined;
}

function isPlainAttachmentId(id: string): boolean {
    return !/^(https?:|data:|blob:)/i.test(id);
}

/** Which avatar attachment (if any) this toast may show. Pure. */
export function selectNotificationAvatarId(input: NotifAvatarSelectionInput): string | null {
    if (input.showPreview !== 'full') return null;
    if (input.showSenderAvatar === false) return null;
    const uid = input.senderUserId;
    if (!uid) return null;
    if (!input.isFriendOrSelf || !input.isFriendOrSelf(uid)) return null;
    const id = (input.avatarIdHint || null) ?? input.lookupAvatarId(uid);
    if (!id || typeof id !== 'string' || !isPlainAttachmentId(id)) return null;
    return id;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Edge of the PNG sent to main. 48 logical px on a Windows toast at 200 %. */
export const NOTIF_ICON_SIZE = 96;
/** Longest a toast waits for its avatar before going out with the app icon. */
export const NOTIF_ICON_WAIT_MS = 250;
/** Rendered icons kept in memory (one per recent sender). */
export const NOTIF_ICON_CACHE_MAX = 32;

export interface NotifIconDeps {
    /** Session memory cache: decrypted blob URL or null (peekAvatarUrl). */
    peek: (attachmentId: string) => string | null;
    /** Network-free refill of the memory cache from the encrypted disk cache. */
    warmFromDisk: (attachmentId: string) => Promise<unknown>;
    /** Draw `url` to a size x size circle and return a PNG data URL. */
    rasterize: (url: string, size: number) => Promise<string | null>;
}

const iconCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function remember(id: string, dataUrl: string): void {
    iconCache.delete(id);
    iconCache.set(id, dataUrl);
    while (iconCache.size > NOTIF_ICON_CACHE_MAX) {
        const oldest = iconCache.keys().next().value;
        if (oldest === undefined) break;
        iconCache.delete(oldest);
    }
}

async function produce(id: string, deps: NotifIconDeps): Promise<string | null> {
    let url = deps.peek(id);
    if (!url) {
        try { await deps.warmFromDisk(id); } catch { /* a miss */ }
        url = deps.peek(id);
    }
    if (!url) return null;
    const dataUrl = await deps.rasterize(url, NOTIF_ICON_SIZE);
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
        remember(id, dataUrl);
        return dataUrl;
    }
    return null;
}

/**
 * The toast icon for an avatar attachment, from caches only, within
 * `waitMs`. Resolves null (→ app icon) on a miss, a failure or a timeout.
 */
export function getNotificationIconDataUrl(
    attachmentId: string,
    deps: NotifIconDeps,
    waitMs: number = NOTIF_ICON_WAIT_MS,
): Promise<string | null> {
    const hit = iconCache.get(attachmentId);
    if (hit) { remember(attachmentId, hit); return Promise.resolve(hit); }

    let work = inFlight.get(attachmentId);
    if (!work) {
        work = produce(attachmentId, deps)
            .catch(() => null)
            .finally(() => { inFlight.delete(attachmentId); });
        inFlight.set(attachmentId, work);
    }
    return new Promise<string | null>(resolve => {
        const timer = setTimeout(() => resolve(null), waitMs);
        work!.then(v => { clearTimeout(timer); resolve(v); });
    });
}

/** Tests only. */
export function __resetNotificationIconCache(): void {
    iconCache.clear();
    inFlight.clear();
}

// ── Toast ordering ───────────────────────────────────────────────────────────

/**
 * Toasts replace each other per conversation (`notif_<conv_id>`). Once one of
 * them can wait for its avatar, a slow avatar toast could land AFTER a newer
 * toast for the same conversation and replace it with stale text. Each show
 * takes a ticket; a ticket that is no longer the latest for its id is dropped.
 */
export function createToastSequencer(): (id: string) => () => boolean {
    const latest = new Map<string, number>();
    let n = 0;
    return (id: string) => {
        const mine = ++n;
        latest.set(id, mine);
        return () => latest.get(id) === mine;
    };
}

// ── Browser defaults ─────────────────────────────────────────────────────────

/** Centre-crop to a square, clip to a circle (Windows renders it uncropped). */
export async function rasterizeCircleIcon(url: string, size: number): Promise<string | null> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const side = Math.min(w, h);
    if (!side) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/png');
}
