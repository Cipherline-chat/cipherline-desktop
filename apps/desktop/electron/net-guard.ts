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

function ipv4IsPrivate(ip: string): boolean {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true; // fail closed
    const [a, b] = p;
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 10) return true;                          // 10.0.0.0/8 private
    if (a === 127) return true;                         // loopback
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                          // multicast / reserved
    return false;
}

function ipv6IsPrivate(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;                 // loopback / unspecified
    if (lower.startsWith('fe80')) return true;                         // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);       // IPv4-mapped
    if (mapped) return ipv4IsPrivate(mapped[1]);
    return false;
}

function isPrivateIp(ip: string): boolean {
    const kind = netModule.isIP(ip);
    if (kind === 4) return ipv4IsPrivate(ip);
    if (kind === 6) return ipv6IsPrivate(ip);
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
    if (hostname === 'localhost' || /\.local$/i.test(hostname)) {
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
        callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
    ): void => {
        if (options && typeof options === 'object' && options.all) {
            callback(null, [{ address: target.ip, family: target.family }]);
        } else {
            callback(null, target.ip, target.family);
        }
    };
}
