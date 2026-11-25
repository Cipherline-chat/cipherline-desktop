/**
 * Discord import → link previews (link embeds phase 4). The previews Discord
 * generated for links in a message (electron/discord-import/history.ts
 * collectLinkEmbeds) become the message's `embeds` (packages/shared
 * link-embeds.ts), so imported history keeps them: title, description, site,
 * author, colour, and the picture — Discord's own copy of it, fetched from
 * Discord, re-encoded HERE (WebP, EXIF gone) and sent inline or as an
 * encrypted attachment, exactly like a sender-built preview. Nothing is
 * fetched from the linked site.
 *
 * Kind, from Cipherline's own reading of the link (never Discord's player
 * URL): YouTube / Twitch / TikTok → the click-to-play player; a known clip
 * page (Medal, Streamable…) → the clip card (it resolves the file on play,
 * as for any link); an X post → a post card with Discord's text; anything
 * else → a web card.
 *
 * Fail soft: a preview whose link is not in the imported text (Discord
 * sometimes canonicalised it) falls back to the quoted text the importer
 * always wrote; a picture that cannot be fetched, decoded or stored is left
 * out and the card goes without it. Previews never stop a message.
 */
import { LINK_EMBED_MAX_PER_MESSAGE, LINK_EMBED_THUMB_INLINE_MAX_BYTES, sanitizeLinkEmbed, sanitizeLinkEmbeds, type EmbedImage, type LinkEmbed } from '@cipherline/shared';
import type { ImportLinkEmbed } from '../types';
import { embedUrlsOf } from '../../formatting/plainText';
import { parseYouTubeLink } from '../../youtubeLink';
import { clipLinkOf } from '../../mediaEmbed/mediaLinks';
import { tikTokRefOf, twitchPlayerId, twitchRefOf, xStatusRefOf } from '../../linkEmbeds/providerLinks';
import { bytesToBase64, type EncodedThumb } from '../../linkEmbeds/thumb';

