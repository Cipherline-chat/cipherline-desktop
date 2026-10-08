/**
 * Diagnostic-report scrubber — the privacy gate every crash / issue report
 * passes through before the user is shown a preview, before it is saved to a
 * file, and before it is uploaded.
 *
 * WHY THIS EXISTS: Cipherline's promise is that the server never sees
 * plaintext. A diagnostic report is the one place where free text produced on
 * the device (an error message, a stack trace, a user's description) leaves it
 * unencrypted, so anything identifying that leaks into such text would break
 * that promise through a side door. Error messages are not under our control —
 * a thrown DOMException can quote a URL, a Node error quotes a file path, a
 * library may interpolate whatever it was handed.
 *
 * RULES, in the order they run (order matters — see the inline notes):
 *   0. NFKC-normalise; strip invisible format characters (zero-width joiners,
 *      bidi overrides) and control characters; cap the input at
 *      MAX_SCRUB_INPUT before any regex runs (no pathological backtracking).
 *   1. The caller's known home directory → `~`.
 *   2. PEM blocks → <pem>; JWTs → <jwt>; `Bearer|Basic|Token|Digest xxx` →
 *      `Bearer <redacted>`.
 *   3. URLs. Unknown hosts → <url> (the whole URL, host included: a hostname
 *      in an error can be a link someone sent). Cipherline API / localhost /
 *      app-internal schemes keep a CODE path with each segment re-checked, the
 *      query becomes `?<query>`, a trailing :line:col is kept. Other
 *      *.cipherline.chat hosts (media, updates — presigned object keys) keep
 *      the host only. file:// URLs go through the path rule.
 *   4. `secret-ish-key = value` / `"key": "value"` pairs → value <redacted>
 *      (token, password, key, signature, session, cookie, x-amz-*, file_key…).
 *   5. Emails (incl. %40-encoded) → <email>.
 *   6. Home directories (`C:\Users\<name>`, `/home/<name>`, `/Users/<name>`,
 *      `/root`) → `~`; then every absolute path is reduced to a code location
 *      (`app.asar/dist/assets/index-x.js:1:2`) if — and only if — its basename
 *      is a code file; anything else (a document, a folder) → <path>. Names
 *      with spaces are handled, so `secret plan.docx` cannot leak its tail.
 *   7. Caller-supplied sensitive terms (usernames, display names, server /
 *      channel / conversation names, the OS account name) → <name>,
 *      case-insensitive, whole-word. Runs AFTER paths so a name inside a path
 *      cannot split the path and strand a file name; kept path/URL segments
 *      are checked against the same terms.
 *   8. LiveKit SIDs → <sid>; UUIDs → <id>; IPv4/IPv6 (± port) → <ip>; bare
 *      domains on common TLDs outside the allowlist → <domain>;
 *      `+`-prefixed international phone numbers → <phone>; @mentions →
 *      `@<user>`.
 *   9. Hex runs ≥ 20 chars → <hex>; base64/base64url tokens ≥ 20 chars that
 *      look random (padding, or character-class churn — see
 *      looksLikeEncodedBlob) → <b64>.
 *
 * Every replacement is wrapped in sentinel characters so later rules never
 * rewrite an earlier rule's output (and input cannot forge a placeholder:
 * the sentinels are control characters, stripped in step 0).
 *
 * This file is copied VERBATIM to `apps/desktop/electron/diagnostics-scrub.ts`
 * (the main process cannot import from src/ — see the electron rootDir trap in
 * CLAUDE.md); `scrubCopies.test.ts` fails if the two drift. The API keeps its
 * own re-scrub (`apps/api/src/diagnostics/scrub.ts`) as defence in depth.
 *
 * No imports, no DOM, no Node APIs: pure string functions.
 */

export const SCRUB_VERSION = 1;

/** Hard cap on what any single string may be before scrubbing starts. */
export const MAX_SCRUB_INPUT = 20_000;

