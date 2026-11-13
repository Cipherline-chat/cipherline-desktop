// Which website is a browser tab's media from? (Windows)
//
// Chromium (system_media_controls_win.cc) and Firefox (WindowsSMTCProvider.cpp)
// hand Windows' media controls only title / artist / album / thumbnail: no page
// URL, no origin. So every browser tab is "a browser". What a browser DOES show
// locally is the page title in its window title, and a page title carries the
// site ("<video> - YouTube - Google Chrome", "Netflix - Google Chrome",
// "<stream> - Twitch"). The Windows helper (media-session.ts WINDOWS_SCRIPT)
// lists the top-level window titles of the PLAYING browser's own processes, and
// this pure module matches them against the playing session's title.
//
// Privacy: window titles go helper -> main process over the local stdout pipe
// and are read here, once, to derive a site KEY ("youtube"). Nothing keeps,
// logs or sends a title; only the key (an existing source value such as
// 'youtube' / 'netflix') can end up in the published record, and only when the
// user has switched on "Include my browser" (and, for videos, "Also share what
// I'm watching"). Windows of private / incognito browsing are skipped.
//
// Limits (by construction, not bugs):
//  - a window shows only its ACTIVE tab: a video playing in a background tab
//    is in no window title, so it stays "browser" - except for sites whose tab
//    title never carries the video's name (Netflix: the title is just
//    "Netflix"), which are matched on the bare site name when it is the only
//    candidate (`weak` rules);
//  - a title that merely contains a site's name never counts: the name must be
//    the page title's own suffix / prefix, and the session's title must be in
//    the page title.

/** Site keys; every one is also a valid source value on the wire (listening and / or watching). */
export type SiteKey =
    | 'youtube' | 'youtube_music' | 'spotify' | 'apple_music' | 'tidal' | 'deezer' | 'amazon_music' | 'soundcloud'
    | 'netflix' | 'prime_video' | 'disney_plus' | 'hulu' | 'crunchyroll' | 'twitch' | 'plex';

/** The browser processes the Windows helper may read window titles of (and nothing else). */
export const BROWSER_PROCESS_NAMES = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium'] as const;

interface Rule {
    key: SiteKey;
    /** The site's name as it ends a page title: "<page> - YouTube", "<page> | Prime Video". Lowercase. */
    names: string[];
    /** The name as it STARTS a page title: "Prime Video: <page>", "Disney+ | <page>". Lowercase. */
    heads?: string[];
    /** Also "<page> on <name>" (SoundCloud, Apple Music, Crunchyroll). */
    on?: boolean;
    /**
     * The site's playing tab keeps a bare page title ("Netflix"), so a window titled
     * exactly the name counts when it is the only candidate and the session title is
     * in no window at all.
     */
    weak?: boolean;
}

// YouTube Music before YouTube is not needed (the suffixes cannot overlap) but reads naturally.
const RULES: readonly Rule[] = [
    { key: 'youtube_music', names: ['youtube music'] },
    { key: 'youtube', names: ['youtube'] },
    { key: 'twitch', names: ['twitch'] },
    { key: 'netflix', names: ['netflix'], weak: true },
    { key: 'prime_video', names: ['prime video'], heads: ['prime video'], weak: true },
    { key: 'disney_plus', names: ['disney+'], heads: ['disney+'], weak: true },
    { key: 'hulu', names: ['hulu'], heads: ['hulu'], weak: true },
    { key: 'crunchyroll', names: ['crunchyroll'], heads: ['crunchyroll'], on: true, weak: true },
    { key: 'spotify', names: ['spotify'] },
    { key: 'apple_music', names: ['apple music'], on: true },
    { key: 'soundcloud', names: ['soundcloud'], on: true },
    { key: 'deezer', names: ['deezer'] },
    { key: 'tidal', names: ['tidal'] },
    { key: 'amazon_music', names: ['amazon music'] },
    { key: 'plex', names: ['plex'], heads: ['plex'], weak: true },
];

const JOINERS = [' - ', ' – ', ' — ', ' | ', ' · ', ' • '];
const HEAD_JOINERS = [...JOINERS, ': '];

/** A browser's own name, as it ends its window title ("... - Google Chrome", "... — Mozilla Firefox", "... - Microsoft Edge"). */
const BROWSER_TAG = /^(?:google chrome(?: (?:beta|dev|canary))?|chromium|brave(?: browser)?|vivaldi|opera(?: gx| beta| developer)?|microsoft edge(?: (?:beta|dev|canary))?|mozilla firefox|firefox(?: developer edition| nightly)?)$/;
/** Edge's [InPrivate] tag, Chrome's (Incognito), Firefox's "Private Browsing": such windows are never read. */
const PRIVATE = /inprivate|incognito|private browsing/;
const SEGMENT = /(\s+[-–—]\s+)/;