/** The link in the text a Discord preview belongs to: the same URL, or the same page written differently. */
export function matchTextUrl(embedUrl: string, textUrls: readonly string[]): string | null {
    if (textUrls.includes(embedUrl)) return embedUrl;
    const norm = (u: string) => {
        try {
            const x = new URL(u);
            return `${x.hostname.replace(/^(www|m|mobile)\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
        } catch { return null; }
    };
    const want = norm(embedUrl);
    const hit = textUrls.find((u) => want !== null && norm(u) === want);
    if (hit) return hit;
    // YouTube: youtu.be/<id> in the text, youtube.com/watch?v=<id> in Discord's preview.
    const yt = parseYouTubeLink(embedUrl);
    if (yt) return textUrls.find((u) => parseYouTubeLink(u)?.id === yt.id) ?? null;
    return null;
}

/** Discord's preview → a LinkEmbed without its picture, or null when nothing usable is left. */
export function draftFromDiscord(e: ImportLinkEmbed, url: string): LinkEmbed | null {
    const text = {
        ...(e.site ? { site: e.site } : {}),
        ...(e.title ? { title: e.title } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.author ? { author: e.author } : {}),
        ...(e.color ? { color: e.color } : {}),
    };
    const yt = parseYouTubeLink(url);
    if (yt) {
        return sanitizeLinkEmbed({ url, kind: 'player', site: 'YouTube', title: e.title, author: e.author, player: { provider: 'youtube', id: yt.id, ...(yt.start > 0 ? { start_s: yt.start } : {}) } }) ?? null;
    }
    const tw = twitchRefOf(url);
    if (tw) return sanitizeLinkEmbed({ url, kind: 'player', site: 'Twitch', title: e.title ?? 'Twitch', author: e.author, player: { provider: 'twitch', id: twitchPlayerId(tw) } }) ?? null;
    const tt = tikTokRefOf(url);
    if (tt?.id) return sanitizeLinkEmbed({ url, kind: 'player', site: 'TikTok', title: e.title ?? 'TikTok video', author: e.author, player: { provider: 'tiktok', id: tt.id } }) ?? null;
    if (clipLinkOf(url)) return sanitizeLinkEmbed({ url, kind: 'video', ...text }) ?? null;
    if (xStatusRefOf(url) && e.description) return sanitizeLinkEmbed({ url, kind: 'post', site: 'X', author: e.author ?? e.title ?? undefined, description: e.description }) ?? null;
    return sanitizeLinkEmbed({ url, kind: 'card', ...text }) ?? null;
}

export interface LinkEmbedImportDeps {
    fetchMedia(ref: string): Promise<{ ok: true; mime: string; bytes: Uint8Array } | { ok: false; code: string; message: string }>;
    reencode(bytes: Uint8Array): Promise<EncodedThumb | null>;
    /** Encrypt + upload through the import's own attachment path (counted like any imported file). */
    upload(bytes: Uint8Array, mime: string): Promise<{ attachmentId: string; keyB64: string; nonceB64: string; storedBytes: number }>;
}

export interface ImportedLinkEmbeds {
    embeds: LinkEmbed[];
    /** Previews that could not be tied to a link in the text: the caller writes them as quoted text. */
    unmapped: ImportLinkEmbed[];
    /** Thumbnail attachments uploaded for these embeds (the row's attachment list). */
    attachmentIds: string[];
    storedBytes: number;
}

async function pictureFor(e: ImportLinkEmbed, deps: LinkEmbedImportDeps, ids: string[], bytes: { n: number }): Promise<EmbedImage | undefined> {
    if (!e.thumbRef) return undefined;
    try {
        const got = await deps.fetchMedia(e.thumbRef);
        if (!got.ok) return undefined;
        const t = await deps.reencode(got.bytes);
        if (!t) return undefined;
        const plain = new Uint8Array(await t.blob.arrayBuffer());
        const base = { mime: t.mime, width: t.width, height: t.height };
        if (plain.byteLength <= LINK_EMBED_THUMB_INLINE_MAX_BYTES) return { ...base, inline_b64: bytesToBase64(plain) };
        const up = await deps.upload(plain, t.mime);
        ids.push(up.attachmentId);
        bytes.n += up.storedBytes;
        return { ...base, attachment_id: up.attachmentId, file_key_b64: up.keyB64, file_nonce_b64: up.nonceB64, byte_size: plain.byteLength };
    } catch {
        return undefined;
    }
}

/** The `embeds` for an imported message's text, with their pictures. Never throws. */
export async function importedLinkEmbeds(list: readonly ImportLinkEmbed[] | undefined, text: string, deps: LinkEmbedImportDeps): Promise<ImportedLinkEmbeds> {
    const out: ImportedLinkEmbeds = { embeds: [], unmapped: [], attachmentIds: [], storedBytes: 0 };
    if (!list?.length) return out;
    const urls = embedUrlsOf(text);
    const bytes = { n: 0 };
    const used = new Set<string>();
    const built: LinkEmbed[] = [];
    for (const e of list) {
        const url = matchTextUrl(e.url, urls);
        const draft = url && !used.has(url) && built.length < LINK_EMBED_MAX_PER_MESSAGE ? draftFromDiscord(e, url) : null;
        if (!draft || !url) { out.unmapped.push(e); continue; }
        used.add(url);
        const thumb = await pictureFor(e, deps, out.attachmentIds, bytes);
        built.push(thumb ? { ...draft, thumb } : draft);
    }
    // The readers' own validator decides what is sent, exactly as for a live message.
    out.embeds = sanitizeLinkEmbeds(built, urls);
    for (const b of built) if (!out.embeds.some((x) => x.url === b.url)) out.unmapped.push(list.find((e) => matchTextUrl(e.url, urls) === b.url)!);
    out.storedBytes = bytes.n;
    return out;
}
