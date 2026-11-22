import { describe, it, expect } from 'vitest';
import {
    deriveEmojiName, uniqueEmojiName, buildRows, validateRows, overSlotIds, retryAfterMs, runBatch,
    serverCreateGapMs, type BulkRow, type RowStatus,
} from './batch';
import { EMOJI_NAME_RE } from '../emojiNames';

const file = (name: string, size = 1000, type = 'image/png') => {
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
};
const okFile = () => null;

describe('names', () => {
    it('derives a valid name from messy file names', () => {
        for (const n of ['Red Heart!!.PNG', 'a.png', '日本語.gif', '  .webp', 'x'.repeat(80) + '.png', 'my-cool.emoji.v2.jpg']) {
            expect(deriveEmojiName(n)).toMatch(EMOJI_NAME_RE);
        }
        expect(deriveEmojiName('Red Heart.PNG')).toBe('red_heart');
    });

    it('appends _2, _3 for collisions and keeps within 32 characters', () => {
        const taken = new Set(['cat', 'cat_2']);
        expect(uniqueEmojiName('cat', taken)).toBe('cat_3');
        expect(uniqueEmojiName('dog', taken)).toBe('dog');
        const long = 'a'.repeat(32);
        const out = uniqueEmojiName(long, new Set([long]));
        expect(out).toHaveLength(32);
        expect(out.endsWith('_2')).toBe(true);
        expect(out).toMatch(EMOJI_NAME_RE);
    });

    it('de-duplicates against the library and within the batch', () => {
        const rows = buildRows([file('cat.png'), file('Cat.gif'), file('cat.webp'), file('dog.png')], ['cat']);
        expect(rows.map(r => r.name)).toEqual(['cat_2', 'cat_3', 'cat_4', 'dog']);
        const more = buildRows([file('dog.png')], ['cat'], rows);
        expect(more[0].name).toBe('dog_2');
    });
});

describe('validateRows', () => {
    const base = { existingNames: [] as string[], slots: 10, fileProblem: okFile };
    const mk = (names: string[], status: RowStatus = 'ready'): BulkRow[] =>
        names.map((name, i) => ({ id: `r${i}`, file: file(`${name}.png`), name, status }));

    it('flags per-row file problems', () => {
        const rows = mk(['aa', 'bb']);
        const p = validateRows(rows, { ...base, fileProblem: f => (f === rows[1].file ? 'too big' : null) });
        expect([...p.entries()]).toEqual([['r1', 'too big']]);
    });

    it('flags invalid and duplicate names (existing and in batch)', () => {
        const rows = mk(['ok', 'x', 'bad name', 'taken', 'ok']);
        const p = validateRows(rows, { ...base, existingNames: ['taken'] });
        expect(p.has('r0')).toBe(false);
        expect(p.get('r1')).toMatch(/2 to 32/);
        expect(p.get('r2')).toMatch(/2 to 32/);
        expect(p.get('r3')).toMatch(/already taken/);
        expect(p.get('r4')).toMatch(/already taken/);
    });

    it('caps at the slots left, in order, and removing a row frees a slot', () => {
        const rows = mk(['aa', 'bb', 'cc', 'dd']);
        const p = validateRows(rows, { ...base, slots: 2 });
        expect([...p.keys()]).toEqual(['r2', 'r3']);
        expect(p.get('r2')).toMatch(/^No room/);
        expect(overSlotIds(rows, p)).toEqual(['r2', 'r3']);
        const after = validateRows(rows.filter(r => r.id !== 'r0'), { ...base, slots: 2 });
        expect([...after.keys()]).toEqual(['r3']);
    });

    it('does not spend slots on rows that are invalid for another reason', () => {
        const rows = mk(['aa', 'b', 'cc']);
        const p = validateRows(rows, { ...base, slots: 2 });
        expect([...p.keys()]).toEqual(['r1']);
    });

    it('zero slots says so, and done rows use up slots and names', () => {
        const rows = [...mk(['aa'], 'done'), ...mk(['aa', 'bb']).map((r, i) => ({ ...r, id: `n${i}` }))];
        const p = validateRows(rows, { ...base, slots: 2 });
        expect(p.get('n0')).toMatch(/already taken/);
        expect(p.has('n1')).toBe(false);
        expect(validateRows(mk(['aa']), { ...base, slots: 0 }).get('r0')).toMatch(/No room left/);
    });

    it('failed and cancelled rows are re-judged, uploading rows are not', () => {
        const rows = mk(['aa', 'b']);
        rows[0].status = 'uploading'; rows[1].status = 'error';
        expect(validateRows(rows, base).has('r0')).toBe(false);
        expect(validateRows(rows, base).has('r1')).toBe(true);
    });
});

describe('retryAfterMs', () => {
    const e429 = (headers?: Record<string, string>) => ({ response: { status: 429, headers } });
    it('reads Retry-After seconds and clamps', () => {
        expect(retryAfterMs(e429({ 'retry-after': '12' }))).toBe(12_000);
        expect(retryAfterMs(e429({ 'retry-after': '0' }))).toBe(1000);
        expect(retryAfterMs(e429({ 'retry-after': '9999' }))).toBe(90_000);
    });
    it('reads an HTTP date and falls back to a default', () => {
        const now = Date.parse('2026-01-01T00:00:00Z');
        expect(retryAfterMs(e429({ 'retry-after': 'Thu, 01 Jan 2026 00:00:20 GMT' }), now)).toBe(20_000);
        expect(retryAfterMs(e429())).toBe(15_000);
    });
    it('is null for anything that is not a 429', () => {
        expect(retryAfterMs({ response: { status: 500 } })).toBeNull();
        expect(retryAfterMs(new Error('x'))).toBeNull();
        expect(retryAfterMs(null)).toBeNull();
    });
});