/** Lowercase, NFC, control / format characters (zero-width spaces, e.g. the one Edge puts inside its own name) dropped, whitespace collapsed. */
const norm = (s: string): string => s.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * One window title -> the page-title candidates it may hold, or [] for a
 * private window. The browser's own name (and, for Edge / Chrome with a profile,
 * the profile after / before it) is cut off; "(3) " notification counts and
 * Edge's "and 2 more pages" are removed. Two candidates because a profile name
 * ("Video - YouTube - Personal - Microsoft Edge") looks like one more page-title
 * segment: the second drops the last segment.
 */
export function pageTitleCandidates(windowTitle: string): string[] {
    const t0 = norm(windowTitle).replace(/\s+and \d+ more pages?/g, '').replace(/^\(\d{1,3}\+?\)\s+/, '');
    if (!t0) return [];
    const parts = t0.split(SEGMENT); // seg, sep, seg, sep, seg
    const n = Math.ceil(parts.length / 2);
    if (PRIVATE.test(parts.filter((_, i) => i % 2 === 0).slice(-3).join(' '))) return [];
    let t = t0;
    for (let i = n - 1; i >= Math.max(0, n - 3); i--) {
        if (BROWSER_TAG.test(parts[2 * i])) { t = i === 0 ? '' : parts.slice(0, 2 * i - 1).join(''); break; }
    }
    if (!t) return [];
    const out = [t];
    const pp = t.split(SEGMENT);
    if (pp.length >= 3) out.push(pp.slice(0, pp.length - 2).join(''));
    return out;
}

interface PageMatch { key: SiteKey; core: string; weakOk: boolean }

/** A page title -> the site it names (as its own suffix / prefix, never merely containing it), with the page title minus the site's name. */
function matchPage(page: string): PageMatch | null {
    for (const r of RULES) {
        for (const name of r.names) {
            if (page === name) return { key: r.key, core: '', weakOk: !!r.weak };
            for (const j of r.on ? [...JOINERS, ' on '] : JOINERS) if (page.endsWith(j + name)) return { key: r.key, core: page.slice(0, page.length - j.length - name.length), weakOk: false };
        }
        for (const h of r.heads ?? []) {
            for (const j of HEAD_JOINERS) if (page.startsWith(h + j)) return { key: r.key, core: page.slice(h.length + j.length), weakOk: false };
        }
    }
    return null;
}

/** Is `core` (a page title minus the site name) the session's title? */
const sameTitle = (core: string, t: string): boolean =>
    core === t || (t.length >= 4 && (core.includes(t) || (core.length >= 4 && t.includes(core))));

/**
 * The site of a browser's playing media session, from the browser's window
 * titles, or null (no confident match: stays a plain "browser").
 *
 *  1. STRONG: a window whose page title ends (or starts) with a known site's
 *     name and also holds the session's title. Windows that agree on one site
 *     decide; two different sites (the same title on two sites) decide nothing.
 *  2. Spotify's web player titles its tab "<song> • <artist>" (no site name).
 *  3. WEAK: when the session's title is in no window at all (Netflix's tab is
 *     titled just "Netflix"), a window titled exactly a `weak` site's name,
 *     when exactly one such site is open.
 */
export function siteFromWindowTitles(sessionTitle: string | null | undefined, windowTitles: readonly string[]): SiteKey | null {
    const t = typeof sessionTitle === 'string' ? norm(sessionTitle) : '';
    if (!t || !Array.isArray(windowTitles)) return null;
    const strong = new Set<SiteKey>();
    const weak = new Set<SiteKey>();
    let titleSeen = false;
    for (const w of windowTitles.slice(0, 32)) {
        if (typeof w !== 'string') continue;
        for (const c of pageTitleCandidates(w.slice(0, 400))) {
            if (t.length >= 4 && c.includes(t)) titleSeen = true;
            if (c.startsWith(t + ' • ')) { strong.add('spotify'); titleSeen = true; break; }
            const m = matchPage(c);
            if (!m) continue;
            if (sameTitle(m.core, t) && m.core !== '') { strong.add(m.key); titleSeen = true; break; }
            if (m.core === '' && m.weakOk) weak.add(m.key);
        }
    }
    if (strong.size === 1) return [...strong][0];
    if (strong.size > 1 || titleSeen) return null;
    return weak.size === 1 ? [...weak][0] : null;
}
