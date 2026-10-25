/**
 * Beta diagnostics reporter: gating, batching, dedupe, caps, retry, profile,
 * call summaries + rating, and the detail / message rules of the contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    BetaReporter, classifyBetaSend, DEDUPE_WINDOW_MS, FLUSH_AT, HOURLY_CAP, MAX_BATCH,
    type BetaRoute, type BetaSendResult,
} from './reporter';
import {
    sanitizeDetail, normalizeFrames, fingerprintSource, enumish, looksLikeIdentifier, sendFailureDetail, newUuid,
    MAX_DETAIL_KEYS,
} from './sanitize';
import type { BetaEventsBody } from './types';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');

function setup(result: () => BetaSendResult = () => ({ ok: true })) {
    let t = T0;
    const sent: Array<{ route: BetaRoute; body: Record<string, unknown> }> = [];
    const r = new BetaReporter({ appVersion: '1.0.23', platform: 'win32', clock: () => t });
    r.configure({ transport: async (route, body) => { sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return result(); } });
    return {
        r, sent,
        advance: (ms: number) => { t += ms; },
        on: () => { r.setServerEnabled(true); r.setLocalEnabled(true); r.setSignedIn(true); },
        events: () => sent.filter(s => s.route === 'events').flatMap(s => (s.body as unknown as BetaEventsBody).events),
    };
}

let current: BetaReporter | null = null;
afterEach(() => { current?.dispose(); current = null; vi.useRealTimers(); });

describe('sanitize', () => {
    it('detail: ≤ 12 keys, key pattern, value pattern; drops instead of coercing', () => {
        const big: Record<string, unknown> = {};
        for (let i = 0; i < 20; i++) big[`k${i}`] = i;
        expect(Object.keys(sanitizeDetail(big)!)).toHaveLength(MAX_DETAIL_KEYS);
        expect(sanitizeDetail({
            ok: 'enum_value-1.2:x', Bad: 1, 'has space': 1, toolong_key_toolong_key_toolong_key: 1,
            obj: { a: 1 }, nan: NaN, inf: Infinity, txt: 'hello world', long: 'x'.repeat(65), b: false, n: 1.23456,
        })).toEqual({ ok: 'enum_value-1.2:x', b: false, n: 1.23 });
    });
    it('detail strings shaped like ids are dropped even though they match the pattern', () => {
        expect(sanitizeDetail({ a: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', b: 'deadbeefdeadbeefdeadbeef', c: 'PA_abcdef123', d: 'fine' })).toEqual({ d: 'fine' });
        expect(looksLikeIdentifier('NotAllowedError')).toBe(false);
    });
    it('enumish squashes to the detail alphabet', () => {
        expect(enumish('huddle-spawn')).toBe('huddle-spawn');
        expect(enumish('a b/c')).toBe('a_b_c');
        expect(enumish('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeUndefined();
        expect(enumish({})).toBeUndefined();
    });
    it('frames keep fn@basename:line only — no directories, no columns', () => {
        const stack = [
            'TypeError: x is undefined',
            '    at renderRow (file:///C:/Users/Jane%20Doe/AppData/Local/Programs/cipherline/resources/app.asar/dist/assets/index-AbC12.js:12:3456)',
            '    at /home/jane/dev/app/src/thing.ts:40:2',
            '    at async Promise.all (index 0)',
            '    at Object.go (app://./assets/chunk-9.js:7:1)',
        ].join('\n');
        const f = normalizeFrames(stack);
        expect(f).toEqual(['renderRow@index-AbC12.js:12', 'anon@thing.ts:40', 'Object.go@chunk-9.js:7']);
        expect(f.join()).not.toMatch(/Jane|jane|Users|home/);
    });
    it('fingerprint source: enums split buckets, numbers do not', () => {
        const a = fingerprintSource('key_decrypt_failed', { detail: { scope: 'dm', code: 'BAD_MAC', status: 1 } });
        const b = fingerprintSource('key_decrypt_failed', { detail: { scope: 'dm', code: 'BAD_MAC', status: 2 } });
        const c = fingerprintSource('key_decrypt_failed', { detail: { scope: 'dm', code: 'NO_SESSION' } });
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });
    it('sendFailureDetail classifies by stage, status and code only', () => {
        expect(sendFailureDetail({ response: { status: 409 } }, 'channel')).toEqual({ scope: 'channel', stage: 'post', status: 409 });
        expect(sendFailureDetail(new Error('[E2EE:NO_BUNDLE] nobody'), 'dm')).toMatchObject({ scope: 'dm', stage: 'prepare', code: 'NO_BUNDLE', name: 'Error' });
        expect(sendFailureDetail(new Error('timeout of 20000ms exceeded'), 'dm')).toMatchObject({ stage: 'timeout' });
        expect(sendFailureDetail(new Error('No channel key for x'), 'channel')).toMatchObject({ stage: 'no_channel_key' });
    });
    it('newUuid is a v4 uuid', () => {
        expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('classifyBetaSend', () => {
    it('2xx (the routes answer 204) ok; 4xx dropped; 408/429/5xx/network retried', () => {
        expect(classifyBetaSend(204)).toEqual({ ok: true });
        expect(classifyBetaSend(400)).toEqual({ ok: false, retry: false });
        expect(classifyBetaSend(413)).toEqual({ ok: false, retry: false });
        for (const s of [408, 429, 500, 503, undefined]) expect(classifyBetaSend(s)).toEqual({ ok: false, retry: true });
    });
});

describe('BetaReporter — gating', () => {
    it('nothing is queued unless server AND local toggle AND signed in', async () => {
        const s = setup(); current = s.r;
        for (const gate of [
            () => { s.r.setServerEnabled(false); s.r.setLocalEnabled(true); s.r.setSignedIn(true); },
            () => { s.r.setServerEnabled(true); s.r.setLocalEnabled(false); s.r.setSignedIn(true); },
            () => { s.r.setServerEnabled(true); s.r.setLocalEnabled(true); s.r.setSignedIn(false); },
        ]) {
            gate();
            s.r.report('app_freeze', { detail: { ms: 1500 } });
            expect(s.r.peekQueue()).toHaveLength(0);
            expect(s.r.sendCallSummary({} as never)).toBeNull();
            await s.r.flush();
        }
        expect(s.sent).toHaveLength(0);
    });
    it('turning any gate off drops what is queued on the spot', async () => {
        const s = setup(); current = s.r;
        s.on();
        s.r.report('app_freeze', { detail: { ms: 1500 } });
        expect(s.r.peekQueue()).toHaveLength(1);
        s.r.setLocalEnabled(false);
        expect(s.r.peekQueue()).toHaveLength(0);
        s.r.setLocalEnabled(true);
        await s.r.flush();
        expect(s.sent).toHaveLength(0);
    });
    it('notifies subscribers on state changes and exposes `active`', () => {
        const s = setup(); current = s.r;
        const seen: boolean[] = [];
        s.r.subscribe(() => seen.push(s.r.getState().active));
        s.on();
        expect(s.r.isActive()).toBe(true);
        expect(seen[seen.length - 1]).toBe(true);
    });
    it('unknown kinds are not sent and report() never throws', () => {
        const s = setup(); current = s.r;
        s.on();
        s.r.report('not_a_kind' as never);
        s.r.report('app_freeze', { detail: { get bad() { throw new Error('boom'); } } as never });
        expect(s.r.peekQueue().length).toBeLessThanOrEqual(1);
    });
});

describe('BetaReporter — batching, dedupe, caps', () => {
    it('flushes at FLUSH_AT queued events, in batches of ≤ MAX_BATCH, with the contract envelope', async () => {
        const s = setup(); current = s.r;
        s.on();
        for (let i = 0; i < FLUSH_AT - 1; i++) s.r.report('app_freeze', { detail: { ms: 1000, phase: `p${i}` } });
        await Promise.resolve();
        expect(s.sent).toHaveLength(0);
        s.r.report('app_freeze', { detail: { ms: 1000, phase: 'last' } });
        await s.r.flush();
        expect(s.sent).toHaveLength(1);
        const body = s.sent[0].body as unknown as BetaEventsBody;
        expect(body.schema).toBe(1);
        expect(body.session_id).toBe(s.r.sessionId);
        expect(body).toMatchObject({ app_version: '1.0.23', platform: 'win32' });
        expect(body.events).toHaveLength(FLUSH_AT);
        expect(body.events[0].at).toBe('2026-10-16T12:00:00.000Z');
        expect(body.events[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
        // ≤ MAX_BATCH per POST
        for (let i = 0; i < MAX_BATCH + 10; i++) s.r.report('memory_high', { detail: { mb: 2000, scope: `s${i}` } });
        await s.r.flush();
        const sizes = s.sent.map(x => (x.body as unknown as BetaEventsBody).events.length);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BATCH);
    });
    it('identical events within 10 min: first sent, repeats folded into ONE follow-up with detail.count', async () => {
        const s = setup(); current = s.r;
        s.on();
        s.r.report('key_decrypt_failed', { detail: { scope: 'dm', code: 'BAD_MAC' } });
        for (let i = 0; i < 7; i++) { s.advance(1000); s.r.report('key_decrypt_failed', { detail: { scope: 'dm', code: 'BAD_MAC' } }); }
        s.r.report('key_decrypt_failed', { detail: { scope: 'dm', code: 'NO_SESSION' } }); // different fingerprint
        await s.r.flush();
        expect(s.events()).toHaveLength(2);
        s.advance(DEDUPE_WINDOW_MS);
        await s.r.flush();
        const ev = s.events();
        expect(ev).toHaveLength(3);
        expect(ev[2]).toMatchObject({ kind: 'key_decrypt_failed', detail: { scope: 'dm', code: 'BAD_MAC', count: 7 } });
        expect(ev[2].fingerprint).toBe(ev[0].fingerprint);
    });
    it('a numeric detail.count is summed by the dedupe (call_e2ee_error)', async () => {
        const s = setup(); current = s.r;
        s.on();
        for (let i = 0; i < 4; i++) s.r.report('call_e2ee_error', { detail: { scope: 'media', reason: 'missing_key', count: 3 } });
        s.advance(DEDUPE_WINDOW_MS);
        await s.r.flush();
        expect(s.events().map(e => e.detail?.count)).toEqual([3, 9]);
    });
    it('at most HOURLY_CAP events per hour', async () => {
        const s = setup(); current = s.r;
        s.on();
        for (let i = 0; i < HOURLY_CAP + 50; i++) s.r.report('app_freeze', { detail: { ms: 1000, phase: `x${i}` } });
        await s.r.flush();
        expect(s.events()).toHaveLength(HOURLY_CAP);
        s.advance(60 * 60_000 + 1);
        s.r.report('app_freeze', { detail: { ms: 1000, phase: 'next-hour' } });
        await s.r.flush();
        expect(s.events()).toHaveLength(HOURLY_CAP + 1);
    });
    it('a retryable failure keeps the batch; a refused shape (4xx) drops it', async () => {
        let result: BetaSendResult = { ok: false, retry: true };
        const s = setup(() => result); current = s.r;
        s.on();
        s.r.report('ws_churn', { detail: { reconnects_10m: 6 } });
        await s.r.flush();
        expect(s.r.peekQueue()).toHaveLength(1);
        result = { ok: false, retry: false };
        await s.r.flush();
        expect(s.r.peekQueue()).toHaveLength(0);
        expect(s.sent).toHaveLength(2);
    });
    it('the periodic flush runs every 60 s while active', async () => {
        vi.useFakeTimers();
        const s = setup(); current = s.r;
        s.on();
        s.r.report('startup_slow', { detail: { ms: 12000 } });
        const spy = vi.spyOn(s.r, 'flush');
        await vi.advanceTimersByTimeAsync(59_000);
        expect(spy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(spy).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
        await spy.mock.results[0].value; // the timer's own run (WebCrypto hashing is not a fake timer)
        expect(s.events()).toHaveLength(1);
    });
});

describe('BetaReporter — message, profile, call summary', () => {
    it('only unhandled_error carries a (scrubbed, ≤ 300) message; others get name/frame in detail only', async () => {
        const s = setup(); current = s.r;
        s.on();
        const e = new TypeError('Cannot read alice@example.com at C:\\Users\\Alice\\secret plan.docx id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ' + 'z'.repeat(400));
        e.stack = 'TypeError: x\n    at boom (app://./assets/index-Q1.js:3:9)';
        s.r.report('unhandled_error', { detail: { source: 'error' }, error: e });
        s.r.report('msg_send_failed', { detail: { stage: 'post' }, error: e });
        await s.r.flush();
        const [u, m] = s.events();
        expect(u.message!.length).toBeLessThanOrEqual(300);
        expect(u.message).not.toMatch(/alice|Alice|secret plan|3f2504e0/);
        expect(u.detail).toMatchObject({ source: 'error', name: 'TypeError', frame: 'index-Q1.js:3', fn: 'boom' });
        expect(m.message).toBeUndefined();
    });
    it('profile: sent once per session, again only if it changed', async () => {
        const s = setup(); current = s.r;
        s.on();
        const p = { build_commit: 'abc', os_version: '10.0.22631', cpu_cores: 8 } as never;
        s.r.sendProfile(p);
        await s.r.flush();
        s.r.sendProfile(p);
        await s.r.flush();
        s.r.sendProfile({ ...(p as object), cpu_cores: 16 } as never);
        await s.r.flush();
        const profiles = s.sent.filter(x => x.route === 'profile');
        expect(profiles).toHaveLength(2);
        expect(profiles[0].body).toMatchObject({ schema: 1, session_id: s.r.sessionId, app_version: '1.0.23', platform: 'win32' });
    });
    it('call summary then rating: same call_summary_id, rating + tags on the second POST', async () => {
        const s = setup(); current = s.r;
        s.on();
        const id = s.r.sendCallSummary({ call_type: 'dm', end_reason: 'user' } as never)!;
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        await s.r.flush();
        expect(s.r.rateCall(id, 2, ['echo', 'echo', 'lag'])).toBe(true);
        await s.r.flush();
        const posts = s.sent.filter(x => x.route === 'call-summary');
        expect(posts).toHaveLength(2);
        expect(posts[0].body.call_summary_id).toBe(id);
        // Rating-only body: no metric fields (server never overwrites metrics).
        expect(posts[1].body).toEqual({
            schema: 1, call_summary_id: id, session_id: s.r.sessionId, app_version: '1.0.23', platform: 'win32',
            rating: 2, rating_tags: ['echo', 'lag'],
        });
        expect(s.r.rateCall('nope', 3)).toBe(false);
        // A rating given while the summary is still unsent rides inside it (one POST).
        s.r.configure({ transport: async (route, body) => { s.sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { ok: false, retry: true }; } });
        const id2 = s.r.sendCallSummary({ call_type: 'channel', end_reason: 'remote' } as never)!;
        await s.r.flush();
        s.r.rateCall(id2, 5);
        await s.r.flush(); // still failing: nothing delivered yet
        s.r.configure({ transport: async (route, body) => { s.sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { ok: true }; } });
        const before = s.sent.length;
        await s.r.flush();
        expect(s.sent.slice(before)).toHaveLength(1);
        expect(s.sent[s.sent.length - 1].body).toMatchObject({ call_summary_id: id2, call_type: 'channel', rating: 5 });
        expect(s.r.rateCall(id, 9 as never)).toBe(false);
    });
});

beforeEach(() => { /* each test builds its own reporter */ });
