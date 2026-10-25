import { describe, it, expect } from 'vitest';
import { createSmokeReporter, reportableUrl, type SmokeReport } from './smoke-report';

function make(startAt = 1000) {
    let t = startAt;
    const writes: SmokeReport[] = [];
    const r = createSmokeReporter({
        write: (json) => { writes.push(JSON.parse(json)); },
        now: () => t,
    });
    return { r, writes, advance: (ms: number) => { t += ms; } };
}

describe('smoke report (what scripts/smoke-test.mjs reads instead of attaching a debugger)', () => {
    it('painted with no console errors is ok', () => {
        const { r, writes, advance } = make();
        advance(4200);
        r.painted('http://127.0.0.1:42918/', 321);
        expect(writes).toEqual([{ ok: true, status: 'painted', url: 'http://127.0.0.1:42918/', bodyChars: 321, elapsedMs: 4200, consoleErrors: [] }]);
    });

    it('any console error recorded before the verdict fails the run (same gate as before)', () => {
        const { r, writes } = make();
        r.consoleError('Uncaught TypeError: x is not a function');
        r.consoleError('Refused to load the script because it violates CSP');
        r.painted('http://127.0.0.1:42918/', 10);
        expect(writes[0].ok).toBe(false);
        expect(writes[0].status).toBe('painted');
        expect(writes[0].consoleErrors).toHaveLength(2);
    });

    it('writes exactly once: the first verdict wins', () => {
        const { r, writes } = make();
        r.crashed('renderer gone: crashed');
        r.painted('http://127.0.0.1:42918/', 10);
        r.loadFailed('late');
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ ok: false, status: 'crashed', detail: 'renderer gone: crashed' });
        expect(r.finished).toBe(true);
    });

    it('a failed main-frame load is a failure with its detail', () => {
        const { r, writes } = make();
        r.loadFailed('ERR_CONNECTION_REFUSED (-102) http://127.0.0.1:42918/');
        expect(writes[0]).toMatchObject({ ok: false, status: 'load-failed' });
    });

    it('caps the number and size of recorded errors (a log-spamming renderer cannot bloat the report)', () => {
        const { r, writes } = make();
        for (let i = 0; i < 500; i++) r.consoleError('e'.repeat(10_000));
        r.painted('http://x/', 1);
        expect(writes[0].consoleErrors).toHaveLength(50);
        expect(writes[0].consoleErrors[0]).toHaveLength(2000);
    });

    it('reports origin + path only (no query or fragment)', () => {
        expect(reportableUrl('http://127.0.0.1:42918/app?token=secret#frag')).toBe('http://127.0.0.1:42918/app');
        expect(reportableUrl('not a url')).toBe('');
    });
});
