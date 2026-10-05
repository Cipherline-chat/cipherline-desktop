/**
 * Curated well-known image/GIF CDN hosts.
 *
 * Two independent, unrelated uses of the same list — see ChatPane.tsx:
 *
 *  1. Detection (`isImageUrl`) — some of these CDNs serve direct binary
 *     media WITHOUT a recognizable file extension in the URL path. That's
 *     safe to assume ONLY on a host whose entire purpose is asset-serving
 *     (never HTML), so it can't accidentally swallow a share/gallery page.
 *     Concrete, documented cases: Imgur's `i.imgur.com/<id>` content-
 *     negotiates the format when the extension is omitted; Twitter/X's
 *     `pbs.twimg.com` encodes the format in a `?format=` query param
 *     instead of the path. Giphy/Tenor's own CDN subdomains are included
 *     too but NOT marked extensionless — their real media URLs already
 *     carry a `.gif`/`.webp` extension by convention, so no bypass is
 *     needed there and claiming one would be unjustified.
 *
 *  2. Auto-load gating (the "known hosts only" privacy setting, see
 *     usePrivacySettings' `imageAutoLoad`) — a fetch to a large third-party
 *     CDN the message SENDER does not operate cannot hand the sender a
 *     read receipt or the viewer's IP; only the CDN operator (not a party
 *     to the conversation) sees the request. That is a materially
 *     different threat than a link to a server the sender controls, which
 *     is exactly what the click-to-load gate exists to stop. So these
 *     hosts are safe to auto-load; every other host stays gated.
 *
 * Deliberately EXCLUDES each service's page/share host (bare `giphy.com`,
 * `tenor.com`, `imgur.com`, `twitter.com`/`x.com`) — those serve HTML
 * pages, not raw media, and belong to neither list above. `endsWith` on a
 * leading-dot suffix (e.g. `.giphy.com`) already excludes the bare domain
 * (`'giphy.com'.endsWith('.giphy.com')` is false — the target is shorter
 * than the suffix), so no extra exclusion logic is needed.
 */

export type HostMatchMode = 'exact' | 'suffix';

export interface KnownImageHost {
    /** Exact hostname, or a leading-dot suffix for a family of subdomains. */
    host: string;
    match: HostMatchMode;
    /** True when ANY path on this host counts as image-shaped even without
     *  a recognized file extension — only for hosts that serve media and
     *  nothing else, so there's no HTML-page path to misclassify. */
    extensionless: boolean;
    why: string;
}

export const KNOWN_IMAGE_HOSTS: readonly KnownImageHost[] = [
    {
        host: '.giphy.com', match: 'suffix', extensionless: false,
        why: 'Giphy media CDN (media0-4.giphy.com, i.giphy.com) — asset-only subdomains, never the giphy.com share-page host. Real media URLs already carry an extension.',
    },
    {
        host: '.tenor.com', match: 'suffix', extensionless: false,
        why: 'Tenor media CDN (media*.tenor.com, c.tenor.com) — asset-only subdomains, never the tenor.com share-page host. Real media URLs already carry an extension.',
    },
    {
        host: 'i.imgur.com', match: 'exact', extensionless: true,
        why: "Imgur's dedicated direct-media host (as opposed to imgur.com, the gallery/page host); content-negotiates format even when the URL omits an extension.",
    },
    {
        host: 'cdn.discordapp.com', match: 'exact', extensionless: false,
        why: 'Discord attachment/emoji CDN.',
    },
    {
        host: 'media.discordapp.net', match: 'exact', extensionless: false,
        why: "Discord's attachment proxy CDN. Note the TLD: .net, not .com — this was originally listed as media.discordapp.com, which is not a Discord host at all, so every Discord GIF fell through to the click-to-load gate. Discord link URLs are SIGNED and time-limited (?ex=&is=&hm=), so an embed that works today can 404 once the signature expires; that is the origin expiring the link, not a fetch bug on our side.",
    },
    {
        host: 'pbs.twimg.com', match: 'exact', extensionless: true,
        why: "Twitter/X media CDN (as opposed to twitter.com/x.com, the page host); encodes format in a ?format= query param rather than the path.",
    },
] as const;

function hostMatches(hostname: string, entry: KnownImageHost): boolean {
    return entry.match === 'exact' ? hostname === entry.host : hostname.endsWith(entry.host);
}

/** True when `hostname` is one of the curated CDN hosts above (any entry,
 *  regardless of the `extensionless` flag). Used for auto-load gating. */
export function isKnownImageHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return KNOWN_IMAGE_HOSTS.some(entry => hostMatches(h, entry));
}

/** True when `hostname` is a curated CDN host that serves media at paths
 *  with no recognizable file extension. Used to extend `isImageUrl`
 *  detection beyond the plain extension check. */
export function isKnownExtensionlessImageHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return KNOWN_IMAGE_HOSTS.some(entry => entry.extensionless && hostMatches(h, entry));
}

/** The `imageAutoLoad` setting shape (mirrors usePrivacySettings'
 *  `ImageAutoLoadMode`, redeclared here so this module has no dependency on
 *  a React hook — kept in sync by imageHosts.test.ts exercising all three
 *  literal values against usePrivacySettings' own default). */
export type ImageAutoLoadMode = 'always' | 'known' | 'never';

/** Pure auto-load eligibility decision — given the user's setting and the
 *  link's hostname, should this embed skip the click-to-load gate? Kept
 *  separate from the component so every (mode × host) combination is
 *  directly unit-testable without mounting React. */
export function shouldAutoLoadImage(mode: ImageAutoLoadMode, hostname: string): boolean {
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return isKnownImageHost(hostname);
}

// Matches common direct image file extensions in the URL path. Tested only
// against `.pathname` (never `.search`/`.hash`), which can't contain '?' or
// '#' — ChatPane.tsx's previous copy of this regex carried a dead
// `(\?[^#]*)?(?:#.*)?` alternation for exactly that reason.
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

/** Matches a `.gif` link specifically (used to pick the GifPlayer vs a plain
 *  `<img>` once something has already been detected as an image). */
const GIF_EXT_RE = /\.gif$/i;

/** Detects a direct image/GIF link two ways: the file extension (fast path,
 *  works for the overwhelming majority of real CDN URLs), and — only for a
 *  curated list of asset-only CDN hosts where an HTML page is structurally
 *  impossible — a host-based fallback for the handful of CDNs that omit the
 *  extension by design (Imgur, Twitter/X media). See KNOWN_IMAGE_HOSTS above
 *  for the exact list and the reasoning. Never fetches anything (pure string/
 *  URL-shape check), so it can't leak the click-to-load privacy property
 *  it's feeding into. Never throws — a malformed URL is just "not an image".
 */
export function isImageUrl(url: string): boolean {
    try {
        const { hostname, pathname } = new URL(url);
        return IMAGE_EXT_RE.test(pathname) || isKnownExtensionlessImageHost(hostname);
    } catch { return false; }
}

/** True for a URL whose extension is specifically `.gif` — everything else
 *  detected by `isImageUrl` (jpg/png/webp/avif/bmp, plus the extensionless
 *  known-host cases) renders as a plain `<img>` instead of the animated
 *  GifPlayer. An extensionless known-host GIF (rare — none of the current
 *  extensionless hosts are GIF-only) falls back to `<img>`, which still
 *  displays it correctly, just without GifPlayer's play/pause affordance. */
export function isGifUrl(url: string): boolean {
    try { return GIF_EXT_RE.test(new URL(url).pathname); }
    catch { return false; }
}
