/**
 * Building a link preview on the SENDER (docs/plans/embeds.md §5, phase 3).
 *
 *   prepareLinkEmbed(url)   while the person types: main visits the link
 *                           (electron/unfurl) and returns a draft + image
 *                           bytes; here the draft is cleaned with the shared
 *                           validator and the image re-encoded (thumb.ts).
 *                           Nothing is uploaded yet.
 *   finalizeEmbeds(...)     at send: a tiny thumbnail goes inline, any other
 *                           is encrypted + uploaded like an attachment (its key
 *                           goes inside the E2EE message), all within the send
 *                           deadline; a thumbnail that misses it is dropped and
 *                           the card goes without it. The result is run
 *                           through sanitizeLinkEmbeds against the text, so
 *                           what we send is exactly what readers accept.
 *
 * Which links: the same ones the reader embeds (embedUrlsOf: no `<url>`, no
 * link in a spoiler or code), https only, at most LINK_EMBED_MAX_PER_MESSAGE.
 *
 * ALWAYS A THUMBNAIL (2026-11-24, embeds-always-thumb; owner: "sent a medal
 * clip and it has no thumbnail. everything should always have a thumbnail").
 * One chain for every kind (video, player, clip, post, card, GIF):
 *   1. the provider's own picture;                       (main, unfurl.ts)
 *   2. the page's og:image / twitter:image;              (main, withPageFallback)
 *   3. a real frame of the video, for any embed whose `media` is a video file
 *      the sender can stream (clip pages, X / Reddit videos, Giphy / Imgur
 *      loops, direct .mp4 / .webm links): frameGrab.ts;
 *   4. a page snapshot (main's page-snapshot.ts, for a URL main flagged);
 *   5. the designed card picture (designedThumb.ts): the site's icon / letter
 *      on a tinted background, so even a total failure has a picture.
 * A picture from 1-2 that is one flat colour / near-black (thumb.ts
 * isFlatPicture: Medal's og:image is the clip's FIRST frame) counts as none.
 * prepareLinkEmbed attaches 5 at once when 1-2 gave nothing usable and marks
 * the preview `snapshot: 'pending'` when 3 or 4 may still improve on it;
 * completePicture runs them (useComposerEmbeds starts it; a send before it is
 * done goes out with the designed picture and the better one is attached by
 * an embeds-only edit, lateAttach.ts).
 *
 * MEDIA BY CONTENT + COPIES (2026-11-24, embeds-media-everywhere): direct media
 * links (an image, a GIF, a video, with or without an extension) get a preview
 * too now; main decides what a file is by its bytes and returns kind 'image' /
 * 'video' at the file's real size. For an EXPIRING link (a Discord CDN
 * attachment) main also offers a COPY (`copy`): completePicture downloads the
 * file through main (mediaCopy.ts caps), makes the picture from it, and
 * finalizeEmbeds uploads it encrypted as `media.file`, so readers never load
 * the link. A copy whose upload misses the send deadline is attached by the
 * late edit (takeAndFinalize reports it late; the upload keeps going).
 */
import {
    LINK_EMBED_MAX_IMAGES, LINK_EMBED_MAX_PER_MESSAGE, LINK_EMBED_THUMB_INLINE_MAX_BYTES, sanitizeLinkEmbed, sanitizeLinkEmbeds,
    type EmbedImage, type LinkEmbed,
} from '@cipherline/shared';
import { embedUrlsOf } from '../formatting/plainText';
import { embedKindOf } from '../formatting/embedKind';
import { inviteCodeFromUrl } from '../formatting/inviteLinks';
import { AVATAR_MAX_EDGE, SITE_ICON_MAX_EDGE, SNAPSHOT_MAX_EDGE, bytesToBase64, reencodeThumb, type EncodedThumb } from './thumb';
import { tikTokRefOf, twitchRefOf } from './providerLinks';
import { designedThumb, type DesignSpec } from './designedThumb';
import { grabFrame, type FrameGrab } from './frameGrab';
import { safeClmediaUrl } from '../safeMediaUrl';
import { isKlipyMediaUrl } from '@cipherline/shared';
import { markCopyPending, mediaCopyMaxBytes, uploadOnce } from './mediaCopy';

