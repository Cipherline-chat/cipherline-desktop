/**
 * Network timing for the diagnostics report. The point of the tests is the
 * REDACTION: whatever a request was about (server, channel, user, invite code,
 * query string, token) must be unrecoverable from the snapshot.
 */
import { describe, it, expect } from 'vitest';
import { createNetTiming, endpointPattern, MAX_PATTERNS, SLOWEST_N, MAX_WS_ROWS } from './netTiming';
import { buildDiagnosticReport, type BundleInput } from './diagnostics/bundle';
import { buildSettingsSnapshot } from './diagnostics/settingsSnapshot';
import type { SystemInfo } from './diagnostics/reportTypes';

const API = 'api-staging.cipherline.chat';
const UUID = '3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b';
const UUID2 = 'a1b2c3d4-0000-4000-8000-0123456789ab';
const base = `https://${API}/v1`;

describe('endpointPattern: ids and everything user-chosen become :id', () => {
    it('replaces uuids, numbers, hashes and mixed tokens', () => {
        expect(endpointPattern(`${base}/servers/${UUID}/channels`, API)).toBe('servers/:id/channels');
        expect(endpointPattern(`${base}/servers/${UUID}/members/${UUID2}/devices`, API)).toBe('servers/:id/members/:id/devices');
        expect(endpointPattern(`${base}/channels/12345/messages`, API)).toBe('channels/:id/messages');
        expect(endpointPattern(`${base}/attachments/AbC123xyz_-9QwErTy/download`, API)).toBe('attachments/:id/download');
        expect(endpointPattern(`${base}/keys/${'a'.repeat(64)}`, API)).toBe('keys/:id');
    });

    it('drops query string, fragment and trailing noise', () => {
        expect(endpointPattern(`${base}/keys/identity_keys?user_id=${UUID}&token=sekrit#frag`, API)).toBe('keys/identity_keys');
        expect(endpointPattern(`${base}/servers/${UUID}/unread?include_system=1`, API)).toBe('servers/:id/unread');
    });

    it('treats the segment after a caller-chosen-slug route as :id, even if it looks like a word', () => {
        expect(endpointPattern(`${base}/invites/pixelpirates`, API)).toBe('invites/:id');
        expect(endpointPattern(`${base}/users/by-username/alice`, API)).toBe('users/by-username/:id');
        expect(endpointPattern(`${base}/search/secretraid/results`, API)).toBe('search/:id/results');
    });

    it('collapses names with digits, dots, uppercase or non-ASCII', () => {
        expect(endpointPattern(`${base}/auth/users/nightowl42`, API)).toBe('auth/users/:id');
        expect(endpointPattern(`${base}/auth/users/Mira.Okafor`, API)).toBe('auth/users/:id');
        expect(endpointPattern(`${base}/auth/users/Dawson`, API)).toBe('auth/users/:id');
        expect(endpointPattern(`${base}/auth/users/%E3%83%A6`, API)).toBe('auth/users/:id');
    });

    it('never records another host', () => {
        expect(endpointPattern(`https://evil.example.com/v1/servers/${UUID}`, API)).toBe('(external)');
        expect(endpointPattern(`https://minio.cipherline.chat/bucket/${UUID}?X-Amz-Signature=abc`, API)).toBe('(external)');
        expect(endpointPattern(`https://${API}.evil.com/v1/x`, API)).toBe('(external)');
    });

    it('bounds depth', () => {
        const p = endpointPattern(`${base}/a/b/c/d/e/f/g/h/i/j`, API);
        expect(p.split('/').length).toBeLessThanOrEqual(8);
        expect(p.endsWith('…')).toBe(true);
    });

    it('is total on junk input', () => {
        for (const junk of ['', '/', '???', 'http://', '%%%', '\u0000', 'x'.repeat(5000)]) {
            expect(() => endpointPattern(junk, API)).not.toThrow();
        }
    });
});

