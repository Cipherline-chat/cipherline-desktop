/**
 * `payload.previous_session`: what the session that DIED was doing, carried on
 * an unclean-exit crash report (electron/previous-session.ts writes it; this
 * is the renderer half: parse the IPC record, put it in the report, scrub it,
 * fit it, and survive an API that refuses the new key).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDiagnosticReport, fitPayload, PREVIOUS_SESSION_MAX_ROWS, type BundleInput } from './bundle';
import { fallbackSystemInfo, parsePendingCrashesReply, parsePreviousSession } from './ipc';
import { DIAGNOSTIC_LIMITS, type CrashInfo, type PreviousSession } from './reportTypes';
import type { DiagnosticReportBody } from './reportTypes';

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const UNCLEAN: CrashInfo = { kind: 'unclean_exit', process_type: 'browser', reason: 'unclean-exit', occurred_at: '2026-11-14T15:00:00.000Z', app_version_at_crash: '0.1.0' };

const prev = (over: Partial<PreviousSession> = {}): PreviousSession => ({
    started_at: '2026-11-14T15:00:00.000Z', last_written_at: '2026-11-14T15:41:12.345Z', app_version: '0.1.0',
    state: { in_call: true, sharing: false, window_visible: true, window_focused: false },
    rows: [
        { t_s: -30, source: 'main', ms: 900, activity: 'ipc:securekv:open' },
        { t_s: -2, source: 'event', ms: 0, activity: 'resume:rehydrate' },
    ],
    ...over,
});

const input = (over: Partial<BundleInput> = {}): BundleInput => ({
    category: 'crash', trigger: 'auto_crash', now: NOW,
    system: fallbackSystemInfo('0.1.0'), settings: {}, crash: UNCLEAN, previousSession: prev(),
    scrub: { sensitiveTerms: ['nightowl42', 'Pixel Pirates'], homeDir: 'C:\\Users\\Dawson Kraai' },
    ...over,
});

describe('suppressed_unclean in the report', () => {
    it('is carried on crash-category reports, known classes only, counts clamped', () => {
        const p = buildDiagnosticReport(input({ suppressedUnclean: { installer_replaced: 2, os_restart: 1, bogus: 5, external_kill_suspected: 5000 } })).body.payload;
        expect(p.suppressed_unclean).toEqual({ installer_replaced: 2, os_restart: 1, external_kill_suspected: 999 });
    });
    it('is absent when nothing was suppressed or the values are junk', () => {
        for (const v of [null, undefined, {}, { os_restart: 0 }, { os_restart: -1 }, { os_restart: 1.5 }, { os_restart: '2' }, [1, 2]] as unknown[]) {
            expect(buildDiagnosticReport(input({ suppressedUnclean: v as never })).body.payload.suppressed_unclean).toBeUndefined();
        }
    });
    it('is not on non-crash categories', () => {
        const p = buildDiagnosticReport(input({ category: 'other', trigger: 'manual', crash: null, previousSession: null, suppressedUnclean: { os_restart: 3 } })).body.payload;
        expect(p.suppressed_unclean).toBeUndefined();
    });
});

describe('previous_session in the report', () => {
    it('an unclean_exit crash report carries it, timestamps intact through the scrubber', () => {
        const p = buildDiagnosticReport(input()).body.payload;
        expect(p.previous_session).toBeDefined();
        expect(p.previous_session!.started_at).toBe('2026-11-14T15:00:00.000Z');
        expect(p.previous_session!.last_written_at).toBe('2026-11-14T15:41:12.345Z');
        expect(p.previous_session!.app_version).toBe('0.1.0');
        expect(p.previous_session!.state).toEqual({ in_call: true, sharing: false, window_visible: true, window_focused: false });
        expect(p.previous_session!.rows.map(r => r.activity)).toEqual(['ipc:securekv:open', 'resume:rehydrate']);
        // the new session's perf_log is still its own, separate section
        expect(p.perf_log).toBeDefined();
    });

    it('hung-exit (also kind unclean_exit) carries it', () => {
        const p = buildDiagnosticReport(input({ crash: { ...UNCLEAN, reason: 'hung-exit' } })).body.payload;
        expect(p.previous_session).toBeDefined();
    });

    it('never on another kind of crash, another category, or without a crash', () => {
        const other: CrashInfo = { kind: 'main_exception', error_name: 'Error', occurred_at: UNCLEAN.occurred_at };
        expect(buildDiagnosticReport(input({ crash: other })).body.payload).not.toHaveProperty('previous_session');
        expect(buildDiagnosticReport(input({ crash: null })).body.payload).not.toHaveProperty('previous_session');
        for (const category of ['screen_share', 'performance', 'other'] as const) {
            expect(buildDiagnosticReport(input({ category, crash: UNCLEAN })).body.payload).not.toHaveProperty('previous_session');
        }
    });

    it('absent when there is nothing to say (clean quit / no file → no previousSession)', () => {
        expect(buildDiagnosticReport(input({ previousSession: null })).body.payload).not.toHaveProperty('previous_session');
        expect(buildDiagnosticReport(input({ previousSession: undefined })).body.payload).not.toHaveProperty('previous_session');
        expect(buildDiagnosticReport(input({ previousSession: prev({ rows: [], state: {} }) })).body.payload).not.toHaveProperty('previous_session');
    });

    it('the renderer scrubber runs over it: emails, tokens, home paths and ids do not survive (sensitive TERMS that are also whole words in a structured string are exempt, exactly as in perf_log)', () => {
        const dirty = prev({
            rows: [
                { t_s: -9, source: 'main', ms: 1, activity: 'mail dawson.kraai@gmail.com' },
                { t_s: -8, source: 'main', ms: 1, activity: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
                { t_s: -7, source: 'main', ms: 1, activity: 'C:/Users/Dawson Kraai/x.js' },
                { t_s: -6, source: 'main', ms: 1, activity: 'id 3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b' },
            ],
        });
        const text = JSON.stringify(buildDiagnosticReport(input({ previousSession: dirty })).body.payload.previous_session).toLowerCase();
        for (const leak of ['dawson', 'gmail', 'eyjhbgci', '3f9a12bc']) expect(text, leak).not.toContain(leak);
    });

    it('caps the rows', () => {
        const many = prev({ rows: Array.from({ length: 300 }, (_, i) => ({ t_s: -300 + i, source: 'main' as const, ms: 1, activity: `ipc:r${i}` })) });
        const rows = buildDiagnosticReport(input({ previousSession: many })).body.payload.previous_session!.rows;
        expect(rows).toHaveLength(PREVIOUS_SESSION_MAX_ROWS);
        expect(rows[rows.length - 1].activity).toBe('ipc:r299');
    });

    it('fitPayload trims it before the new session\'s own evidence and finally drops it, never the report', () => {
        const p = buildDiagnosticReport(input()).body.payload;
        p.previous_session!.rows = Array.from({ length: 60 }, (_, i) => ({ t_s: -i, source: 'main' as const, ms: 1, activity: `ipc:${'x'.repeat(200)}${i}` }));
        const trimmed = fitPayload(p, 4000);
        expect(trimmed).toContain('previous_session');
        expect(JSON.stringify(p).length).toBeLessThanOrEqual(4000);
        expect(p.system).toBeDefined();
        expect(p.crash).toBeDefined();
        // the real limit holds with a full-size record too
        const big = buildDiagnosticReport(input()).body;
        expect(JSON.stringify(big.payload).length).toBeLessThan(DIAGNOSTIC_LIMITS.maxPayloadBytes);
    });
});

describe('IPC parsing of the pending record', () => {
    const entry = (over: Record<string, unknown> = {}) => ({ signature: 's', count: 1, seen: false, crash: UNCLEAN, previous_session: prev(), ...over });

    it('passes a well-formed record through', () => {
        expect(parsePendingCrashesReply([entry()])[0].previous_session).toEqual(prev());
    });
    it('only for unclean_exit', () => {
        const other = { kind: 'renderer_gone', occurred_at: UNCLEAN.occurred_at };
        expect(parsePendingCrashesReply([entry({ crash: other })])[0].previous_session).toBeUndefined();
    });
    it('drops a malformed record whole, and malformed rows individually', () => {
        expect(parsePreviousSession({ ...prev(), started_at: 'nope' })).toBeUndefined();
        expect(parsePreviousSession('x')).toBeUndefined();
        const ps = parsePreviousSession({
            ...prev(),
            rows: [
                { t_s: -1, source: 'main', ms: 5, activity: 'ok' },
                { t_s: 1, source: 'main', ms: 5, activity: 'future' },
                { t_s: -1, source: 'x', ms: 5, activity: 'bad source' },
                { t_s: -1, source: 'main', ms: 5, activity: 'https://evil.example/?t=1' },
                null,
            ],
            state: { in_call: true, name: 'alice', sharing: 'yes' },
        })!;
        expect(ps.rows.map(r => r.activity)).toEqual(['ok']);
        expect(ps.state).toEqual({ in_call: true });
    });
    it('an old main that sends no previous_session is fine', () => {
        const e = entry(); delete (e as { previous_session?: unknown }).previous_session;
        expect(parsePendingCrashesReply([e])[0].previous_session).toBeUndefined();
    });
});

describe('sending: an API that refuses the new key does not lose the report', () => {
    const posts: Array<Record<string, unknown>> = [];
    let respond: (n: number) => { status: number } | 'ok';

    beforeEach(() => { posts.length = 0; vi.resetModules(); });

    async function send(body: DiagnosticReportBody) {
        vi.doMock('axios', () => ({
            default: {
                post: async (_u: string, data: string) => {
                    posts.push(JSON.parse(data) as Record<string, unknown>);
                    const r = respond(posts.length);
                    if (r === 'ok') return { data: { id: '12345678-aaaa-bbbb-cccc-1234567890ab' } };
                    throw Object.assign(new Error('rejected'), { response: { status: r.status } });
                },
            },
        }));
        vi.doMock('../../constants', () => ({ API_BASE: 'http://x/v1' }));
        const mod = await import('./send');
        return mod.sendDiagnosticReport(body, 'tok');
    }

    const body = () => buildDiagnosticReport(input()).body;

    it('a current API simply accepts it (one POST, key included)', async () => {
        respond = () => 'ok';
        const r = await send(body());
        expect(r.ok).toBe(true);
        expect(posts).toHaveLength(1);
        expect((posts[0].payload as Record<string, unknown>).previous_session).toBeDefined();
    });

    it('400 / 413 → retried once WITHOUT previous_session, report delivered', async () => {
        for (const status of [400, 413]) {
            posts.length = 0;
            respond = (n) => (n === 1 ? { status } : 'ok');
            const r = await send(body());
            expect(r.ok).toBe(true);
            expect(posts).toHaveLength(2);
            expect((posts[1].payload as Record<string, unknown>)).not.toHaveProperty('previous_session');
            expect((posts[1].payload as Record<string, unknown>).crash).toBeDefined();
            vi.resetModules();
        }
    });

    it('a failure that is not about the body (429, 500) is not retried', async () => {
        for (const status of [429, 500]) {
            posts.length = 0;
            respond = () => ({ status });
            const r = await send(body());
            expect(r.ok).toBe(false);
            expect(posts).toHaveLength(1);
            vi.resetModules();
        }
    });

    it('a report with no previous_session is not retried either', async () => {
        respond = () => ({ status: 400 });
        const r = await send(buildDiagnosticReport(input({ previousSession: null })).body);
        expect(r.ok).toBe(false);
        expect(posts).toHaveLength(1);
    });
});