export interface ScrubOptions {
    /**
     * Literal strings that must never appear in the output (case-insensitive,
     * whole-word). Terms shorter than 3 characters are ignored — they would
     * shred ordinary text — and at most MAX_TERMS are used, longest first.
     */
    sensitiveTerms?: readonly string[];
    /** Absolute home directory of the OS account, if known. */
    homeDir?: string;
    /** Output cap in characters (after scrubbing). Default 4000. */
    maxLength?: number;
}

export const MAX_TERMS = 2000;
const MIN_TERM_LENGTH = 3;

/** Hosts whose URLs may keep a (scrubbed) path. */
const PATH_HOSTS = /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:www\.|api(?:-staging)?\.)?cipherline\.chat)$/i;
/** Hosts that are ours but whose paths are object keys / user data. */
const OPAQUE_PATH_HOSTS = /^(?:[a-z0-9-]+\.)*cipherline\.chat$/i;
/** Bare domains that are fine to mention (infrastructure, not content). */
const DOMAIN_ALLOW = /^(?:(?:[a-z0-9-]+\.)*cipherline\.chat|localhost)$/i;
/**
 * TLDs we treat as "this is a hostname". Deliberately excludes TLDs that
 * collide with code (`.js`, `.ts`, `.app`, `.dev`, `.map`, `.json`, `.node`,
 * `.zip`, `.mov`, `.sh`) so `electron.app` or `main.js` are left alone.
 */
const DOMAIN_TLDS = 'com|net|org|io|co|gg|me|tv|xyz|info|biz|us|uk|ca|de|fr|ru|cn|jp|br|in|au|nl|eu|es|it|pl|se|no|fi|ch|at|be|cz|kr|tw|ly|to|fm|ai|cc|ws|live|chat|online|site|store|tech|link|club|shop|top|social|email|cloud|space|page';

/** Code-file extensions that may survive as a path basename. */
const CODE_EXT = /\.(?:m?js|cjs|jsx|tsx?|node|wasm|html?|dll|exe|so|dylib|asar|pak)$/i;
/** Path anchors: the part of a code path that identifies the code, not the machine. */
const PATH_ANCHORS = ['app.asar', 'app.asar.unpacked', 'resources', 'node_modules', 'dist-electron', 'dist', 'electron', 'src', 'assets', 'build', 'out'];

// Sentinels around every replacement. Control characters, so step 0 strips
// any the input tries to smuggle in.
const S_OPEN = '\u0001';
const S_CLOSE = '\u0002';
const protect = (s: string): string => S_OPEN + s + S_CLOSE;
// eslint-disable-next-line no-control-regex -- the sentinels ARE control characters, by design
const RE_PROTECTED_SPLIT = /(\u0001[^\u0002]*\u0002)/;
// eslint-disable-next-line no-control-regex -- see RE_PROTECTED_SPLIT
const RE_SENTINELS = /[\u0001\u0002]/g;

// ── individual patterns ─────────────────────────────────────────────────────