export interface PreparedEmbed {
    url: string;
    /** Cleaned, without its pictures. */
    embed: LinkEmbed;
    thumb?: EncodedThumb;
    /** Phase 4: the author's picture (a tweet's avatar, a TikTok author, a Twitch channel); on a card, the site's icon. */
    icon?: EncodedThumb;
    /** Phase 4: a post's pictures, in order (a tweet's photos, a Reddit gallery). */
    images?: EncodedThumb[];
    /**
     * 'pending': a real web page with no picture of its own; a snapshot of it
     * may still come (snapshotPrepared). Never sent: only the embed and its
     * pictures go into the message.
     */
    snapshot?: 'pending';
    /**
     * The video file the sender's unfurler found (a clip page's, a post's, a
     * GIF loop's, or a direct video link itself): completePicture grabs a frame
     * of it when the picture is missing or flat. Never sent.
     */
    frame?: { pageUrl: string; mediaUrl: string };
    /** Main will take a snapshot of this URL (its unfurler flagged it). Never sent. */
    snapshotOk?: true;
    /** How the picture chain went ('frame', 'ok' = a snapshot, or main's reason: login, bot-wall, error, blank, cancelled, ...). Dev / harness only. */
    snapshotResult?: string;
    /** At send (useComposerEmbeds.take): a better preview of this link is still coming; the message gets it by an embeds-only edit. */
    late?: true;
    /** Main offered a copy of the media (an expiring link): completePicture fetches it. Never sent. */
    copyOffer?: { mime: string; bytes?: number };
    /** The downloaded copy of the media (an expiring link), uploaded encrypted at send as `media.file`. Never sent as such. */
    copy?: { blob: Blob; mime: string };
    /** How the copy went ('ok', 'too-large', 'failed', …). Dev / harness only. */
    copyResult?: string;
}

/**
 * The links of `text` that may get a sender-built preview, in order. Never a
 * Cipherline theme or invite link (drawn locally; visiting one would tell our
 * own server about it), nor a direct image / video file (the reader's local
 * embed plays it from the URL).
 */
