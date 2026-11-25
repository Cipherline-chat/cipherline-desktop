/**
 * Is a page snapshot worth showing? (pure; page-snapshot.ts gathers the facts)
 *
 * A link preview must never show a login page, a captcha or a bot wall, an
 * error page or a blank screen (owner, 2026-11-23). After the hidden window
 * has loaded the page, page-snapshot.ts collects a few facts about what is on
 * screen (its final URL, title, visible text, a visible password field,
 * captcha frames, challenge markers, how much is drawn) plus the main
 * document's HTTP status and whether the page tried to go to a sign-in host,
 * and measures how uniform the captured pixels are. This decides.
 *
 * Anything but 'ok' sends the designed no-picture card instead (site icon or
 * letter, site name, title): never the screenshot.
 */
import { CHALLENGE_TITLE_RE } from './parse-page';

export type SnapshotVerdict = 'ok' | 'login' | 'bot-wall' | 'error' | 'blank';

export interface PageFacts {
    /** Where the window ended up (after redirects). */
    finalUrl: string;
    title: string;
    /** The first ~2000 characters of the page's visible text, whitespace collapsed. */
    text: string;
    /** Length of all the visible text. */
    textLength: number;
    /** A visible `<input type=password>`. */
    visiblePassword: boolean;
    /** Visible iframes from captcha / challenge providers. */
    captchaFrames: number;
    /** Challenge markup in the document (Cloudflare, AWS WAF, DataDome, PerimeterX, Amazon). */
    challengeMarkers: boolean;
    /** Visible pictures (img / svg / canvas / video / picture) of a real size. */
    media: number;
}

export interface VerdictInput {
    facts: PageFacts | null;
    /** The main document's HTTP status (0 = unknown). */
    httpStatus: number;
    /** The page (or a redirect) tried to go to a sign-in host / path. */
    loginSeen: boolean;
    /** Share of the captured pixels in the most common colour (0..1). */
    uniformity: number;
}