// Format characters plus the invisible fillers Unicode does not class as Cf
// (U+034F is a combining mark, hence the misleading-class rule is moot here).
// eslint-disable-next-line no-misleading-character-class
const RE_FORMAT_CHARS = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u3164\uFFA0]/gu;
// eslint-disable-next-line no-control-regex
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const RE_PEM = /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g;
const RE_JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g;
const RE_AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SECRET_KEYS = 'access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|password|passwd|pwd|pass|secret|client[_-]?secret|api[_-]?key|apikey|key|private[_-]?key|signature|sig|session(?:[_-]?id)?|sid|cookie|set-cookie|otp|totp|x-amz-[a-z-]+|x-cipherline-attest|attest|credential|file[_-]?key(?:[_-]?b64)?|transfer[_-]?key(?:[_-]?b64)?|call[_-]?key|nonce|iv|salt';
const RE_SECRET_KV = new RegExp(`(["']?)\\b(${SECRET_KEYS})\\1(\\s*[:=]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"'&,;)}\\]]+)`, 'gi');
const RE_URL = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>()[\]{}`\\]*)/gi;
const RE_EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})*\.\p{L}{2,24}/gu;
const RE_EMAIL_ENCODED = /[\w.+-]{1,64}%40[\w-]{1,63}(?:\.[\w-]{1,63})*\.[a-z]{2,24}/gi;
const RE_EMAIL_WHOLE = /^[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})*\.\p{L}{2,24}$/u;

// Home directories. Names may contain spaces, so the segment runs to the next
// separator (or the end of a quoted string / line).
const RE_WIN_HOME = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"'<>|]{1,64}?(?=[\\/]|$|["'])/gi;
const RE_WIN_HOME_BARE = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'<>|]{1,64}/gi;
const RE_POSIX_HOME_SPACED = /(?<![\w.])\/(?:home|Users)\/[^/\r\n"'<>]{1,64}?(?=\/)/g;
const RE_POSIX_HOME = /(?<![\w.])\/(?:home|Users)\/[^/\s"'<>()]{1,64}/g;
const RE_ROOT_HOME = /(?<![\w.])\/root(?=\/|\b)/g;

// The last segment of a path may contain spaces only if it ends in an
// extension followed by a delimiter — that is how `secret plan.docx` is caught
// whole without swallowing the rest of the sentence.
const LAST_SEG_SPACED = String.raw`[^\\/:*?"'<>|\r\n]{1,128}?\.[A-Za-z0-9]{1,8}(?=[\s'"),;\]}]|:\d|$)`;
const LAST_SEG_PLAIN = String.raw`[^\\/:*?"'<>|\r\n\s]{0,128}`;
// Drive, UNC, or `~` roots; either separator; spaces allowed inside non-final
// segments (`C:\Program Files\…`, `~\My Documents\…`).
const RE_WIN_PATH = new RegExp(
    String.raw`(?:(?<![\w+/=])[A-Za-z]:|\\\\[^\\\s]{1,64}|(?<![\w~+/=])~(?=[\\/]))[\\/]+(?:[^\\/:*?"'<>|\r\n]{1,128}[\\/]+){0,40}(?:${LAST_SEG_SPACED}|${LAST_SEG_PLAIN})`,
    'g',
);
// POSIX roots where user data lives may contain spaces in their segments.
const RE_POSIX_ROOTED = new RegExp(
    String.raw`(?<![\w.:/~+=-])\/(?:Volumes|Library|Applications|mnt|media|private|tmp|var|opt|srv|run|snap|data|storage|sdcard)(?:\/[^/:*?"'<>|\r\n]{1,128}?(?=\/))*\/(?:${LAST_SEG_SPACED}|${LAST_SEG_PLAIN})`,
    'g',
);
const RE_POSIX_PATH = /(?<![\w.:/~+=-])\/(?:[^\s/:"'<>()[\]{},;`]{1,128}\/){1,40}[^\s/:"'<>()[\]{},;`]{0,128}(?::\d{1,7}(?::\d{1,7})?)?/g;
const RE_LINE_COL = /(:\d{1,7}(?::\d{1,7})?)$/;
const RE_API_ROUTE = /^\/v\d{1,2}(?:\/[A-Za-z0-9_.:-]{1,64})*\/?$/;

const RE_MENTION = /(?<![\w.@])@[\p{L}\p{N}_.-]{2,32}(?![\p{L}\p{N}_/@-])/gu;
const RE_PHONE = /(?<![\w+])\+\d[\d ().-]{7,18}\d(?!\d)/g;
const RE_LIVEKIT_SID = /\b(?:PA|TR|RM|PS|SS|EG|IN|DP|AG|SIP|ST|EP)_[A-Za-z0-9]{6,}\b/g;
const RE_LIVEKIT_SID_WHOLE = /^(?:PA|TR|RM|PS|SS|EG|IN|DP|AG|SIP|ST|EP)_[A-Za-z0-9]{6,}$/;
/** Tokens at least this long (a 32-byte key is 43+ chars) are blob-checked before the substring rules. */
const BLOB_FIRST_MIN = 40;
// A SID-shaped run anywhere inside a token — NO boundary, on purpose: used to
// spot an encoded blob (base64 / base64url key) that merely CONTAINS one.
const RE_LIVEKIT_SID_INSIDE = /(?:PA|TR|RM|PS|SS|EG|IN|DP|AG|SIP|ST|EP)_[A-Za-z0-9]{6,}/;
const RE_UUID = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi;
const RE_UUID_INSIDE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const RE_IPV4 = /(?<![\w.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w.]*\d)(?::\d{1,5})?/g;
const RE_IPV6_FULL = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?:%[\w.]{1,16})?(?![\w:])/gi;
const RE_IPV6_COMPRESSED = /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:(?:[0-9a-f]{1,4}:){0,5}(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?:%[\w.]{1,16})?(?![\w:]|\.\d)/gi;
const RE_DOMAIN = new RegExp(`(?<![\\w.@/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${DOMAIN_TLDS})(?![\\w-]|\\.[\\w])(?::\\d{1,5})?`, 'gi');
const RE_HEX = /(?<![\w])(?:0x)?[0-9a-f]{20,}(?![\w])/gi;
const RE_HEX_INSIDE = /[0-9a-f]{20,}/i;
const RE_B64 = /(?<![\w+/-])[A-Za-z0-9+/_-]{20,}={0,2}(?![\w+/-])/g;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
    if (!s) return 0;
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    const n = s.length;
    for (const c of counts.values()) {
        const p = c / n;
        h -= p * Math.log2(p);
    }
    return h;
}

const charClass = (c: string): number => (c >= 'A' && c <= 'Z' ? 0 : c >= 'a' && c <= 'z' ? 1 : c >= '0' && c <= '9' ? 2 : 3);

/** Share of adjacent character pairs that switch class (upper/lower/digit/other). */
function classChurn(b: string): number {
    if (b.length < 2) return 0;
    let changes = 0;
    for (let i = 1; i < b.length; i++) if (charClass(b[i]) !== charClass(b[i - 1])) changes++;
    return changes / (b.length - 1);
}

/**
 * Is this base64-alphabet token a random blob (key, nonce, signature,
 * ciphertext) rather than an identifier?
 *
 * Random base64 flips between upper / lower / digit / symbol on roughly two
 * of every three adjacent characters; code identifiers (`handleScreenShare
 * Start`, `MediaFoundationVideoEncodeAccelerator`) and hyphenated labels flip
 * only at word boundaries (well under 0.35). '=' padding is decisive on its
 * own. scrub.test.ts fuzzes this: 0 misses on random 32/64-byte keys in
 * base64, base64url and hex; < 0.5% on 16/24-byte tokens (letter-only short
 * tokens can read as words — a documented residual; nothing this app treats
 * as secret is that short).
 */
export function looksLikeEncodedBlob(token: string): boolean {
    const padded = /={1,2}$/.test(token);
    const body = token.replace(/=+$/, '');
    if (body.length < 16) return false;
    if (padded && /[A-Za-z]/.test(body) && /[A-Z0-9+/]/.test(body)) return true;
    if (body.length < 20) return false;
    if (body.includes('/')) {
        // A relative code path (`app.asar/dist/assets/index-AbC12x9Z.js`) is
        // made of word-like pieces; a key that happens to contain '/' is not.
        // Judge the pieces on their own, then the whole on raw churn.
        if (body.split('/').some(p => p.length >= 16 && looksLikeEncodedBlob(p))) return true;
        return classChurn(body) >= 0.5;
    }
    const churn = classChurn(body);
    if (churn >= 0.4) return true;
    if ((body.match(/\d+/g) ?? []).length >= 3) return true;
    const w = wordiness(body);
    // Long tokens: a 32-byte key can land on long single-case runs and low
    // churn, but it never reads as words the way a long identifier does.
    // 0.8, not 0.65: unpadded 43-char base64url keys with churn 0.33–0.38 and
    // wordiness 0.66–0.67 slipped through at 0.65 (≈1 in 80k random keys —
    // enough to make the fuzz test below flaky). Real long identifiers score
    // ≥ 0.88 (MediaFoundationVideoEncodeAccelerator = 1.0).
    // …and a second, independent tell: identifiers are made of real words, a
    // random key is not — 4+ lone one- or two-letter pieces (`L`, `D`, `Uu`)
    // in a 32+ char token never occurs in camelCase code. This closes the one
    // key a 1.6M-key fuzz found sitting exactly on the 0.8 cut-off (w = 0.800).
    if (body.length >= 32 && churn >= 0.2 && (w < 0.8 || shortLetterPieces(body) >= 4)) return true;
    return churn >= 0.25 && w < 0.6;
}

/** How many letter pieces of the token are 1–2 characters (`L`, `D`, `Uu`). */
function shortLetterPieces(b: string): number {
    return (b.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []).filter(p => p.length <= 2).length;
}

/**
 * Share of a token made of plausible "words": camelCase / snake / kebab
 * pieces of 3+ letters with a natural vowel ratio, short numbers, separators,
 * and (half-weighted) short acronyms. Identifiers score ~0.8–1.0; random
 * base64 rarely clears 0.6.
 */
function wordiness(b: string): number {
    const pieces = b.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|[^A-Za-z\d]+/g) ?? [];
    let good = 0;
    for (const p of pieces) {
        if (/^\d{1,4}$/.test(p) || /^[^A-Za-z\d]+$/.test(p)) { good += p.length; continue; }
        if (/^[A-Z]{2,5}$/.test(p)) { good += p.length * 0.5; continue; }
        if (p.length >= 3 && /^[A-Za-z]+$/.test(p)) {
            const v = (p.match(/[aeiouy]/gi) ?? []).length / p.length;
            if (v >= 0.2 && v <= 0.7 && !/[^aeiouy]{5,}/i.test(p)) good += p.length;
        }
    }
    return good / b.length;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the literal-term matcher once per scrubber. */
function buildTermsSource(terms: readonly string[] | undefined): string | null {
    if (!terms || terms.length === 0) return null;
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of terms) {
        if (typeof raw !== 'string') continue;
        const t = normalizeText(raw).trim();
        if (t.length < MIN_TERM_LENGTH || t.length > 200) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        cleaned.push(t);
    }
    if (cleaned.length === 0) return null;
    cleaned.sort((a, b) => b.length - a.length);
    const alternation = cleaned.slice(0, MAX_TERMS).map(escapeRegExp).join('|');
    return `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`;
}