describe('recorder', () => {
    function rec() {
        let t = 0;
        const r = createNetTiming({ apiHost: API, now: () => t });
        return { r, at: (ms: number) => { t = ms; } };
    }

    it('aggregates count / p50 / p95 / max per pattern, ids merged', () => {
        const { r, at } = rec();
        for (let i = 1; i <= 100; i++) {
            at(i * 1000);
            const done = r.begin('GET', `${base}/servers/${i % 2 ? UUID : UUID2}/channels`);
            at(i * 1000 + i);   // i ms
            done(200);
        }
        const s = r.snapshot();
        expect(s.endpoints).toHaveLength(1);
        expect(s.endpoints[0]).toMatchObject({ ep: 'GET servers/:id/channels', n: 100, err: 0, p50: 50, p95: 95, max: 100 });
        expect(s.requests_total).toBe(100);
    });

    it('counts errors and reports the status class, never a body', () => {
        const { r, at } = rec();
        at(0); const a = r.begin('POST', `${base}/channels/${UUID}/read`); at(5); a(429);
        at(10); const b = r.begin('GET', `${base}/friends`); at(15); b(null);
        const s = r.snapshot();
        expect(s.errors_total).toBe(2);
        expect(s.slowest.map(x => x.status).sort()).toEqual(['429', 'err']);
    });

    it('tracks the highest number of requests in flight', () => {
        const { r } = rec();
        const dones = Array.from({ length: 9 }, (_, i) => r.begin('GET', `${base}/servers/${i}/unread`));
        dones.forEach(d => d(200));
        r.begin('GET', `${base}/friends`)(200);
        expect(r.snapshot().max_in_flight).toBe(9);
    });

    it('keeps the slowest N, worst first, and a settle callback is idempotent', () => {
        const { r, at } = rec();
        for (let i = 1; i <= 40; i++) {
            at(i * 100); const d = r.begin('GET', `${base}/friends`); at(i * 100 + i * 7); d(200); d(200);
        }
        const s = r.snapshot();
        expect(s.requests_total).toBe(40);
        expect(s.slowest).toHaveLength(SLOWEST_N);
        expect(s.slowest[0].ms).toBe(280);
        expect(s.slowest.map(x => x.ms)).toEqual([...s.slowest.map(x => x.ms)].sort((a, b) => b - a));
    });

    it('caps the number of patterns (overflow goes to one bucket) and the socket rows', () => {
        const { r } = rec();
        for (let i = 0; i < MAX_PATTERNS + 50; i++) r.begin('GET', `${base}/route${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26]}x`)(200);
        // Distinct "words" -> distinct patterns, but never more than the cap (+ the overflow bucket).
        expect(r.snapshot().endpoints.length).toBeLessThanOrEqual(MAX_PATTERNS + 1);
        for (let i = 0; i < 50; i++) r.wsOpened(100 + i);
        const s = r.snapshot();
        expect(s.ws.length).toBeLessThanOrEqual(MAX_WS_ROWS);
        expect(s.ws[0].kind).toBe('connect');
        expect(s.ws[s.ws.length - 1].kind).toBe('reconnect');
        expect(s.ws_connects).toBe(50);
    });

    it('records click-to-messages times by kind', () => {
        const { r } = rec();
        r.open('server_open', 900); r.open('server_open', 300); r.open('channel_open_first', 450); r.open('channel_open_revisit', 40);
        const o = Object.fromEntries(r.snapshot().opens.map(x => [x.kind, x]));
        expect(o.server_open).toMatchObject({ n: 2, max: 900 });
        expect(o.channel_open_revisit.p50).toBe(40);
    });

    it('snapshot is small after a long session', () => {
        const { r, at } = rec();
        for (let i = 0; i < 20000; i++) { at(i); const d = r.begin('GET', `${base}/servers/${i}/c${i % 70}`); at(i + (i % 90)); d(200); }
        expect(JSON.stringify(r.snapshot()).length).toBeLessThan(12_000);
    });
});

