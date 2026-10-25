import * as dns from 'dns';
import * as netModule from 'net';

// ============================================================================
// SSRF guard for renderer-supplied URLs that the MAIN process will fetch/PUT.
//
// The renderer is sandboxed and its CSP `connect-src` is strict — but main-
// process fetch handlers (net:fetch-binary, net:stream-upload) bypass that CSP
// entirely. Without a guard, a compromised/XSS'd renderer (or a malicious image
// URL in a message) could make the main process reach cloud metadata
// (169.254.169.254), LAN devices, or loopback services and exfiltrate the
// response. This module rejects non-http(s) URLs and any host that resolves to
// a private / loopback / link-local / unique-local address.
//
// The host is resolved and EVERY resolved address is validated (not just a
// literal IP), then the first address is returned so callers may pin it and
// avoid a DNS-rebind between check and connect.
// ============================================================================

// Every address — URL literal or DNS answer — is reduced to raw bytes before it
// is classified. String matching on the textual form is not enough: the WHATWG
// URL parser re-serialises IPv6 literals (e.g. an IPv4-mapped address comes back
// in hex, not dotted, form), and several IPv6 ranges carry an embedded IPv4
// address that must be classified as IPv4. Anything that does not parse
// cleanly is treated as private (fail closed).

/** Strict dotted-quad → 4 bytes, or null. */
function parseIpv4(ip: string): number[] | null {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
    const p = ip.split('.').map(Number);
    if (p.some(n => n > 255)) return null;
    return p;
}

/** IPv6 text (optionally with an embedded dotted quad and/or %zone) → 16 bytes, or null. */
function parseIpv6(input: string): number[] | null {
    let ip = input;
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    if (!ip || /[^0-9a-fA-F:.]/.test(ip)) return null;

    // Trailing embedded IPv4 (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4).
    let tail: number[] = [];
    if (ip.includes('.')) {
        const lastColon = ip.lastIndexOf(':');
        if (lastColon === -1) return null;
        const v4 = parseIpv4(ip.slice(lastColon + 1));
        if (!v4) return null;
        tail = v4;
        ip = ip.slice(0, lastColon + 1) + '0:0'; // placeholder groups, overwritten below
    }

    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const toGroups = (part: string): number[] | null => {
        if (part === '') return [];
        const out: number[] = [];
        for (const g of part.split(':')) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
            out.push(parseInt(g, 16));
        }
        return out;
    };
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    if (!head || !rest) return null;
    let groups: number[];
    if (halves.length === 2) {
        const fill = 8 - head.length - rest.length;
        if (fill < 1) return null;
        groups = [...head, ...new Array(fill).fill(0), ...rest];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;

    const bytes: number[] = [];
    for (const g of groups) bytes.push(g >> 8, g & 0xff);
    if (tail.length) bytes.splice(12, 4, ...tail);
    return bytes;
}

function ipv4BytesArePrivate(b: number[]): boolean {
    const [a, c] = b;
    if (a === 0) return true;                               // 0.0.0.0/8 "this network"
    if (a === 10) return true;                              // 10.0.0.0/8 private
    if (a === 127) return true;                             // loopback
    if (a === 169 && c === 254) return true;                // link-local + cloud metadata
    if (a === 172 && c >= 16 && c <= 31) return true;       // 172.16.0.0/12 private
    if (a === 192 && c === 168) return true;                // 192.168.0.0/16 private
    if (a === 100 && c >= 64 && c <= 127) return true;      // CGNAT 100.64.0.0/10
    if (a === 192 && c === 0 && b[2] === 0) return true;    // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && c === 0 && b[2] === 2) return true;    // 192.0.2.0/24 TEST-NET-1
    if (a === 198 && (c === 18 || c === 19)) return true;   // 198.18.0.0/15 benchmarking
    if (a === 198 && c === 51 && b[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && c === 0 && b[2] === 113) return true;  // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true;                              // multicast / reserved / broadcast
    return false;
}

function startsWith(bytes: number[], prefix: number[]): boolean {
    return prefix.every((v, i) => bytes[i] === v);
}

function ipv6BytesArePrivate(b: number[]): boolean {
    const v4At = (i: number) => ipv4BytesArePrivate(b.slice(i, i + 4));
    const zeros = (n: number) => new Array(n).fill(0);

    // ::/96 — unspecified, loopback (::1) and deprecated IPv4-compatible ::a.b.c.d.
    // ::1 classifies as 0.0.0.1 and :: as 0.0.0.0, both in 0.0.0.0/8 → private.
    if (startsWith(b, zeros(12))) return v4At(12);
    // ::ffff:0:0/96 IPv4-mapped — the kernel connects these to the IPv4 address.
    if (startsWith(b, [...zeros(10), 0xff, 0xff])) return v4At(12);
    // ::ffff:0:0:0/96 IPv4-translated (SIIT).
    if (startsWith(b, [...zeros(8), 0xff, 0xff, 0, 0])) return v4At(12);
    // 64:ff9b::/96 NAT64 well-known prefix — reaches the embedded IPv4 via a gateway.
    if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, ...zeros(8)])) return v4At(12);
    // 64:ff9b:1::/48 local-use NAT64 (RFC 8215) — network-specific, never public.
    if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true;
    // 2002::/16 6to4 — embeds an IPv4 address in bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
    // 2001::/32 Teredo — embeds an (obfuscated) IPv4 client; refuse outright.
    if (startsWith(b, [0x20, 0x01, 0x00, 0x00])) return true;
    // 2001:db8::/32 documentation.
    if (startsWith(b, [0x20, 0x01, 0x0d, 0xb8])) return true;
    // 100::/64 discard-only.
    if (startsWith(b, [0x01, 0x00, ...zeros(6)])) return true;
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
    if ((b[0] & 0xfe) === 0xfc) return true;                  // fc00::/7 unique-local
    if (b[0] === 0xff) return true;                           // ff00::/8 multicast
    return false;
}