/** NFKC + drop invisible/format and control characters (keeps \n and \t). */
export function normalizeText(s: string): string {
    let out = s;
    try { out = out.normalize('NFKC'); } catch { /* lone surrogate etc. — keep raw */ }
    return out.replace(RE_FORMAT_CHARS, '').replace(RE_CONTROL, '');
}

/** Check one kept path / URL segment; returns it or a placeholder. */
function scrubSegment(seg: string, termsTest: RegExp | null): string {
    if (seg === '' || seg === '<path>') return seg;
    if (RE_EMAIL_WHOLE.test(seg) || seg.includes('@') && /\.[a-z]{2,}$/i.test(seg)) return '<email>';
    if (RE_LIVEKIT_SID_WHOLE.test(seg)) return '<sid>';
    if (RE_UUID_INSIDE.test(seg)) return '<id>';
    if (RE_HEX_INSIDE.test(seg)) return '<hex>';
    if (!/^[A-Za-z0-9_.@+:-]{1,64}$/.test(seg)) return '<seg>';
    for (const piece of seg.split(/[.:]/)) if (looksLikeEncodedBlob(piece)) return '<b64>';
    if (termsTest && termsTest.test(seg)) return '<seg>';
    return seg;
}

/** Reduce one absolute path to something that names CODE, not the machine. */
function reducePathWith(rawPath: string, termsTest: RegExp | null): string {
    const m = RE_LINE_COL.exec(rawPath);
    const lineCol = m ? m[1] : '';
    const pathOnly = lineCol ? rawPath.slice(0, -lineCol.length) : rawPath;
    const segs = pathOnly.replace(/\\/g, '/').split('/').filter(s => s.length > 0 && s !== '.');
    if (segs.length === 0) return '<path>';
    const base = segs[segs.length - 1];
    if (!CODE_EXT.test(base) || /\s/.test(base)) return '<path>';
    // Innermost node_modules wins (the package that threw); otherwise the
    // FIRST anchor, so `app.asar/dist/assets/x.js` keeps its in-app layout.
    let from = -1;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i].toLowerCase();
        if (PATH_ANCHORS.includes(s) && (from === -1 || s === 'node_modules')) from = i;
    }
    const kept = from >= 0 ? segs.slice(from) : ['<path>', base];
    return kept.map(s => scrubSegment(s, termsTest)).join('/') + lineCol;
}

