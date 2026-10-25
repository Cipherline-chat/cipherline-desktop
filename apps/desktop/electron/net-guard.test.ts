import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dns from 'dns';
import { assertPublicHttpUrl, isPrivateIp, pinnedLookup } from './net-guard';

// The pre-hardening IPv6 check, kept verbatim as a negative control: it matched
// textual prefixes and only the DOTTED IPv4-mapped form.
function legacyIpv6IsPrivate(ip: string): boolean {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.test(lower);
}

describe('isPrivateIp — table', () => {
    const privateCases: Array<[string, string]> = [
        ['127.0.0.1', 'v4 loopback'],
        ['10.1.2.3', 'v4 10/8'],
        ['172.16.0.1', 'v4 172.16/12 low'],
        ['172.31.255.255', 'v4 172.16/12 high'],
        ['192.168.1.1', 'v4 192.168/16'],
        ['169.254.169.254', 'v4 cloud metadata'],
        ['100.64.0.1', 'v4 CGNAT'],
        ['0.0.0.0', 'v4 this-network'],
        ['198.18.0.1', 'v4 benchmarking'],
        ['192.0.0.1', 'v4 IETF assignments'],
        ['224.0.0.1', 'v4 multicast'],
        ['255.255.255.255', 'v4 broadcast'],
        ['::', 'v6 unspecified'],
        ['::1', 'v6 loopback'],
        ['0:0:0:0:0:0:0:1', 'v6 loopback, long form'],
        ['fe80::1', 'v6 link-local'],
        ['febf::1', 'v6 link-local, top of fe80::/10'],
        ['fec0::1', 'v6 site-local (deprecated)'],
        ['fc00::1', 'v6 ULA fc'],
        ['fd12:3456::1', 'v6 ULA fd'],
        ['ff02::1', 'v6 multicast'],
        ['::ffff:127.0.0.1', 'v4-mapped dotted'],
        ['::ffff:7f00:1', 'v4-mapped hex (WHATWG serialisation)'],
        ['::ffff:a9fe:a9fe', 'v4-mapped metadata hex'],
        ['0:0:0:0:0:ffff:c0a8:101', 'v4-mapped long form'],
        ['::7f00:1', 'v4-compatible loopback'],
        ['::127.0.0.1', 'v4-compatible dotted'],
        ['::ffff:0:7f00:1', 'v4-translated (SIIT)'],
        ['64:ff9b::7f00:1', 'NAT64 → loopback'],
        ['64:ff9b::10.0.0.1', 'NAT64 dotted → 10/8'],
        ['64:ff9b:1::1', 'local-use NAT64'],
        ['2002:7f00:1::', '6to4 → loopback'],
        ['2002:c0a8:101::1', '6to4 → 192.168.1.1'],
        ['2001:0:4136:e378::1', 'Teredo'],
        ['2001:db8::1', 'documentation'],
        ['100::1', 'discard-only'],
        ['fe80::1%eth0', 'zone id'],
        ['not-an-ip', 'garbage → fail closed'],
        ['', 'empty → fail closed'],
    ];
    it.each(privateCases)('%s (%s) is private', (ip) => {
        expect(isPrivateIp(ip)).toBe(true);
    });

    const publicCases: Array<[string, string]> = [
        ['8.8.8.8', 'v4 public'],
        ['1.1.1.1', 'v4 public'],
        ['172.32.0.1', 'just outside 172.16/12'],
        ['172.15.255.255', 'just below 172.16/12'],
        ['100.128.0.1', 'just outside CGNAT'],
        ['169.255.0.1', 'just outside link-local'],
        ['223.255.255.255', 'just below multicast'],
        ['2606:4700:4700::1111', 'v6 public'],
        ['2a00:1450:4001::200e', 'v6 public'],
        ['::ffff:8.8.8.8', 'v4-mapped public dotted'],
        ['::ffff:808:808', 'v4-mapped public hex'],
        ['64:ff9b::808:808', 'NAT64 → public'],
        ['2002:808:808::1', '6to4 → public'],
        ['fe00::1', 'just below fe80::/10'],
    ];
    it.each(publicCases)('%s (%s) is public', (ip) => {
        expect(isPrivateIp(ip)).toBe(false);
    });

    it('negative control: the legacy string check accepted the bypass forms', () => {
        for (const ip of ['::ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', 'febf::1']) {
            expect(legacyIpv6IsPrivate(ip)).toBe(false);
            expect(isPrivateIp(ip)).toBe(true);
        }
    });
});

describe('assertPublicHttpUrl — URL literals go through the WHATWG parser first', () => {
    const blocked = [
        'http://[::ffff:127.0.0.1]/x',     // serialised to [::ffff:7f00:1]
        'http://[0:0:0:0:0:ffff:7f00:1]/x',
        'http://[::127.0.0.1]/x',
        'http://[64:ff9b::a9fe:a9fe]/latest/meta-data',
        'http://[2002:a9fe:a9fe::]/x',
        'http://[fec0::1]/x',
        'http://0x7f.1/x',                 // WHATWG → 127.0.0.1
        'http://2130706433/x',             // WHATWG → 127.0.0.1
        'http://0177.0.0.1/x',             // WHATWG → 127.0.0.1
        'http://127.1/x',
        'http://localhost/x',
        'http://LOCALHOST./x',
        'http://foo.localhost/x',
        'http://printer.local/x',
        'file:///etc/passwd',
    ];
    it.each(blocked)('rejects %s', async (u) => {
        await expect(assertPublicHttpUrl(u)).rejects.toThrow();
    });

    it('accepts a public IPv4 literal (positive control)', async () => {
        await expect(assertPublicHttpUrl('https://8.8.8.8/a.png')).resolves.toMatchObject({ ip: '8.8.8.8', family: 4 });
    });
    it('accepts a public IPv6 literal (positive control)', async () => {
        await expect(assertPublicHttpUrl('https://[2606:4700:4700::1111]/a.png')).resolves.toMatchObject({ family: 6 });
    });
});

describe('assertPublicHttpUrl — DNS answers go through the same classifier', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const mockLookup = (answers: Array<{ address: string; family: number }>) =>
        vi.spyOn(dns.promises, 'lookup').mockResolvedValue(answers as any);

    it('rejects a host whose AAAA is an IPv4-mapped loopback in hex form', async () => {
        mockLookup([{ address: '::ffff:7f00:1', family: 6 }]);
        await expect(assertPublicHttpUrl('https://evil.example/x')).rejects.toThrow(/private/);
    });
    it('rejects when ANY answer is private (mixed public + NAT64-to-private)', async () => {
        mockLookup([{ address: '93.184.216.34', family: 4 }, { address: '64:ff9b::a00:1', family: 6 }]);
        await expect(assertPublicHttpUrl('https://evil.example/x')).rejects.toThrow(/private/);
    });
    it('accepts and pins a public answer, preferring IPv4 (positive control)', async () => {
        mockLookup([{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }]);
        const t = await assertPublicHttpUrl('https://example.com/x');
        expect(t).toEqual({ ip: '93.184.216.34', family: 4, hostname: 'example.com' });
        // pinnedLookup always hands back the validated address (DNS-rebind pin).
        const cb = vi.fn();
        pinnedLookup(t)('example.com', {}, cb);
        expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    });
});