/**
 * True when `ip` must not be fetched by the main process. Exported for tests.
 * Accepts any textual IPv4/IPv6 form; anything unparseable is private.
 */
export function isPrivateIp(ip: string): boolean {
    const kind = netModule.isIP(ip);
    if (kind === 4) {
        const b = parseIpv4(ip);
        return b ? ipv4BytesArePrivate(b) : true;
    }
    if (kind === 6) {
        const b = parseIpv6(ip);
        return b ? ipv6BytesArePrivate(b) : true;
    }
    return true; // unrecognised → fail closed
}

export interface ResolvedTarget { ip: string; family: number; hostname: string; }

/**
 * Throws if `rawUrl` is not a public http(s) URL. Resolves the host and rejects
 * any private/loopback/link-local target. Returns the pinned public IP.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<ResolvedTarget> {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed');
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    const bare = hostname.replace(/\.$/, '').toLowerCase(); // `localhost.` is still localhost
    if (bare === 'localhost' || /\.(local|localhost)$/.test(bare)) {
        throw new Error('Refusing to fetch a local/loopback host');
    }

    // Literal IP — validate directly.
    const literalKind = netModule.isIP(hostname);
    if (literalKind) {
        if (isPrivateIp(hostname)) throw new Error('Refusing to fetch a private/loopback address');
        return { ip: hostname, family: literalKind, hostname };
    }

    // Hostname — resolve and validate EVERY address.
    const results = await dns.promises.lookup(hostname, { all: true });
    if (!results.length) throw new Error('Host did not resolve');
    for (const r of results) {
        if (isPrivateIp(r.address)) throw new Error('Host resolves to a private/loopback address');
    }
    // Prefer IPv4 among the validated candidates. dns.lookup's ordering follows
    // the OS resolver (getaddrinfo), which on some networks — commonly Windows
    // machines with IPv6 nominally configured but not actually routing — lists
    // an IPv6 address FIRST even though only the IPv4 path is reachable.
    // pinnedLookup() below always returns this SAME chosen address for every
    // connection attempt (that's the whole point — it closes the DNS-rebind
    // window), so picking a dead-end address here means the request hangs
    // until TCP eventually gives up, which can take much longer than this
    // handler's own 15s application-level timeout. Real-world symptom this
    // fixed: a remote-image fetch that "just sits there" on the loading
    // skeleton forever on some networks while working instantly on others.
    const ipv4 = results.find(r => r.family === 4);
    const chosen = ipv4 ?? results[0];
    return { ip: chosen.address, family: chosen.family, hostname };
}

/**
 * Build a `lookup` function (for http/https.request) that ALWAYS returns the
 * already-validated public IP and never re-resolves. This closes the DNS-rebind
 * window between `assertPublicHttpUrl` (the check) and the socket connect: without
 * it, a 0-TTL attacker domain can resolve to a public IP during the check and to
 * 127.0.0.1 / 169.254.169.254 / a LAN host at connect. TLS SNI + cert validation
 * still use the original hostname from the URL, so pinning the IP is safe.
 */
export function pinnedLookup(target: ResolvedTarget) {
    return (
        _hostname: string,
        options: { all?: boolean } | number | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
        callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
    ): void => {
        if (options && typeof options === 'object' && options.all) {
            callback(null, [{ address: target.ip, family: target.family }]);
        } else {
            callback(null, target.ip, target.family);
        }
    };
}

/** No legitimate image link is anywhere near this long; a longer one is a
 *  data-in-the-URL beacon, not an image. */
export const MAX_REMOTE_IMAGE_URL_LENGTH = 2048;

/**
 * Shape check for `net:fetch-binary` (remote image previews / legacy https
 * avatars), applied to the first URL AND every redirect hop: https only (a
 * plain-http fetch shows the image and the user's IP to every network hop and
 * lets any of them substitute the bytes), no embedded credentials, bounded
 * length. Returns the parsed href to request. SSRF / private-address rules
 * are separate (assertPublicHttpUrl).
 */
export function assertRemoteImageUrlShape(rawUrl: unknown): string {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_REMOTE_IMAGE_URL_LENGTH) {
        throw new Error('Invalid image URL');
    }
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid image URL'); }
    if (parsed.protocol !== 'https:') throw new Error('Only https images are fetched');
    if (parsed.username || parsed.password) throw new Error('Invalid image URL');
    if (parsed.href.length > MAX_REMOTE_IMAGE_URL_LENGTH) throw new Error('Invalid image URL');
    return parsed.href;
}