// ── End to end: through the report builder, with planted identities ──────────
const SYSTEM = {
    app_version: '1.0.24', build_commit: '5490aeda', channel: 'staging', electron: '43.7.9', chrome: '140.0.0.0', node: '22.0.0',
    platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'i5', cpu_cores: 20, ram_gb: 32,
    gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 100,
} as unknown as SystemInfo;

function reportWith(snapshot: ReturnType<ReturnType<typeof createNetTiming>['snapshot']>, terms: string[] = []) {
    const input: BundleInput = {
        category: 'performance', trigger: 'manual', now: Date.UTC(2026, 10, 4, 12, 0, 0),
        system: SYSTEM,
        settings: buildSettingsSnapshot({ hardwareAcceleration: true }),
        netTiming: snapshot,
        scrub: { sensitiveTerms: terms },
    };
    return buildDiagnosticReport(input);
}

describe('net_timing in the report', () => {
    it('carries patterns and numbers only; planted ids, names, query values and tokens never appear', () => {
        const r = createNetTiming({ apiHost: API, now: (() => { let t = 0; return () => (t += 3); })() });
        const planted = [UUID, 'pixelpirates', 'nightowl42', 'Mira.Okafor', 'sekrit-token-value', 'secret-raid-planning'];
        r.begin('GET', `${base}/servers/${UUID}/channels?token=sekrit-token-value`)(200);
        r.begin('GET', `${base}/invites/pixelpirates`)(404);
        r.begin('GET', `${base}/auth/users/nightowl42`)(200);
        r.begin('GET', `${base}/auth/users/Mira.Okafor`)(200);
        r.begin('GET', `https://minio.cipherline.chat/secret-raid-planning/${UUID}?X-Amz-Signature=sekrit-token-value`)(200);
        r.wsOpened(120); r.open('server_open', 500);
        const built = reportWith(r.snapshot());
        const text = JSON.stringify(built.body);
        for (const p of planted) expect(text, `leaked ${p}`).not.toContain(p);
        const nt = built.body.payload.net_timing!;
        expect(nt.endpoints.map(e => e.ep)).toEqual(expect.arrayContaining(['GET servers/:id/channels', 'GET invites/:id', 'GET auth/users/:id', 'GET (external)']));
        // The scrubber leaves a pattern-only section alone (it is its own fixed point).
        expect(nt.endpoints.find(e => e.ep === 'GET servers/:id/channels')).toBeTruthy();
        expect(nt.slowest.length).toBeGreaterThan(0);
        expect(nt.ws).toHaveLength(1);
    });

    it('NEGATIVE CONTROL: the leak predicate flags a naive redactor, so a pass above means something', () => {
        const url = `${base}/servers/${UUID}/channels?token=sekrit-token-value`;
        const leaks = (pattern: string) => /sekrit-token-value|[0-9a-f]{8}-[0-9a-f]{4}-/.test(pattern);
        const naive = (u: string) => u.replace(`https://${API}/v1/`, '');   // strips the host only
        expect(leaks(naive(url))).toBe(true);
        expect(leaks(endpointPattern(url, API))).toBe(false);
    });

    it('is omitted when nothing was recorded, and absent from a build that passes none', () => {
        const empty = createNetTiming({ apiHost: API }).snapshot();
        expect(reportWith(empty).body.payload.net_timing).toBeUndefined();
        const input: BundleInput = {
            category: 'other', trigger: 'manual', now: 1, system: SYSTEM,
            settings: buildSettingsSnapshot({ hardwareAcceleration: true }), scrub: { sensitiveTerms: [] },
        };
        expect(buildDiagnosticReport(input).body.payload.net_timing).toBeUndefined();
    });

    it('stays well inside the payload cap even for a busy session', () => {
        const r = createNetTiming({ apiHost: API });
        for (let i = 0; i < 5000; i++) r.begin('GET', `${base}/servers/${i}/r${'abcdefghij'[i % 10]}${'klmnopqrst'[i % 7]}`)(200);
        const built = reportWith(r.snapshot());
        expect(built.payloadBytes).toBeLessThan(40_000);
    });
});