/** Exported for tests: path reduction with no sensitive terms. */
export function reducePath(rawPath: string): string {
    return reducePathWith(rawPath, null);
}

function scrubUrlWith(scheme: string, rest: string, termsTest: RegExp | null): string {
    const lower = scheme.toLowerCase();
    if (lower === 'file') {
        let p = rest;
        try { p = decodeURIComponent(rest); } catch { /* keep encoded */ }
        const lc = /(:\d{1,7}(?::\d{1,7})?)$/.exec(p);
        const tail = lc ? lc[1] : '';
        if (tail) p = p.slice(0, -tail.length);
        p = p.replace(/[?#].*$/, '');
        return 'file://' + reducePathWith(p.replace(/^\/(?=[A-Za-z]:)/, '') + tail, termsTest);
    }
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    let pathAndMore = slash === -1 ? '' : rest.slice(slash);
    const hostPort = authority.replace(/^[^@]*@/, '');
    const host = hostPort.replace(/:\d+$/, '');
    const port = /:(\d+)$/.exec(hostPort);
    const internalScheme = /^(?:app|devtools|chrome|chrome-extension|node|electron|cipherline)$/.test(lower);
    if (!internalScheme && !PATH_HOSTS.test(host)) {
        if (OPAQUE_PATH_HOSTS.test(host)) return `${lower}://${host.toLowerCase()}${pathAndMore ? '/<path>' : ''}`;
        return '<url>';
    }
    const lc = /(:\d{1,7}(?::\d{1,7})?)$/.exec(pathAndMore);
    const tail = lc ? lc[1] : '';
    if (tail) pathAndMore = pathAndMore.slice(0, -tail.length);
    const q = pathAndMore.search(/[?#]/);
    const hadQuery = q !== -1;
    const path = (hadQuery ? pathAndMore.slice(0, q) : pathAndMore)
        .split('/')
        .map(seg => {
            if (seg === '') return seg;
            let s = seg;
            try { s = decodeURIComponent(seg); } catch { /* keep */ }
            return scrubSegment(s, termsTest);
        })
        .join('/');
    const hostOut = internalScheme ? scrubSegment(host, termsTest) : host.toLowerCase() + (port ? `:${port[1]}` : '');
    return `${lower}://${hostOut}${path}${hadQuery ? '?<query>' : ''}${tail}`;
}

/** Apply `re` to every part of `s` that is not already a protected span. */
function replaceUnprotected(s: string, re: RegExp, fn: (m: string, ...g: string[]) => string): string {
    const parts = s.split(RE_PROTECTED_SPLIT);
    for (let i = 0; i < parts.length; i += 2) {
        if (parts[i]) {
            re.lastIndex = 0;
            parts[i] = parts[i].replace(re, fn as (substring: string, ...args: unknown[]) => string);
        }
    }
    return parts.join('');
}

export interface Scrubber {
    /** Scrub one free-text string. Non-strings are coerced; null/undefined → ''. */
    text(input: unknown, maxLength?: number): string;
    /** Scrub a stack trace: at most `maxFrames` frames after the message line. */
    stack(input: unknown, maxFrames?: number): string;
}

export function createScrubber(opts: ScrubOptions = {}): Scrubber {
    const termsSource = buildTermsSource(opts.sensitiveTerms);
    const termsRe = termsSource ? new RegExp(termsSource, 'giu') : null;
    const termsTest = termsSource ? new RegExp(termsSource, 'iu') : null;
    const defaultMax = opts.maxLength ?? 4000;
    const homeDir = typeof opts.homeDir === 'string' && normalizeText(opts.homeDir).length >= 3 ? normalizeText(opts.homeDir) : null;
    const homeRe = homeDir
        ? new RegExp(homeDir.split(/[\\/]+/).filter(Boolean).map(escapeRegExp).join('[\\\\/]+').replace(/^/, homeDir.startsWith('/') ? '/' : ''), 'gi')
        : null;

    const reduce = (m: string) => protect(reducePathWith(m, termsTest));

    const text = (input: unknown, maxLength: number = defaultMax): string => {
        if (input === null || input === undefined) return '';
        let s = typeof input === 'string' ? input : safeString(input);
        if (s.length > MAX_SCRUB_INPUT) s = s.slice(0, MAX_SCRUB_INPUT);
        s = normalizeText(s);

        // 1. Known home dir (it contains the OS username verbatim).
        if (homeRe) s = s.replace(homeRe, '~');
        // 2. Whole credentials.
        s = replaceUnprotected(s, RE_PEM, () => protect('<pem>'));
        s = replaceUnprotected(s, RE_JWT, () => protect('<jwt>'));
        s = replaceUnprotected(s, RE_AUTH_SCHEME, (_m, scheme) => `${scheme} ${protect('<redacted>')}`);
        // 3. URLs (before emails and paths: a URL can carry both).
        s = replaceUnprotected(s, RE_URL, (_m, scheme, rest) => protect(scrubUrlWith(scheme, rest, termsTest)));
        // 4. key=value secrets.
        s = replaceUnprotected(s, RE_SECRET_KV, (_m, q, key, sep) => `${q}${key}${q}${sep}${protect('<redacted>')}`);
        // 5. Emails.
        s = replaceUnprotected(s, RE_EMAIL, () => protect('<email>'));
        s = replaceUnprotected(s, RE_EMAIL_ENCODED, () => protect('<email>'));
        // 5b. WHOLE encoded tokens first. Every substring rule below (paths, SIDs,
        //     UUIDs, hex…) can split a random key and leave the rest of the
        //     secret in the report: a base64url key like `wN43…-PA_JY6CdJjMxy…`
        //     had only its `PA_…` run rewritten (the SID rule's `\b` also matches
        //     after `-`), and a base64 key starting with `/` and holding `//` had
        //     only its head reduced to `<path>`. So a long base64-alphabet token
        //     that reads as a blob — or any blob-looking token that contains an
        //     SID-shaped run — is judged as a whole, here, and goes to <b64>.
        //     Real code paths and identifiers are word-like and stay as they were;
        //     API routes (`/v1/calls/<uuid>/join`) are left to the route rule.
        s = replaceUnprotected(s, RE_B64, m => ((m.length >= BLOB_FIRST_MIN || RE_LIVEKIT_SID_INSIDE.test(m)) && !RE_LIVEKIT_SID_WHOLE.test(m) && !RE_API_ROUTE.test(m) && looksLikeEncodedBlob(m) ? protect('<b64>') : m));
        // 6. Home directories → ~ (unprotected, so the path rule sees `~\…`),
        //    then every remaining absolute path.
        s = replaceUnprotected(s, RE_WIN_HOME, () => '~');
        s = replaceUnprotected(s, RE_WIN_HOME_BARE, () => '~');
        s = replaceUnprotected(s, RE_POSIX_HOME_SPACED, () => '~');
        s = replaceUnprotected(s, RE_POSIX_HOME, () => '~');
        s = replaceUnprotected(s, RE_ROOT_HOME, () => '~');
        s = replaceUnprotected(s, RE_WIN_PATH, reduce);
        s = replaceUnprotected(s, RE_POSIX_ROOTED, reduce);
        s = replaceUnprotected(s, RE_POSIX_PATH, m => (RE_API_ROUTE.test(m) ? protect(m.split('/').map(seg => scrubSegment(seg, termsTest)).join('/')) : reduce(m)));
        // 7. Caller-supplied names.
        if (termsRe) s = replaceUnprotected(s, termsRe, () => protect('<name>'));
        // 8. Identifiers and addresses.
        s = replaceUnprotected(s, RE_LIVEKIT_SID, () => protect('<sid>'));
        s = replaceUnprotected(s, RE_UUID, () => protect('<id>'));
        s = replaceUnprotected(s, RE_IPV6_FULL, () => protect('<ip>'));
        s = replaceUnprotected(s, RE_IPV6_COMPRESSED, m => (/^::?\d?$/.test(m) ? m : protect('<ip>')));
        s = replaceUnprotected(s, RE_IPV4, () => protect('<ip>'));
        s = replaceUnprotected(s, RE_DOMAIN, m => (DOMAIN_ALLOW.test(m.replace(/:\d+$/, '')) ? m : protect('<domain>')));
        s = replaceUnprotected(s, RE_PHONE, () => protect('<phone>'));
        s = replaceUnprotected(s, RE_MENTION, () => protect('@<user>'));
        // 9. Encoded blobs.
        s = replaceUnprotected(s, RE_HEX, () => protect('<hex>'));
        s = replaceUnprotected(s, RE_B64, m => (looksLikeEncodedBlob(m) ? protect('<b64>') : m));

        s = s.replace(RE_SENTINELS, '');
        if (s.length > maxLength) s = s.slice(0, Math.max(0, maxLength - 1)) + '…';
        return s;
    };

    const stack = (input: unknown, maxFrames = 40): string => {
        const raw = text(input, 16_000);
        const lines = raw.split(/\r?\n/);
        const kept = lines.slice(0, maxFrames + 1).map(l => (l.length > 400 ? l.slice(0, 399) + '…' : l));
        if (lines.length > maxFrames + 1) kept.push(`… ${lines.length - maxFrames - 1} more frames`);
        return kept.join('\n');
    };

    return { text, stack };
}

function safeString(v: unknown): string {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try { return JSON.stringify(v) ?? ''; } catch { return '[unserializable]'; }
}

// ── structured walk ─────────────────────────────────────────────────────────

/** Keys a report object may carry. Anything else is dropped, not scrubbed. */
export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/i;

export interface DeepScrubLimits {
    maxDepth: number;
    maxArrayLength: number;
    maxKeys: number;
    maxStringLength: number;
}

export const DEFAULT_DEEP_LIMITS: DeepScrubLimits = {
    maxDepth: 8,
    maxArrayLength: 600,
    maxKeys: 80,
    maxStringLength: 4000,
};

/**
 * Walk a JSON-ish value and scrub every string in it. Drops: functions,
 * symbols, non-finite numbers, keys that are not plain identifiers, anything
 * past the depth/size limits. Returns a fresh plain-JSON value.
 *
 * `verbatimKeys` lists keys whose string values were produced by our own code
 * and must match a strict pattern (a commit hash, a version) — they are kept
 * as-is ONLY if they match, else replaced with '<invalid>'. Free text never
 * goes in a verbatim key.
 */
export function scrubDeep(
    value: unknown,
    scrubber: Scrubber,
    limits: DeepScrubLimits = DEFAULT_DEEP_LIMITS,
    verbatimKeys: Readonly<Record<string, RegExp>> = {},
): unknown {
    const walk = (v: unknown, depth: number, key: string | null): unknown => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'string') {
            if (key !== null && Object.prototype.hasOwnProperty.call(verbatimKeys, key)) {
                return verbatimKeys[key].test(v) ? v : '<invalid>';
            }
            return scrubber.text(v, limits.maxStringLength);
        }
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'boolean') return v;
        if (typeof v !== 'object') return null;
        if (depth >= limits.maxDepth) return null;
        if (Array.isArray(v)) {
            return v.slice(0, limits.maxArrayLength).map(x => walk(x, depth + 1, null));
        }
        const out: Record<string, unknown> = {};
        let n = 0;
        for (const k of Object.keys(v as Record<string, unknown>)) {
            if (n >= limits.maxKeys) break;
            if (!KEY_RE.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            out[k] = walk((v as Record<string, unknown>)[k], depth + 1, k);
            n++;
        }
        return out;
    };
    return walk(value, 0, null);
}
