/**
 * Phase-4 provider adapters for the sender-side unfurler (docs/plans/embeds.md
 * §7 phase 4): Twitch, X / Twitter, TikTok, Reddit. Each one fills a draft
 * LinkEmbed from that provider's public, key-less endpoints (checked live,
 * see twitch.ts / x.ts / tiktok.ts / reddit.ts) and fetches its pictures —
 * on the SENDER's device, through the same guarded fetch as every unfurl
 * (pinned-fetch.ts: https only, private ranges refused, no cookies / referrer,
 * bounded), with a per-provider host allowlist on every hop.
 *
 * Fail soft: a provider that refuses or changed shape gives the best card it
 * can (Twitch / TikTok still get a player built from the link alone), never an
 * error the composer would show.
 */
import { fetchTextPinned, EMBED_FETCH_UA, EMBED_PREVIEW_UA, type FetchDeps } from '../media-embed/pinned-fetch';
import { parsePageMeta, type PageMeta } from './parse-page';
import { redditRefOf, redditCanonicalUrl, tikTokRefOf, twitchPlayerId, twitchRefOf, xStatusRefOf } from './provider-links';
import { isGenericTwitchShell, twitchFacts, twitchImageHostAllowed, twitchPageHostAllowed, twitchPageUrl } from './twitch';
import { parseTweetResult, parseXOEmbed, syndicationUrl, xOEmbedUrl, type TweetFacts } from './x';
import { parseTikTokOEmbed, parseTikTokPage, tikTokImageHostAllowed, tikTokOEmbedUrl, tikTokPageHostAllowed, tikTokTitle, type TikTokFacts } from './tiktok';
import {
    parseRedditOEmbed, parseRedditPostJson, redditApiHostAllowed, redditImageHostAllowed, redditJsonUrl, redditOEmbedUrl, redditOldJsonUrl, type RedditFacts,
} from './reddit';

type Ua = typeof EMBED_FETCH_UA | typeof EMBED_PREVIEW_UA;

export interface FetchedImage { bytes: Uint8Array; mime: string }

/** What an adapter hands back: the draft (no pictures) + the pictures' bytes. */
export interface SocialResult {
    embed: Record<string, unknown> & { url: string; kind: 'player' | 'post' };
    image?: FetchedImage;
    icon?: FetchedImage;
    images?: FetchedImage[];
    /**
     * For the shared page fallback (unfurl.ts withPageFallback): whether a read
     * of the link's page is the real page (Twitch's generic app shell is not:
     * its picture is the Twitch logo, not the clip).
     */
    pageUsable?: (page: PageMeta) => boolean;
}

