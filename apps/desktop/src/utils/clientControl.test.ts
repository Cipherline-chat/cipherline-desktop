import { describe, it, expect } from 'vitest';
import {
    compareVersions, isBelowFloor, parseClientStatus, toNotice, isSuspendedResponse,
    nextPollDelayMs, formatEta, DEFAULT_UPDATE_URL, pinUpdateUrl,
} from './clientControl';
import { isRefreshRejection } from './bootRefresh';

describe('compareVersions (semver precedence)', () => {
    it.each([
        ['1.0.22', '1.0.23', -1],
        ['1.0.23', '1.0.23', 0],
        ['1.0.10', '1.0.9', 1],          // numeric, not lexical
        ['2.0.0', '1.99.99', 1],
        ['1.0.23-staging.161', '1.0.23', -1], // a prerelease ranks below its release
        ['1.0.23-staging.161', '1.0.22', 1],
        ['1.0.23-staging.9', '1.0.23-staging.10', -1], // numeric ids
        ['1.0.23-alpha', '1.0.23-beta', -1],
        ['1.0.23-1', '1.0.23-alpha', -1],   // numeric < alphanumeric
        ['1.0.23-a', '1.0.23-a.1', -1],     // shorter first
        ['1.0.23+build.5', '1.0.23', 0],    // build metadata ignored
    ])('%s vs %s → %d', (a, b, want) => {
        expect(compareVersions(a, b)).toBe(want);
    });
    it('null for non-semver', () => {
        expect(compareVersions('1.0', '1.0.0')).toBeNull();
        expect(compareVersions('dev', '1.0.0')).toBeNull();
    });
});

describe('isBelowFloor — mirrors the server', () => {
    it('floor 0.0.0 / empty is off', () => {
        expect(isBelowFloor('0.0.1', '0.0.0')).toBe(false);
        expect(isBelowFloor('garbage', '')).toBe(false);
    });
    it('below / at / above', () => {
        expect(isBelowFloor('1.0.22', '1.0.23')).toBe(true);
        expect(isBelowFloor('1.0.23', '1.0.23')).toBe(false);
        expect(isBelowFloor('1.0.24', '1.0.23')).toBe(false);
        expect(isBelowFloor('1.0.23-staging.161', '1.0.23')).toBe(true);
    });
    it('an unparseable own version is below a real floor; a junk floor is ignored', () => {
        expect(isBelowFloor('0.0.0-dev', 'x')).toBe(false);
        expect(isBelowFloor('dev', '1.0.0')).toBe(true);
    });
});

describe('parseClientStatus', () => {
    const ok = {
        shutdown: { title: 'Paused', message: 'Fixing it', until: '2026-10-17T03:00:00Z', since: null },
        min_version_desktop: '1.0.23', min_version_mobile: '0.0.0',
        update_url: 'https://cipherline.chat/download', retry_after_s: 30,
    };
    it('parses the API shape', () => {
        expect(parseClientStatus(ok)).toEqual({
            shutdown: { title: 'Paused', message: 'Fixing it', until: '2026-10-17T03:00:00.000Z', since: null },
            minVersionDesktop: '1.0.23',
            updateUrl: 'https://cipherline.chat/download',
            retryAfterS: 30,
            betaDiagnostics: false,
        });
    });
    it('beta_diagnostics: only a literal true switches it on', () => {
        expect(parseClientStatus({ ...ok, beta_diagnostics: true })!.betaDiagnostics).toBe(true);
        expect(parseClientStatus({ ...ok, beta_diagnostics: 'true' })!.betaDiagnostics).toBe(false);
        expect(parseClientStatus({ ...ok, beta_diagnostics: 1 })!.betaDiagnostics).toBe(false);
        expect(parseClientStatus({ ...ok })!.betaDiagnostics).toBe(false);
    });
    it('no shutdown → null notice', () => {
        expect(parseClientStatus({ ...ok, shutdown: null })!.shutdown).toBeNull();
    });
    it('rejects non-status bodies (an older API answering 404 HTML, a proxy page)', () => {
        expect(parseClientStatus(null)).toBeNull();
        expect(parseClientStatus('<html>')).toBeNull();
        expect(parseClientStatus({ statusCode: 404 })).toBeNull();
    });
    it('update_url must be https, else the default', () => {
        expect(parseClientStatus({ ...ok, update_url: 'javascript:alert(1)' })!.updateUrl).toBe(DEFAULT_UPDATE_URL);
        expect(parseClientStatus({ ...ok, update_url: 'http://x.example' })!.updateUrl).toBe(DEFAULT_UPDATE_URL);
    });
    it('update_url is pinned to https://cipherline.chat/ (R-10)', () => {
        for (const bad of [
            'https://evil.example/download', 'https://cipherline.chat.evil.example/', 'https://evil.example/?https://cipherline.chat/',
            'https://www.cipherline.chat/download', 'https://cipherline.chat:8443/download', 'https://x@cipherline.chat/download',
            'http://cipherline.chat/download', 42, null,
        ]) {
            expect(parseClientStatus({ ...ok, update_url: bad })!.updateUrl, String(bad)).toBe(DEFAULT_UPDATE_URL);
            expect(pinUpdateUrl(bad)).toBe(DEFAULT_UPDATE_URL);
        }
        // Positive control: the default and other pages on our own site are kept.
        expect(parseClientStatus({ ...ok, update_url: 'https://cipherline.chat/download?ch=stable' })!.updateUrl)
            .toBe('https://cipherline.chat/download?ch=stable');
        expect(pinUpdateUrl('https://cipherline.chat/')).toBe('https://cipherline.chat/');
    });
    it('retry hint is clamped to 10..300 s', () => {
        expect(parseClientStatus({ ...ok, retry_after_s: 1 })!.retryAfterS).toBe(10);
        expect(parseClientStatus({ ...ok, retry_after_s: 99999 })!.retryAfterS).toBe(300);
    });
});