export function previewableUrls(text: string): string[] {
    const out: string[] = [];
    for (const u of embedUrlsOf(text)) {
        // http links are never fetched; they get the minimal card (minimalPrepared).
        if (!/^https?:\/\//i.test(u)) continue;
        const kind = embedKindOf(u);
        // A direct VIDEO file does get one (2026-11-24): a frame of it is its picture. So does a
        // direct IMAGE / GIF now (embeds-media-everywhere): its real size and type from its bytes,
        // and a copy of an expiring link. Never KLIPY's media files (KLIPY's rules: readers load them).
        if (kind === 'theme' || kind === 'invite' || inviteCodeFromUrl(u) || isKlipyMediaUrl(u)) continue;
        if (!out.includes(u)) out.push(u);
        if (out.length >= LINK_EMBED_MAX_PER_MESSAGE) break;
    }
    return out;
}

type UnfurlFn = NonNullable<Window['electronAPI']>['unfurlLink'];

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * The minimal card for a link that got no real preview in time (a slow or
 * unreachable site, an http link, which is never fetched): its site (the host)
 * only, so readers draw the card layout instead of a bare link. Null for links
 * the reader draws better from the link alone (YouTube, clips, direct media,
 * Twitch / TikTok players) and anything that is not a web link.
 */
export function minimalPrepared(url: string): PreparedEmbed | null {
    if (!/^https?:\/\//i.test(url)) return null;
    if (embedKindOf(url) !== 'link' || twitchRefOf(url) || tikTokRefOf(url)) return null;
    const site = hostOf(url);
    const embed = site ? sanitizeLinkEmbed({ url, kind: 'card', site }) : undefined;
    return embed && embed.url === url ? { url, embed } : null;
}

export interface PrepareDeps {
    /** Step 5 (designedThumb.ts); swapped in tests. */
    designed?: (spec: DesignSpec) => Promise<EncodedThumb | null>;
}

/** An encoded picture → something a canvas can draw (the designed picture's icon). */
async function drawable(t: EncodedThumb | null | undefined): Promise<ImageBitmap | null> {
    if (!t || typeof createImageBitmap !== 'function') return null;
    try { return await createImageBitmap(t.blob); } catch { return null; }
}

/** The designed picture for an embed (step 5): its site, colour and (on a card) the site's icon. */
async function designedFor(embed: LinkEmbed, url: string, icon: EncodedThumb | null | undefined, deps: PrepareDeps): Promise<EncodedThumb | null> {
    const bitmap = embed.kind === 'card' ? await drawable(icon) : null;
    try {
        return await (deps.designed ?? designedThumb)({ label: embed.site || hostOf(url) || url, color: embed.color, icon: bitmap, play: embed.kind !== 'card' && embed.kind !== 'post' });
    } finally {
        bitmap?.close?.();
    }
}

/** A minimal card (a failed / http link) with its designed picture (step 5), when one can be drawn. */
async function minimalWithPicture(url: string, deps: PrepareDeps): Promise<PreparedEmbed | null> {
    const m = minimalPrepared(url);
    if (!m) return null;
    const thumb = await designedFor(m.embed, url, null, deps);
    return thumb ? { ...m, thumb } : m;
}

/** One link → a prepared preview, or null when there is nothing worth showing. Never throws. */
export async function prepareLinkEmbed(url: string, unfurl: UnfurlFn | undefined = typeof window !== 'undefined' ? window.electronAPI?.unfurlLink : undefined, deps: PrepareDeps = {}): Promise<PreparedEmbed | null> {
    if (/^http:\/\//i.test(url)) return minimalWithPicture(url, deps);
    if (!unfurl) return null;
    let res: Awaited<ReturnType<NonNullable<UnfurlFn>>>;
    try { res = await unfurl(url); } catch { return minimalWithPicture(url, deps); }
    if (!res || !res.ok) return minimalWithPicture(url, deps);
    const draft = { ...res.embed, url };
    // Pictures are only ever ours (re-encoded here), never main's or a page's.
    for (const k of ['thumb', 'author_icon', 'images'] as const) delete (draft as Record<string, unknown>)[k];
    const bytesOf = (x: unknown): Uint8Array | null => (x && typeof x === 'object' && (x as { bytes?: unknown }).bytes instanceof Uint8Array ? (x as { bytes: Uint8Array }).bytes : null);
    const imageBytes = (Array.isArray(res.images) ? res.images : []).slice(0, LINK_EMBED_MAX_IMAGES).map(bytesOf).filter((b): b is Uint8Array => !!b);
    const [thumb, icon, ...pics] = await Promise.all([
        bytesOf(res.image) ? reencodeThumb(bytesOf(res.image)!) : Promise.resolve(null),
        // A card's icon is the site's favicon (maybe an .ico; thumb.ts opens it), drawn small.
        bytesOf(res.icon) ? reencodeThumb(bytesOf(res.icon)!, (res.embed as { kind?: unknown }).kind === 'card' ? SITE_ICON_MAX_EDGE : AVATAR_MAX_EDGE) : Promise.resolve(null),
        ...imageBytes.map((b) => reencodeThumb(b)),
    ]);
    const images = pics.filter((p): p is EncodedThumb => !!p);
    // A page that gave only a picture still gets a card: its host is the title.
    // (A post with only pictures is a post: they are attached at send.)
    const picturesOnlyPost = () => {
        // Validate the rest of the post with a stand-in picture; the real ones are attached at send.
        const e = sanitizeLinkEmbed({ ...draft, images: [{ mime: 'image/webp', width: 1, height: 1, inline_b64: 'A'.repeat(24) }] });
        if (e) delete e.images;
        return e;
    };
    const embed = sanitizeLinkEmbed(draft)
        ?? ((draft as { kind?: unknown }).kind === 'post' && images.length ? picturesOnlyPost() : undefined)
        ?? (thumb ? sanitizeLinkEmbed({ ...draft, title: hostOf(url) }) : undefined);
    if (!embed || embed.url !== url) return minimalWithPicture(url, deps);
    // ── Always a thumbnail (see the header) ──
    // A flat / near-black picture (a black first frame) is no picture.
    const usable = thumb && !thumb.flat ? thumb : null;
    const media = embed.media;
    const frame = media && media.mime.startsWith('video/') ? { pageUrl: url, mediaUrl: media.url } : undefined;
    const r = res as { snapshot?: unknown; snapshotable?: unknown; copy?: unknown };
    const snapshotOk = r.snapshot === true || r.snapshotable === true;
    // An expiring link: main offers a copy of the file (fetched in completePicture).
    const offer = r.copy && typeof r.copy === 'object' && typeof (r.copy as { mime?: unknown }).mime === 'string' && media
        ? { mime: (r.copy as { mime: string }).mime, ...(typeof (r.copy as { bytes?: unknown }).bytes === 'number' ? { bytes: (r.copy as { bytes: number }).bytes } : {}) }
        : undefined;
    const copyOffer = offer && (offer.bytes === undefined || offer.bytes <= mediaCopyMaxBytes(offer.mime)) ? offer : undefined;
    // A post's pictures are its photos / its author; a picture of the post is
    // needed only for its video (the poster). Everything else needs `thumb`.
    const needs = embed.kind === 'post' ? !!media && !usable : !usable;
    const picture = needs ? await designedFor(embed, url, icon, deps) : usable;
    const pending = (needs && (!!frame || snapshotOk)) || !!copyOffer;
    if (copyOffer) markCopyPending(url, true);
    return {
        url, embed,
        ...(copyOffer ? { copyOffer } : {}),
        ...(picture ? { thumb: picture } : {}),
        ...(icon ? { icon } : {}),
        ...(images.length ? { images } : {}),
        ...(pending ? { snapshot: 'pending' as const } : {}),
        ...(frame ? { frame } : {}),
        ...(snapshotOk ? { snapshotOk: true as const } : {}),
    };
}

type RegisterThumbFn = NonNullable<Window['electronAPI']>['registerThumbMedia'];

/** Running frame grabs by token (cancelPicture aborts them). */
const grabs = new Map<string, AbortController>();

/** Stop a running frame grab (the link left the draft). The snapshot in main is cancelled separately. */
export function cancelFrameGrab(token: string): void {
    grabs.get(token)?.abort();
    grabs.delete(token);
}

export interface PictureDeps {
    register?: RegisterThumbFn;
    grab?: (src: string, signal: AbortSignal) => Promise<FrameGrab | null>;
    snap?: SnapshotFn;
    /** The copy of an expiring link's media (main's embed:media-copy). */
    copy?: NonNullable<Window['electronAPI']>['fetchMediaCopy'];
}

/**
 * Step 3: a frame of the preview's video → the preview with that frame as its
 * picture and the video's real size / duration in `media`. 'cancelled' when
 * cancelFrameGrab stopped it, null when it failed.
 */
export async function framePrepared(p: PreparedEmbed, token: string, deps: PictureDeps = {}): Promise<PreparedEmbed | 'cancelled' | null> {
    if (!p.frame) return null;
    const register = deps.register ?? (typeof window !== 'undefined' ? window.electronAPI?.registerThumbMedia : undefined);
    if (!register) return null;
    const ctl = new AbortController();
    grabs.set(token, ctl);
    try {
        let src: string | undefined;
        try {
            const r = await register(p.frame.pageUrl, p.frame.mediaUrl);
            src = r && r.ok ? safeClmediaUrl(r.src) : undefined;
        } catch { src = undefined; }
        if (ctl.signal.aborted) return 'cancelled';
        if (!src) return null;
        const g = await (deps.grab ?? ((s: string, signal: AbortSignal) => grabFrame(s, { signal })))(src, ctl.signal);
        if (ctl.signal.aborted) return 'cancelled';
        if (!g) return null;
        const media = p.embed.media ? { ...p.embed.media, width: g.width, height: g.height, ...(g.durationS ? { duration_s: g.durationS } : {}) } : undefined;
        const embed = sanitizeLinkEmbed({ ...p.embed, ...(media ? { media } : {}) });
        const base: PreparedEmbed = { ...p };
        delete base.snapshot;
        return { ...base, embed: embed && embed.url === p.url ? embed : p.embed, thumb: g.thumb, snapshotResult: 'frame' };
    } finally {
        if (grabs.get(token) === ctl) grabs.delete(token);
    }
}

/**
 * Steps 3 and 4 for a preview still waiting for a better picture
 * (`snapshot: 'pending'`): a frame of its video, else a snapshot of its page.
 * When both fail the preview keeps the designed picture prepareLinkEmbed
 * gave it (step 5). Never throws.
 */
export async function completePicture(p: PreparedEmbed, token: string, deps: PictureDeps = {}): Promise<PreparedEmbed> {
    if (p.copyOffer && !p.copy) {
        p = await copyPrepared(p, deps);
        // The copy made a real picture (or there was one already): done.
        if (p.thumb && !p.thumb.designed && !p.thumb.flat) { const done: PreparedEmbed = { ...p }; delete done.snapshot; return done; }
    }
    const base: PreparedEmbed = { ...p };
    delete base.snapshot;
    if (p.snapshot !== 'pending') return { ...base, snapshotResult: 'unavailable' };
    let frameResult = '';
    if (p.frame) {
        const f = await framePrepared(p, token, deps).catch(() => null);
        if (f === 'cancelled') return { ...base, snapshotResult: 'cancelled' };
        if (f) return f;
        frameResult = 'frame-failed';
    }
    if (p.snapshotOk) return snapshotPrepared(p, token, deps.snap);
    return { ...base, snapshotResult: frameResult || 'unavailable' };
}

type SnapshotFn = NonNullable<Window['electronAPI']>['snapshotPage'];
type CopyFn = NonNullable<NonNullable<Window['electronAPI']>['fetchMediaCopy']>;

/**
 * The copy of an expiring link's media (see the header): main downloads the
 * whole file (gated on its own offer, capped at mediaCopyMaxBytes and sniffed);
 * the embed's media takes the file's real size / animation / duration; the
 * picture is made from the copy itself (an image's first frame re-encoded, a
 * video's frame grabbed from a local blob: URL; no further request). On any
 * failure the preview is returned without a copy: readers use the link.
 */
export async function copyPrepared(p: PreparedEmbed, deps: PictureDeps = {}): Promise<PreparedEmbed> {
    const offer = p.copyOffer;
    const media = p.embed.media;
    const base: PreparedEmbed = { ...p };
    delete base.copyOffer;
    try {
        const fetchCopy: CopyFn | undefined = deps.copy ?? (typeof window !== 'undefined' ? window.electronAPI?.fetchMediaCopy : undefined);
        if (!offer || !media || !fetchCopy) return { ...base, copyResult: 'unavailable' };
        const max = mediaCopyMaxBytes(offer.mime);
        if (max <= 0) return { ...base, copyResult: 'over-limit' };
        let r: Awaited<ReturnType<CopyFn>>;
        try { r = await fetchCopy(p.url, max); } catch { return { ...base, copyResult: 'failed' }; }
        if (!r || !r.ok) return { ...base, copyResult: (r && typeof r.reason === 'string' ? r.reason : 'failed').slice(0, 20) };
        if (!(r.bytes instanceof Uint8Array) || r.bytes.byteLength === 0 || r.bytes.byteLength > max) return { ...base, copyResult: 'failed' };
        const blob = new Blob([r.bytes as BlobPart], { type: r.mime });
        const nextMedia = {
            ...media,
            ...(r.width && r.height ? { width: r.width, height: r.height } : {}),
            ...(r.duration_s ? { duration_s: r.duration_s } : {}),
            ...(r.animated && r.mime.startsWith('image/') ? { animated: true } : {}),
        };
        const embed = sanitizeLinkEmbed({ ...p.embed, media: nextMedia });
        let thumb = p.thumb && !p.thumb.designed && !p.thumb.flat ? p.thumb : undefined;
        if (!thumb && r.mime.startsWith('image/')) thumb = (await reencodeThumb(r.bytes)) ?? undefined;
        if (!thumb && r.mime.startsWith('video/') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            const src = URL.createObjectURL(blob);
            try {
                const g = await (deps.grab ?? ((s: string, signal: AbortSignal) => grabFrame(s, { signal })))(src, new AbortController().signal);
                if (g) thumb = g.thumb;
            } catch { /* the chain below still runs */ } finally { URL.revokeObjectURL(src); }
        }
        return {
            ...base,
            embed: embed && embed.url === p.url ? embed : p.embed,
            copy: { blob, mime: r.mime },
            ...(thumb ? { thumb } : {}),
            copyResult: 'ok',
        };
    } finally {
        markCopyPending(p.url, false);
    }
}

/**
 * A card waiting for its snapshot (`snapshot: 'pending'`) → the same card with
 * the page's snapshot as its large picture (re-encoded here to a fresh WebP of
 * at most 1200 px / LINK_EMBED_THUMB_MAX_BYTES, like every thumbnail). When
 * main says no (a login page, a captcha / bot wall, an error or blank page,
 * a failure, a timeout) the card goes without a picture: the designed
 * no-picture card. `token` names the job so it can be cancelled. Never throws.
 */
export async function snapshotPrepared(p: PreparedEmbed, token: string, snap: SnapshotFn | undefined = typeof window !== 'undefined' ? window.electronAPI?.snapshotPage : undefined): Promise<PreparedEmbed> {
    const base: PreparedEmbed = { ...p };
    delete base.snapshot;
    if (p.snapshot !== 'pending' || !snap) return { ...base, snapshotResult: 'unavailable' };
    let r: Awaited<ReturnType<NonNullable<SnapshotFn>>>;
    try { r = await snap(p.url, token); } catch { return { ...base, snapshotResult: 'failed' }; }
    if (!r || !r.ok) return { ...base, snapshotResult: (r && typeof r.reason === 'string' ? r.reason : 'failed').slice(0, 20) };
    if (!(r.bytes instanceof Uint8Array)) return { ...base, snapshotResult: 'failed' };
    const thumb = await reencodeThumb(r.bytes, SNAPSHOT_MAX_EDGE);
    if (!thumb) return { ...base, snapshotResult: 'encode' };
    const embed = p.embed.kind === 'card' ? sanitizeLinkEmbed({ ...p.embed, image_large: true }) : p.embed;
    return { ...base, embed: embed && embed.url === p.url ? embed : p.embed, thumb, snapshotResult: 'ok' };
}

export type ThumbUploader = (blob: Blob) => Promise<Pick<EmbedImage, 'attachment_id' | 'file_key_b64' | 'file_nonce_b64' | 'byte_size'>>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((ok, fail) => {
        const t = setTimeout(() => fail(new Error('timeout')), Math.max(0, ms));
        p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
    });
}

async function thumbFor(t: EncodedThumb | undefined, upload: ThumbUploader | null, budgetMs: number): Promise<EmbedImage | undefined> {
    if (!t) return undefined;
    const base = { mime: t.mime, width: t.width, height: t.height, ...(t.designed ? { designed: true as const } : {}) };
    if (t.blob.size <= LINK_EMBED_THUMB_INLINE_MAX_BYTES) {
        return { ...base, inline_b64: bytesToBase64(new Uint8Array(await t.blob.arrayBuffer())) };
    }
    if (!upload) return undefined;
    try {
        return { ...base, ...(await withTimeout(upload(t.blob), budgetMs)) };
    } catch {
        return undefined;
    }
}

/** The copy of the media, uploaded once (an upload that outlives the deadline keeps going); undefined when not (yet) up. */
async function copyFileFor(p: PreparedEmbed, upload: ThumbUploader | null, budgetMs: number) {
    if (!p.copy || !upload || !p.embed.media) return undefined;
    try {
        const ref = await withTimeout(uploadOnce(upload, p.copy.blob), budgetMs);
        if (!ref.attachment_id || !ref.file_key_b64 || !ref.file_nonce_b64) return undefined;
        return { attachment_id: ref.attachment_id, file_key_b64: ref.file_key_b64, file_nonce_b64: ref.file_nonce_b64, byte_size: p.copy.blob.size };
    } catch {
        return undefined;
    }
}

/**
 * At send: the composer's previews (waiting for ones still building only
 * until `deadlineMs`), then finalized within what is left of the same budget
 * (at least 300 ms for the thumbnail uploads). The whole send waits at most
 * about `deadlineMs`.
 */
export async function takeAndFinalize(
    text: string,
    take: (text: string, deadlineMs: number) => Promise<PreparedEmbed[]>,
    upload: ThumbUploader | null,
    deadlineMs: number,
    /** The links whose better preview is still coming (PreparedEmbed.late): the caller attaches it later. */
    onLate?: (urls: string[]) => void,
): Promise<LinkEmbed[]> {
    const t0 = Date.now();
    const prepared = await take(text, deadlineMs);
    const late = prepared.filter((p) => p.late).map((p) => p.url);
    if (prepared.length === 0) { if (late.length) onLate?.(late); return []; }
    const built = await finalizeEmbeds(text, prepared, upload, Math.max(300, deadlineMs - (Date.now() - t0)));
    // A copy whose upload missed the deadline goes out with the link; its upload keeps
    // going (uploadOnce) and the late edit attaches it.
    for (const p of prepared) {
        if (p.copy && !late.includes(p.url) && !built.find((e) => e.url === p.url)?.media?.file) late.push(p.url);
    }
    if (late.length) onLate?.(late);
    return built;
}

/**
 * The `embeds` to send with `text`: each prepared preview gets its thumbnail
 * inline or uploaded (within `budgetMs`), a preview whose link left the text
 * is dropped, and the whole list is checked with the reader's own validator.
 */
export async function finalizeEmbeds(text: string, prepared: PreparedEmbed[], upload: ThumbUploader | null, budgetMs: number, copyBudgetMs: number = budgetMs): Promise<LinkEmbed[]> {
    const urls = embedUrlsOf(text);
    const live = prepared.filter((p) => urls.includes(p.url)).slice(0, LINK_EMBED_MAX_PER_MESSAGE);
    // Every picture (thumbnail, author picture, a post's pictures) goes inline or up at once, in parallel.
    const built = await Promise.all(live.map(async (p) => {
        const [thumb, icon, file, ...pics] = await Promise.all([
            thumbFor(p.thumb, upload, budgetMs),
            thumbFor(p.icon, upload, budgetMs),
            copyFileFor(p, upload, copyBudgetMs),
            ...(p.images ?? []).map((i) => thumbFor(i, upload, budgetMs)),
        ]);
        const images = pics.filter((x): x is EmbedImage => !!x);
        return {
            ...p.embed,
            ...(file && p.embed.media ? { media: { ...p.embed.media, file } } : {}),
            ...(thumb ? { thumb } : {}),
            ...(icon ? { author_icon: icon } : {}),
            ...(images.length ? { images } : {}),
        };
    }));
    return sanitizeLinkEmbeds(built, urls);
}