/** Hosts that only ever show sign-in pages. */
const LOGIN_HOSTS = new Set([
    'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com', 'appleid.apple.com', 'idmsa.apple.com',
    'login.yahoo.com', 'signin.aws.amazon.com', 'auth.atlassian.com', 'id.atlassian.com', 'login.salesforce.com', 'sso.godaddy.com',
    'accounts.spotify.com', 'signin.ebay.com', 'id.twitch.tv', 'login.okta.com',
]);
const LOGIN_HOST_PREFIX_RE = /^(?:login|signin|sign-in|sso|auth|accounts|idp|secure-login)\./i;
const LOGIN_PATH_RE = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|logon|ServiceLogin|InteractiveLogin|session\/new|users\/sign_in|account\/login|ap\/signin|auth\/login|oauth2?\/authorize|saml2?|sso)(?:[/.?#]|$)/i;

/** A sign-in URL (a login host, or a login path on any host). */
export function isLoginUrl(raw: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (LOGIN_HOSTS.has(host) || LOGIN_HOST_PREFIX_RE.test(host)) return true;
    return LOGIN_PATH_RE.test(u.pathname);
}

const BOT_TEXT_RE = /just a moment\.\.\.|checking (?:your|if the site connection is secure|the site connection)|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|unusual traffic from your (?:computer|network)|press (?:&|and) hold|complete the security check|enable javascript and cookies to continue|you have been blocked|you've been blocked|access to this page has been denied|request unsuccessful\. incapsula|pardon our interruption|attention required!? \| cloudflare|performing security verification|ray id: [0-9a-f]{10,}|why have i been blocked|solve the (?:captcha|puzzle)|(?:you(?:'|’)re|you are|i(?:'|’)m|i am) not a robot/i;
const LOGIN_TITLE_RE = /^(?:sign[ -]?in|log[ -]?in|login|sign[ -]?on|log on)\b|\b(?:sign[ -]?in|log[ -]?in) (?:to|with|[-–|:])\b|^(?:google|microsoft|apple) accounts?$|\bsign in - google accounts\b/i;
const LOGIN_TEXT_RE = /\b(?:sign in to continue|log in to continue|you need (?:to sign in|permission)|request access|sign in to (?:view|access|open)|you must (?:be )?(?:log(?:ged)? in|sign(?:ed)? in))\b/i;
const ERROR_TITLE_RE = /^(?:4\d\d|5\d\d)\b|\b(?:404|403|410|500|502|503|504)\b.*(?:error|not found|forbidden|unavailable)|\b(?:page|file|site) (?:not found|unavailable|does(?:n't| not) exist)\b|^not found$|^(?:error|forbidden|service unavailable|bad gateway|gateway time-?out|internal server error)\b|^problem loading page$|this site can(?:'|’)t be reached/i;

/**
 * The verdict for one loaded page. `facts` null (the page could not be read:
 * a hung or crashed renderer) is never shown.
 */
export function judgePage(v: VerdictInput): SnapshotVerdict {
    const f = v.facts;
    if (!f) return 'blank';
    if (v.loginSeen || isLoginUrl(f.finalUrl)) return 'login';
    const title = f.title.trim();
    const text = f.text;
    if (f.challengeMarkers || f.captchaFrames > 0 || CHALLENGE_TITLE_RE.test(title) || BOT_TEXT_RE.test(title) || (f.textLength < 4000 && BOT_TEXT_RE.test(text))) return 'bot-wall';
    if (v.httpStatus >= 400) return 'error';
    if (LOGIN_TITLE_RE.test(title)) return 'login';
    // A visible password box on a page that is mostly that box is a login page;
    // a long article with a sign-in widget in its header is not.
    if (f.visiblePassword && f.textLength < 2500) return 'login';
    if (f.textLength < 1500 && LOGIN_TEXT_RE.test(text)) return 'login';
    if (f.textLength < 1500 && ERROR_TITLE_RE.test(title)) return 'error';
    // Blank: nothing to read and nothing drawn, or one flat colour.
    if (f.textLength < 25 && f.media === 0) return 'blank';
    if (v.uniformity >= 0.995 || (v.uniformity >= 0.97 && f.textLength < 25)) return 'blank';
    return 'ok';
}

/**
 * Share of pixels in the most common colour (each channel quantised to 4
 * bits), sampled on a grid. `bitmap` is 32-bit pixels (BGRA or RGBA: the
 * channel order does not change the answer). 1 = one flat colour.
 */
export function pixelUniformity(bitmap: Uint8Array, width: number, height: number, step = 6): number {
    if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return 1;
    const counts = new Map<number, number>();
    let n = 0;
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 4;
            const key = ((bitmap[i] >> 4) << 8) | ((bitmap[i + 1] >> 4) << 4) | (bitmap[i + 2] >> 4);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            n++;
        }
    }
    let top = 0;
    for (const c of counts.values()) if (c > top) top = c;
    return n ? top / n : 1;
}

/**
 * The facts script, run in an ISOLATED world of the snapshot window (the
 * page's own scripts cannot see or patch it). Returns a PageFacts-shaped
 * object; page-snapshot.ts validates every field before judging.
 */
export const PAGE_FACTS_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const body = document.body;
  const raw = body ? (body.innerText || '') : '';
  const text = raw.replace(/\\s+/g, ' ').trim();
  const frames = [...document.querySelectorAll('iframe')].filter((f) => /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|captcha-delivery|arkoselabs|funcaptcha|geo\\.captcha|perimeterx|px-cdn|awswaf/i.test(f.src || '') && vis(f)).length;
  const html = document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '';
  const markers = /cf-chl-|_cf_chl_opt|challenge-platform|id="challenge-form"|AwsWafIntegration|captcha-delivery\\.com|px-captcha|validateCaptcha|cf-turnstile|g-recaptcha|h-captcha/i.test(html);
  const pw = [...document.querySelectorAll('input[type=password]')].some(vis);
  const media = [...document.querySelectorAll('img, svg, canvas, video, picture')].filter((e) => { const r = e.getBoundingClientRect(); return r.width * r.height >= 2500 && r.top < innerHeight && r.bottom > 0 && vis(e); }).length;
  return { finalUrl: location.href, title: document.title || '', text: text.slice(0, 2000), textLength: text.length, visiblePassword: pw, captchaFrames: frames, challengeMarkers: markers, media };
})()`;

/** A PageFacts from whatever the isolated script returned (anything malformed: null). */
export function cleanFacts(v: unknown): PageFacts | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, 1e9) : 0);
    if (typeof o.finalUrl !== 'string') return null;
    return {
        finalUrl: str(o.finalUrl, 4096),
        title: str(o.title, 500),
        text: str(o.text, 2000),
        textLength: num(o.textLength),
        visiblePassword: o.visiblePassword === true,
        captchaFrames: num(o.captchaFrames),
        challengeMarkers: o.challengeMarkers === true,
        media: num(o.media),
    };
}