describe('serverCreateGapMs', () => {
    it('paces only bigger batches, under 20/min', () => {
        expect(serverCreateGapMs(10)).toBe(0);
        expect(serverCreateGapMs(11) * 20).toBeGreaterThan(60_000);
    });
});

describe('runBatch', () => {
    function harness() {
        let clock = 0;
        const sleeps: number[] = [];
        const log: Record<string, RowStatus> = {};
        const errors: Record<string, string | undefined> = {};
        return {
            sleeps, log, errors,
            now: () => clock,
            sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
            onRow: (id: string, p: { status?: RowStatus; error?: string }) => {
                if (p.status) log[id] = p.status;
                if ('error' in p) errors[id] = p.error;
            },
        };
    }
    const rows = (n: number): BulkRow[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, file: file(`e${i}.png`), name: `e${i}x`, status: 'ready' as const }));
    const common = { errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'failed'), concurrency: 2 };

    it('uploads everything, with at most `concurrency` at once', async () => {
        const h = harness();
        let live = 0, peak = 0;
        const s = await runBatch({
            ...common, rows: rows(6), signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow,
            upload: async () => { live++; peak = Math.max(peak, live); await Promise.resolve(); await Promise.resolve(); live--; },
        });
        expect(s).toEqual({ done: 6, failed: 0, cancelled: 0 });
        expect(peak).toBe(2);
        expect(Object.values(h.log).every(x => x === 'done')).toBe(true);
    });

    it('spaces starts by minGapMs (each worker waits for its own reserved start)', async () => {
        const waits: number[] = [];
        await runBatch({
            ...common, concurrency: 4, rows: rows(4), minGapMs: 3100, signal: new AbortController().signal,
            now: () => 0, sleep: async (ms: number) => { waits.push(ms); }, onRow: () => {},
            upload: async () => {},
        });
        expect(waits).toEqual([3100, 6200, 9300]);
    });

    it('a failure does not stop the others; a later retry can succeed', async () => {
        const h = harness();
        let failB = true;
        const up = async (r: BulkRow) => { if (r.id === 'r1' && failB) throw new Error('Boom'); };
        const first = await runBatch({ ...common, rows: rows(3), signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow, upload: up });
        expect(first).toEqual({ done: 2, failed: 1, cancelled: 0 });
        expect(h.log.r1).toBe('error');
        expect(h.errors.r1).toBe('Boom');
        failB = false;
        const retry = await runBatch({ ...common, rows: rows(3).filter(r => r.id === 'r1'), signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow, upload: up });
        expect(retry.done).toBe(1);
        expect(h.log.r1).toBe('done');
        expect(h.errors.r1).toBeUndefined();
    });

    it('on 429 waits Retry-After, holds the whole pool, then succeeds without failing the row', async () => {
        const h = harness();
        let hits = 0;
        const starts: number[] = [];
        const s = await runBatch({
            ...common, concurrency: 1, rows: rows(2), signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow,
            upload: async (r) => {
                starts.push(h.now());
                if (r.id === 'r0' && hits++ === 0) throw { response: { status: 429, headers: { 'retry-after': '20' } } };
            },
        });
        expect(s).toEqual({ done: 2, failed: 0, cancelled: 0 });
        expect(h.sleeps).toContain(20_000);
        expect(starts[1]).toBe(20_000);
    });

    it('gives up on a row that keeps getting 429', async () => {
        const h = harness();
        const s = await runBatch({
            ...common, concurrency: 1, rows: rows(1), maxRateRetries: 2, signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow,
            upload: async () => { throw { response: { status: 429, headers: { 'retry-after': '1' } } }; },
        });
        expect(s.failed).toBe(1);
        expect(h.log.r0).toBe('error');
    });

    it('a fatal error (storage full) skips the rest with a reason', async () => {
        const h = harness();
        const s = await runBatch({
            ...common, concurrency: 1, rows: rows(4), signal: new AbortController().signal, sleep: h.sleep, now: h.now, onRow: h.onRow,
            fatalMessage: e => (e instanceof Error && e.message === 'full' ? 'Server storage is full.' : null),
            upload: async (r) => { if (r.id === 'r1') throw new Error('full'); },
        });
        expect(s).toEqual({ done: 1, failed: 1, cancelled: 2 });
        expect(h.log.r2).toBe('cancelled');
        expect(h.errors.r3).toBe('Skipped: Server storage is full.');
    });

    it('abort stops pending rows and marks them cancelled', async () => {
        const h = harness();
        const ac = new AbortController();
        const s = await runBatch({
            ...common, concurrency: 1, rows: rows(4), signal: ac.signal, sleep: h.sleep, now: h.now, onRow: h.onRow,
            upload: async (r) => { if (r.id === 'r1') ac.abort(); },
        });
        expect(s.done).toBe(2);
        expect(s.cancelled).toBe(2);
        expect(h.log.r2).toBe('cancelled');
        expect(h.log.r3).toBe('cancelled');
    });
});