describe('toNotice / isSuspendedResponse', () => {
    it('always yields readable copy, capped', () => {
        const n = toNotice(undefined);
        expect(n.title.length).toBeGreaterThan(0);
        expect(n.message.length).toBeGreaterThan(0);
        expect(toNotice({ title: 'x'.repeat(500), message: 'm' }).title.length).toBe(80);
        expect(toNotice({ until: 'not a date' }).until).toBeNull();
    });
    it('only a 503 with code APP_SUSPENDED is the kill switch', () => {
        expect(isSuspendedResponse(503, { code: 'APP_SUSPENDED' })).toBe(true);
        expect(isSuspendedResponse(503, { message: 'Service Unavailable' })).toBe(false); // proxy / deploy
        expect(isSuspendedResponse(503, '<html>')).toBe(false);
        expect(isSuspendedResponse(500, { code: 'APP_SUSPENDED' })).toBe(false);
    });
});

describe('nextPollDelayMs — 30 s backing off to 2 min', () => {
    const mid = () => 0.5; // zero jitter
    it('starts at 30 s and grows ×1.5 to a 2 min cap', () => {
        expect(nextPollDelayMs(0, undefined, undefined, mid)).toBe(30_000);
        expect(nextPollDelayMs(1, undefined, undefined, mid)).toBe(45_000);
        expect(nextPollDelayMs(2, undefined, undefined, mid)).toBe(67_500);
        expect(nextPollDelayMs(3, undefined, undefined, mid)).toBe(101_250);
        expect(nextPollDelayMs(4, undefined, undefined, mid)).toBe(120_000);
        expect(nextPollDelayMs(50, undefined, undefined, mid)).toBe(120_000);
    });
    it('jitter stays within ±10% and never exceeds the cap', () => {
        expect(nextPollDelayMs(0, undefined, undefined, () => 0)).toBe(27_000);
        expect(nextPollDelayMs(0, undefined, undefined, () => 0.999)).toBeLessThanOrEqual(33_000);
        expect(nextPollDelayMs(9, undefined, undefined, () => 0.999)).toBe(120_000);
    });
});

describe('formatEta', () => {
    const now = Date.parse('2026-10-16T20:00:00Z');
    it.each([
        [null, null],
        ['2026-10-16T20:00:30Z', 'any moment now'],
        ['2026-10-16T19:00:00Z', 'any moment now'],
        ['2026-10-16T20:04:00Z', 'in 4 min'],
        ['2026-10-16T22:05:00Z', 'in 2 h 5 min'],
        ['2026-10-16T23:00:00Z', 'in 3 h'],
        ['2026-10-20T20:00:00Z', 'in 4 days'],
    ])('%s → %s', (until, want) => {
        expect(formatEta(until, now)).toBe(want);
    });
});

describe('isRefreshRejection — only a verdict on the token signs out', () => {
    it.each([[400, true], [401, true], [403, true], [429, false], [500, false], [502, false], [503, false], [undefined, false]])(
        '%s → %s', (status, want) => {
            expect(isRefreshRejection(status as number | undefined)).toBe(want);
        },
    );
});
