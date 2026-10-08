/**
 * Reporter plumbing: recent-error capture, the sensitive-terms collector, the
 * auto-send policy, send-error classification and IPC narrowing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { captureError, getRecentErrors, setCaptureScrubber, __resetRecentErrorsForTests } from './recentErrors';
import {
    registerSensitiveTermsSource, collectSensitiveTerms, harvestNames, filterTermsAgainstStructured, __resetSensitiveTermsForTests,
} from './sensitiveTerms';
import { planAutoSend, appendAutoSendLog, parseAutoSendLog, signatureHash, AUTO_SEND_DAILY_CAP } from './autoSend';
import { classifySendError, shortReference } from './sendPolicy';
import { parsePendingCrashesReply, parseSystemInfoReply, newestCrash } from './ipc';
import { createScrubber } from './scrub';
import { DIAGNOSTIC_LIMITS } from './reportTypes';

const H = 60 * 60 * 1000;

describe('recentErrors', () => {
    beforeEach(() => __resetRecentErrorsForTests());

    it('scrubs at capture with the installed scrubber', () => {
        setCaptureScrubber(createScrubber({ sensitiveTerms: ['Mira Okafor'], homeDir: '/home/dawson kraai' }));
        const e = new Error('Mira Okafor sent /home/dawson kraai/Documents/plan final.docx to x@y.com');
        e.stack = 'Error: boom\n    at f (/home/dawson kraai/app/main.js:1:2)';
        captureError('error', e, 1000);
        const [r] = getRecentErrors();
        expect(JSON.stringify(r)).not.toMatch(/Mira|dawson|plan final|x@y\.com/);
        expect(r).toMatchObject({ at: 1000, kind: 'error', name: 'Error' });
    });

    it(`keeps the newest ${DIAGNOSTIC_LIMITS.maxRecentErrors}, dedupes bursts, ignores browser noise`, () => {
        for (let i = 0; i < 30; i++) captureError('error', new Error(`e${i}`), i * 10_000);
        captureError('error', new Error('e29'), 290_500); // identical, within 2 s → dropped
        captureError('error', 'ResizeObserver loop completed with undelivered notifications.', 300_000);
        const all = getRecentErrors();
        expect(all).toHaveLength(DIAGNOSTIC_LIMITS.maxRecentErrors);
        expect(all[0].message).toBe('e10');
        expect(all.at(-1)!.message).toBe('e29');
        captureError('unhandledrejection', { weird: 'object' }, 400_000);
        expect(getRecentErrors().at(-1)!.kind).toBe('unhandledrejection');
    });
});

describe('sensitive terms', () => {
    beforeEach(() => __resetSensitiveTermsForTests());

    it('harvests names by key from any shape, never message content', () => {
        const state = {
            friends: { accepted: [{ user_id: 'u1', username: 'nightowl42', display_name: 'Mira Okafor' }] },
            conversations: [{ conversation_id: 'c1', name: 'Saturday Squad', last_message: { content: 'meet at 9 at the docks' }, participants: [{ username: 'zed_99' }] }],
            servers: new Map([['s1', { name: 'Pixel Pirates', description: 'a long description here' }]]),
            channels: [{ name: 'secret-raid-planning', topic: 'x' }],
        };
        const out = harvestNames(state);
        expect([...out].sort()).toEqual(['Mira Okafor', 'Pixel Pirates', 'Saturday Squad', 'nightowl42', 'secret-raid-planning', 'zed_99'].sort());
    });

    it('collects from registered sources + extras, email local part included, short terms dropped', () => {
        const off = registerSensitiveTermsSource('dash', () => [{ username: 'ab' }, { name: 'Pixel Pirates' }]);
        const terms = collectSensitiveTerms({ extra: ['dawson.kraai@gmail.com', null, 'dawsonk'] });
        expect(terms).toEqual(expect.arrayContaining(['dawson.kraai@gmail.com', 'dawson.kraai', 'dawsonk', 'Pixel Pirates']));
        expect(terms).not.toContain('ab');
        off();
        expect(collectSensitiveTerms()).toEqual([]);
    });

    it('a throwing source does not block a report', () => {
        registerSensitiveTermsSource('bad', () => { throw new Error('x'); });
        registerSensitiveTermsSource('good', () => ({ username: 'zed_99' }));
        expect(collectSensitiveTerms()).toEqual(['zed_99']);
    });

    it('drops only terms that collide with structured report values', () => {
        const kept = filterTermsAgainstStructured(['video', 'Intel', 'Dawson', 'enabled', 'Core'], ['video', 'Intel(R) Core(TM) i7', 'disabled_software']);
        expect(kept).toEqual(['Dawson', 'enabled']);
    });
});

describe('auto-send policy', () => {
    const pending = (sigs: string[]) => sigs.map(signature => ({ signature }));
    const NOW = 1_000 * H;

    it('does nothing when off or signed out', () => {
        expect(planAutoSend({ enabled: false, signedIn: true, pending: pending(['a']), log: [], now: NOW }).send).toEqual([]);
        expect(planAutoSend({ enabled: true, signedIn: false, pending: pending(['a']), log: [], now: NOW }).send).toEqual([]);
    });

    it(`sends newest first, at most ${AUTO_SEND_DAILY_CAP} per rolling day`, () => {
        const plan = planAutoSend({ enabled: true, signedIn: true, pending: pending(['a', 'b', 'c', 'd', 'e']), log: [], now: NOW });
        expect(plan.send.map(p => p.signature)).toEqual(['e', 'd', 'c']);
        expect(plan.deferred.map(p => p.signature)).toEqual(['b', 'a']);
        const log = [{ h: signatureHash('x'), at: NOW - 2 * H }, { h: signatureHash('y'), at: NOW - 23 * H }];
        expect(planAutoSend({ enabled: true, signedIn: true, pending: pending(['a', 'b']), log, now: NOW }).send.map(p => p.signature)).toEqual(['b']);
        const old = [{ h: signatureHash('x'), at: NOW - 25 * H }, { h: signatureHash('y'), at: NOW - 30 * H }, { h: signatureHash('z'), at: NOW - 48 * H }];
        expect(planAutoSend({ enabled: true, signedIn: true, pending: pending(['a', 'b']), log: old, now: NOW }).send).toHaveLength(2);
    });

    it('dedupes by crash signature (and within one batch)', () => {
        const log = appendAutoSendLog([], 'sig-1', NOW - H);
        const plan = planAutoSend({ enabled: true, signedIn: true, pending: pending(['sig-1', 'sig-2', 'sig-2']), log, now: NOW });
        expect(plan.send.map(p => p.signature)).toEqual(['sig-2']);
        expect(plan.duplicates.map(p => p.signature)).toEqual(['sig-2', 'sig-1']);
        // after 7 days the same crash may be reported again
        expect(planAutoSend({ enabled: true, signedIn: true, pending: pending(['sig-1']), log, now: NOW + 8 * 24 * H }).send).toHaveLength(1);
    });

    it('the log stores hashes, not signatures, and survives garbage', () => {
        const log = appendAutoSendLog([], 'renderer_gone|renderer|oom|||', NOW);
        expect(JSON.stringify(log)).not.toContain('renderer');
        expect(parseAutoSendLog(JSON.stringify(log))).toEqual(log);
        expect(parseAutoSendLog('nope')).toEqual([]);
        expect(parseAutoSendLog(JSON.stringify([{ h: 'zz', at: 1 }, { h: 'deadbeef', at: 'x' }]))).toEqual([]);
    });
});

describe('send', () => {
    it('classifies failures', () => {
        expect(classifySendError({ response: { status: 413 } }, true).reason).toBe('too_large');
        expect(classifySendError({ response: { status: 429 } }, true)).toEqual({
            reason: 'rate_limited', message: 'You’ve sent several reports recently — try again later, or save it to a file.',
        });
        expect(classifySendError({ response: { status: 401 } }, true).reason).toBe('unauthorized');
        expect(classifySendError({ response: { status: 400 } }, true).reason).toBe('rejected');
        expect(classifySendError({ response: { status: 503 } }, true).reason).toBe('server');
        expect(classifySendError({ code: 'ERR_NETWORK' }, true).reason).toBe('offline');
        expect(classifySendError(new Error('x'), false).reason).toBe('offline');
    });
    it('short reference', () => {
        expect(shortReference('3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b')).toBe('3F9A-12BC');
        expect(shortReference(42)).toBeNull();
        expect(shortReference('abc')).toBeNull();
    });
});

describe('IPC narrowing', () => {
    it('system info: unknown shapes fall back, scrub inputs kept separate', () => {
        const r = parseSystemInfoReply({ system: { app_version: '1.0.17', platform: 'evil', cpu_cores: '12', gpu: { devices: [{ vendor_id: '0x10de', device_id: '0x1e02', active: true, extra: 'x' }] } }, scrub: { homeDir: 'C:\\Users\\D', osUsername: 'd' } }, '0.0.0', 'abc1234');
        expect(r.system.build_commit).toBe('abc1234');
        expect(r.system.cpu_cores).toBe(0);
        expect(r.system.gpu.devices[0]).toEqual({ vendor_id: '0x10de', device_id: '0x1e02', active: true });
        expect(r.scrub).toEqual({ homeDir: 'C:\\Users\\D', osUsername: 'd' });
        expect(JSON.stringify(r.system)).not.toContain('Users');
        expect(parseSystemInfoReply(null, '1.0.0', 'unknown').system.app_version).toBe('1.0.0');
    });
    it('pending crashes: malformed entries dropped, newest is last', () => {
        const list = parsePendingCrashesReply([
            { signature: 'a', count: 1, seen: false, crash: { kind: 'renderer_gone', occurred_at: '2026-10-07T18:00:00.000Z', reason: 'oom' } },
            { signature: 'b', crash: { kind: 'nope', occurred_at: 'x' } },
            'junk',
            { signature: 'c', count: 2, seen: true, crash: { kind: 'unclean_exit', occurred_at: '2026-10-07T19:00:00.000Z' } },
        ]);
        expect(list.map(p => p.signature)).toEqual(['a', 'c']);
        expect(newestCrash(list)!.crash.kind).toBe('unclean_exit');
        expect(parsePendingCrashesReply('x')).toEqual([]);
    });
});
