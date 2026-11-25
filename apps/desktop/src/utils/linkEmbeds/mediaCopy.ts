/**
 * The sender's COPY of linked media (2026-11-24, embeds-media-everywhere).
 *
 * Some media links stop working: a Discord CDN attachment link carries a
 * signature (`?ex=…&is=…&hm=…`) that expires, after which every reader gets a
 * 404 (the owner's "invisible message"). For such a link (main's unfurler
 * decides: electron/unfurl/media-sniff.ts isExpiringMediaUrl) the sender's app
 * downloads the file while the message is being written (main, embed:media-copy,
 * capped and sniffed), encrypts it like any attachment at send and puts its key
 * in the embed (`media.file`, packages/shared link-embeds.ts). Readers then show
 * / play the decrypted copy and never contact the linked host, for as long as
 * the message's attachments are kept.
 *
 * Size caps: LINK_EMBED_MEDIA_COPY_MAX_BYTES (an image or GIF up to 8 MB, a
 * video up to 25 MB), and never more than the account's own upload limit
 * (setMediaCopyUploadLimit: the free tier's per-file cap is 100 MB today, so
 * the caps above bind). A larger file is not copied: the embed keeps the link.
 *
 * What it costs: the copy is an ordinary attachment, so it counts like one:
 * against the sender's per-file upload cap and the rolling upload quota
 * (apps/api upload-quota.ts), it is kept for the attachment retention period,
 * and it is in the sender's / readers' encrypted backups like any attachment.
 */
import { LINK_EMBED_MEDIA_COPY_MAX_BYTES, linkEmbedCopyCap, type EmbedImage } from '@cipherline/shared';
import { sniffImageMime } from './thumb';

/** Room left for encryption overhead under the account's per-file limit. */
const UPLOAD_MARGIN = 64 * 1024;
let uploadLimit = Infinity;

/** The account's per-file upload limit (useSubscription().maxUploadBytes); copies never exceed it. */
export function setMediaCopyUploadLimit(maxUploadBytes: number | null | undefined): void {
    uploadLimit = typeof maxUploadBytes === 'number' && maxUploadBytes > 0 ? maxUploadBytes : Infinity;
}

/** The most a copy of a file of this type may be. */
export function mediaCopyMaxBytes(mime: string): number {
    return Math.max(0, Math.min(linkEmbedCopyCap(mime), uploadLimit - UPLOAD_MARGIN));
}

export { LINK_EMBED_MEDIA_COPY_MAX_BYTES };

/** The type of a media file's first bytes, for checking a decrypted copy; null when it is not media. */
export function sniffMediaMime(b: Uint8Array): string | null {
    const img = sniffImageMime(b);
    if (img) return img;
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
        const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
        return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
    return null;
}

/** Do decrypted bytes really match the declared media type? (mp4 / QuickTime are one family.) */
export function copyMatchesMime(declared: string, head: Uint8Array): boolean {
    const got = sniffMediaMime(head);
    if (!got) return false;
    const fam = (m: string) => (m === 'video/quicktime' ? 'video/mp4' : m);
    return fam(got) === fam(declared);
}

// ── Uploads that outlive the send deadline ───────────────────────────────────

type Ref = Pick<EmbedImage, 'attachment_id' | 'file_key_b64' | 'file_nonce_b64' | 'byte_size'>;
const uploads = new WeakMap<Blob, Promise<Ref>>();

/**
 * Upload `blob` once: a copy whose upload missed the send deadline keeps going,
 * and the late attach (lateAttach.ts) awaits the SAME upload instead of
 * starting a second one. A failed upload is forgotten (a later call retries).
 */
export function uploadOnce(upload: (blob: Blob) => Promise<Ref>, blob: Blob): Promise<Ref> {
    const hit = uploads.get(blob);
    if (hit) return hit;
    const p = upload(blob);
    uploads.set(blob, p);
    p.catch(() => { if (uploads.get(blob) === p) uploads.delete(blob); });
    return p;
}

// ── Which links are waiting for their copy ───────────────────────────────────

const pending = new Map<string, number>();
const PENDING_TTL_MS = 120_000;

/** A copy of this link's media is being made (the late attach waits longer for it). */
export function markCopyPending(url: string, on: boolean): void {
    if (on) pending.set(url, Date.now() + PENDING_TTL_MS); else pending.delete(url);
}

export function isCopyPending(url: string): boolean {
    const t = pending.get(url);
    return t !== undefined && t > Date.now();
}