export interface SocialDeps {
    fetchDeps?: FetchDeps;
    /** The guarded image fetch (unfurl.ts fetchImagePinned) with a host policy. */
    fetchImage: (url: string, hostAllowed: (h: string) => boolean, userAgent?: Ua) => Promise<FetchedImage>;
    /** Pause before a retry (Twitch's shell); injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    timeoutMs: number;
    htmlMaxBytes: number;
    jsonMaxBytes: number;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function json(url: string, hostAllowed: (h: string) => boolean, d: SocialDeps, userAgent?: Ua): Promise<string> {
    const { text } = await fetchTextPinned(url, {
        accept: 'application/json',
        allowedTypes: ['application/json', 'text/json', 'text/javascript'],
        maxBytes: d.jsonMaxBytes,
        timeoutMs: d.timeoutMs,
        maxRedirects: 3,
        truncate: false,
        hostAllowed,
        userAgent,
    }, d.fetchDeps);
    return text;
}

async function html(url: string, hostAllowed: (h: string) => boolean, d: SocialDeps): Promise<{ text: string; finalUrl: string }> {
    const { text, finalUrl } = await fetchTextPinned(url, {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        allowedTypes: ['text/html', 'application/xhtml+xml'],
        maxBytes: d.htmlMaxBytes,
        timeoutMs: d.timeoutMs,
        maxRedirects: 5,
        truncate: true,
        hostAllowed,
    }, d.fetchDeps);
    return { text, finalUrl };
}

const maybe = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch { return undefined; } };
const pic = (url: string | undefined, ok: (h: string) => boolean, d: SocialDeps) => (url ? maybe(d.fetchImage(url, ok)) : Promise.resolve(undefined));
const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);

// ── Twitch ─────────────────────────────────────────────────────────────────

async function twitch(url: string, d: SocialDeps): Promise<SocialResult | null> {
    const ref = twitchRefOf(url);
    if (!ref) return null;
    const embed: SocialResult['embed'] = { url, kind: 'player', site: 'Twitch', player: { provider: 'twitch', id: twitchPlayerId(ref) } };
    const pageUsable = (p: PageMeta) => !isGenericTwitchShell(p);
    let page: ReturnType<typeof parsePageMeta> | undefined;
    let text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const got = await maybe(html(twitchPageUrl(ref), twitchPageHostAllowed, d));
        if (got) {
            const p = parsePageMeta(got.text, got.finalUrl);
            if (!isGenericTwitchShell(p)) { page = p; text = got.text; break; }
        }
        if (attempt === 0) await (d.sleep ?? sleepReal)(700);
    }
    const facts = page ? twitchFacts(page, ref, text) : twitchFacts({ largeImage: false }, ref, '');
    const fallbackTitle = ref.kind === 'channel' ? `${facts.author ?? ref.login} on Twitch` : ref.kind === 'video' ? 'Twitch video' : 'Twitch clip';
    Object.assign(embed, {
        title: facts.title ?? fallbackTitle,
        ...(facts.author ? { author: facts.author } : {}),
        ...(facts.tag ? { tag: facts.tag } : {}),
        ...(ref.kind === 'channel' && page?.description ? { description: page.description } : {}),
    });
    if (!page?.image) return { embed, pageUsable };
    // A channel's picture is its profile picture (square): the author's icon, not a video frame.
    const img = await pic(page.image.url, twitchImageHostAllowed, d);
    return ref.kind === 'channel' ? { embed, pageUsable, ...(img ? { icon: img } : {}) } : { embed, pageUsable, ...(img ? { image: img } : {}) };
}

// ── X / Twitter ────────────────────────────────────────────────────────────

const SYNDICATION_HOST = (h: string) => h === 'cdn.syndication.twimg.com';
const XOEMBED_HOST = (h: string) => h === 'publish.x.com' || h === 'publish.twitter.com';
const PBS_HOST = (h: string) => h === 'pbs.twimg.com';

async function x(url: string, d: SocialDeps): Promise<SocialResult | null> {
    const ref = xStatusRefOf(url);
    if (!ref) return null;
    let t: TweetFacts | null = null;
    const body = await maybe(json(syndicationUrl(ref.id), SYNDICATION_HOST, d));
    if (body) t = parseTweetResult(body);
    if (!t) {
        // The oEmbed fallback: words only (no media, no avatar). A deleted tweet has neither.
        const o = await maybe(json(xOEmbedUrl(ref.id, ref.handle), XOEMBED_HOST, d));
        const facts = o ? parseXOEmbed(o) : null;
        if (!facts || !facts.text) return null;
        return { embed: { url, kind: 'post', site: 'X', author: facts.name, author_handle: `@${facts.handle}`, description: facts.text } };
    }
    const embed: SocialResult['embed'] = {
        url, kind: 'post', site: 'X', author: t.name, author_handle: `@${t.handle}`,
        ...(t.text ? { description: t.text } : {}),
        ...(t.createdAt ? { published_at: t.createdAt } : {}),
        ...(t.sensitive ? { nsfw: true } : {}),
        ...(t.video ? {
            media: {
                url: t.video.url, mime: 'video/mp4',
                ...(t.video.width && t.video.height ? { width: t.video.width, height: t.video.height } : {}),
                ...(t.video.durationS ? { duration_s: t.video.durationS } : {}),
                ...(t.video.loop ? { loop: true } : {}),
            },
        } : {}),
    };
    if (!t.text && !t.video && !t.photos.length) return null;
    const [icon, poster, ...photos] = await Promise.all([
        pic(t.avatarUrl, PBS_HOST, d),
        pic(t.video?.poster, PBS_HOST, d),
        ...t.photos.slice(0, 4).map((p) => pic(p.url, PBS_HOST, d)),
    ]);
    const images = defined(photos);
    return { embed, ...(icon ? { icon } : {}), ...(poster ? { image: poster } : {}), ...(images.length ? { images } : {}) };
}

// ── TikTok ─────────────────────────────────────────────────────────────────

const TIKTOK_OEMBED_HOST = (h: string) => h === 'www.tiktok.com';

async function tiktok(url: string, d: SocialDeps): Promise<SocialResult | null> {
    const ref = tikTokRefOf(url);
    if (!ref) return null;
    let facts: TikTokFacts = {};
    const o = await maybe(json(tikTokOEmbedUrl(url), TIKTOK_OEMBED_HOST, d));
    if (o) facts = parseTikTokOEmbed(o) ?? {};
    let id = ref.id ?? facts.id;
    if (!facts.caption || !facts.author || !facts.coverUrl || !id) {
        const page = await maybe(html(url, tikTokPageHostAllowed, d));
        if (page) {
            const fromPage = parseTikTokPage(page.text) ?? {};
            facts = { ...fromPage, ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)) };
            // The visible link's own id wins; a short link's comes from where it redirected.
            if (!ref.id) id = tikTokRefOf(page.finalUrl)?.id ?? fromPage.id ?? id;
        }
    }
    // A short link whose video could not be found cannot get a player: no embed.
    if (!id) return null;
    const handle = facts.handle ?? ref.handle ?? undefined;
    const embed: SocialResult['embed'] = {
        url, kind: 'player', site: 'TikTok', player: { provider: 'tiktok', id },
        title: tikTokTitle(facts.caption) ?? 'TikTok video',
        ...(facts.author ?? handle ? { author: facts.author ?? handle } : {}),
        ...(handle ? { author_handle: `@${handle}` } : {}),
        ...(facts.createdAt ? { published_at: facts.createdAt } : {}),
    };
    const [image, icon] = await Promise.all([pic(facts.coverUrl, tikTokImageHostAllowed, d), pic(facts.avatarUrl, tikTokImageHostAllowed, d)]);
    return { embed, ...(image ? { image } : {}), ...(icon ? { icon } : {}) };
}

// ── Reddit ─────────────────────────────────────────────────────────────────

async function reddit(url: string, d: SocialDeps): Promise<SocialResult | null> {
    const ref = redditRefOf(url);
    if (!ref) return null;
    const canonical = redditCanonicalUrl(ref) ?? url;
    const [o, j] = await Promise.all([
        maybe(json(redditOEmbedUrl(canonical), redditApiHostAllowed, d)),
        ref.id ? maybe(json(redditJsonUrl(ref.id), redditApiHostAllowed, d)) : Promise.resolve(undefined),
    ]);
    const base = o ? parseRedditOEmbed(o) : null;
    let full: RedditFacts | null = j ? parseRedditPostJson(j) : null;
    if (!full && ref.id) {
        // www.reddit.com refuses the post .json to many networks (403 "blocked by
        // network security"); old.reddit.com answers it to the link-preview UA
        // (checked live 2026-11-23 from the dev box, where www's .json is blocked).
        const j2 = await maybe(json(redditOldJsonUrl(ref.id), redditApiHostAllowed, d, EMBED_PREVIEW_UA));
        full = j2 ? parseRedditPostJson(j2) : null;
    }
    const f: Partial<RedditFacts> = { ...(base ?? {}), ...(full ?? {}) };
    if (!f.title && !f.author) return null;
    const sub = f.sub ?? ref.sub ?? undefined;
    const video = full?.video;
    const embed: SocialResult['embed'] = {
        url, kind: 'post', site: 'Reddit',
        ...(f.title ? { title: f.title } : {}),
        ...(sub ? { author: `r/${sub}` } : {}),
        ...(f.author ? { author_handle: `u/${f.author}` } : {}),
        ...(f.selftext ? { description: f.selftext } : {}),
        ...(f.createdAt ? { published_at: f.createdAt } : {}),
        ...(f.score !== undefined ? { score: f.score } : {}),
        ...(f.comments !== undefined ? { comments: f.comments } : {}),
        ...(f.nsfw ? { nsfw: true } : {}),
        ...(f.spoiler ? { spoiler: true } : {}),
        ...(video ? {
            media: {
                url: video.url, mime: 'video/mp4',
                ...(video.width && video.height ? { width: video.width, height: video.height } : {}),
                ...(video.durationS ? { duration_s: video.durationS } : {}),
                // fallback_url is Reddit's video-only rendition, whatever has_audio says.
                no_audio: true,
            },
        } : {}),
    };
    const pics = await Promise.all((full?.images ?? []).slice(0, 4).map((i) => pic(i.url, redditImageHostAllowed, d)));
    const got = defined(pics);
    // A video's preview picture is its poster, not a gallery picture.
    if (video) return { embed, ...(got[0] ? { image: got[0] } : {}) };
    return { embed, ...(got.length ? { images: got } : {}) };
}

/**
 * The provider adapter for `url`, if it is one of them: a result, `null` (a
 * provider link with nothing usable: the caller sends no embed), or
 * `undefined` (not a phase-4 provider link).
 */
export async function unfurlSocial(url: string, d: SocialDeps): Promise<SocialResult | null | undefined> {
    if (twitchRefOf(url)) return twitch(url, d);
    if (xStatusRefOf(url)) return x(url, d);
    if (tikTokRefOf(url)) return tiktok(url, d);
    if (redditRefOf(url)) return reddit(url, d);
    return undefined;
}
