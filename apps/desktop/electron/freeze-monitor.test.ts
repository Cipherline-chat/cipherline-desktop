import { describe, it, expect, vi, afterEach } from 'vitest';
import { FreezeMonitor, MAX_ENTRIES, MAX_EVENTS, MAX_METRICS, STALL_THRESHOLD_MS, CLOCK_JUMP_MS, CAPTURE_STALL_THRESHOLD_MS } from './freeze-monitor';

describe('FreezeMonitor — activity attribution', () => {
    it('names the activities that overlapped a stall, newest first, and "idle" when none did', () => {
        let t = 1000;
        const m = new FreezeMonitor(() => t);
        expect(m.activityDuring(0, 5000)).toBe('idle');

        const endA = m.begin('startup:hydrate');
        t = 2000;
        const endB = m.begin('ipc:securekv:open');
        t = 2500; endB();
        t = 3000; endA();

        expect(m.activityDuring(2100, 2200)).toBe('ipc:securekv:open, startup:hydrate');
        expect(m.activityDuring(2600, 2700)).toBe('startup:hydrate');
        expect(m.activityDuring(4000, 4100)).toBe('idle');
    });

    it('track() covers the whole promise of an async function, not just its sync part', async () => {
        let t = 0;
        const m = new FreezeMonitor(() => t);
        let release!: () => void;
        const p = m.track('ipc:channel:decrypt-message', () => new Promise<void>(r => { release = r; }));
        t = 500;
        expect(m.activityDuring(400, 450)).toBe('ipc:channel:decrypt-message');
        release();
        await p;
        t = 1000;
        expect(m.activityDuring(900, 950)).toBe('idle');
    });

    it('track() ends the activity when the function throws synchronously', () => {
        let t = 0;
        const m = new FreezeMonitor(() => t);
        expect(() => m.track('ipc:boom', () => { throw new Error('x'); })).toThrow('x');
        t = 100;
        expect(m.activityDuring(50, 60)).toBe('idle');
    });

    it('a label that is not a static identifier is stored as "unlabelled", never verbatim', () => {
        const t = 0;
        const m = new FreezeMonitor(() => t);
        m.begin('hello Alice, here is your message');
        expect(m.activityDuring(0, 1)).toBe('unlabelled');
    });
});

describe('FreezeMonitor — renderer rows are a trust boundary', () => {
    it('stores well-formed rows and drops malformed ones instead of coercing them', () => {
        const m = new FreezeMonitor(() => 0);
        const stored = m.recordFromRenderer([
            { at: 1_700_000_000_000, ms: 350.4, activity: 'dm:pull' },
            { at: 1_700_000_000_001, ms: 900, activity: 'channel:history, resume:rehydrate' },
            { at: 'x', ms: 300, activity: 'dm:pull' },
            { at: 1, ms: -5, activity: 'dm:pull' },
            { at: 1, ms: 300, activity: 'text from a message' },
            { at: 1, ms: 300, activity: 42 },
            null,
        ]);
        expect(stored).toBe(2);
        const snap = m.snapshot();
        expect(snap.map(e => e.activity)).toEqual(['channel:history, resume:rehydrate', 'dm:pull']);
        expect(snap.every(e => e.source === 'renderer')).toBe(true);
        expect(snap[1].ms).toBe(350);
    });

    it('ignores a non-array payload and caps a single push at 50 rows', () => {
        const m = new FreezeMonitor(() => 0);
        expect(m.recordFromRenderer({ at: 1 })).toBe(0);
        const many = Array.from({ length: 80 }, (_, i) => ({ at: i, ms: 250, activity: 'idle' }));
        expect(m.recordFromRenderer(many)).toBe(50);
    });

    it('is a bounded ring buffer', () => {
        const m = new FreezeMonitor(() => 0);
        for (let i = 0; i < MAX_ENTRIES + 25; i++) m.record({ at: i, source: 'main', ms: 250, activity: 'idle' });
        const snap = m.snapshot();
        expect(snap).toHaveLength(MAX_ENTRIES);
        expect(snap[0].at).toBe(MAX_ENTRIES + 24);
    });
});

describe('FreezeMonitor — main event-loop stall detection', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('records a stall with its duration and the activity that caused it', () => {
        vi.useFakeTimers();
        const m = new FreezeMonitor(() => Date.now());
        m.startLoopMonitor(100);
        vi.advanceTimersByTime(300); // healthy ticks: nothing recorded
        expect(m.snapshot()).toHaveLength(0);

        // Simulate a synchronous block: the clock jumps with no timer firing.
        const end = m.begin('ipc:securekv:open');
        vi.setSystemTime(Date.now() + 100 + STALL_THRESHOLD_MS + 150);
        end();
        vi.advanceTimersByTime(100);

        const snap = m.snapshot();
        expect(snap).toHaveLength(1);
        expect(snap[0].source).toBe('main');
        expect(snap[0].ms).toBeGreaterThanOrEqual(STALL_THRESHOLD_MS);
        expect(snap[0].activity).toBe('ipc:securekv:open');
        m.stopLoopMonitor();
    });

    it('a sleep is not a stall: an 8-hour gap becomes an event and a clock-jump callback', () => {
        vi.useFakeTimers();
        const m = new FreezeMonitor(() => Date.now());
        const jumps: number[] = [];
        m.onClockJump = (ms) => jumps.push(ms);
        m.startLoopMonitor(100);
        vi.setSystemTime(Date.now() + 8 * 60 * 60_000);
        vi.advanceTimersByTime(100);
        const snap = m.snapshot();
        expect(snap.filter(e => e.source === 'main')).toHaveLength(0);
        expect(snap[0]).toMatchObject({ source: 'event', activity: 'main:loop-gap sleep or suspended process' });
        expect(jumps).toHaveLength(1);
        expect(jumps[0]).toBeGreaterThanOrEqual(CLOCK_JUMP_MS);
        m.stopLoopMonitor();
    });

    it('pause()/unpause() across a suspend records nothing for the gap', () => {
        vi.useFakeTimers();
        const m = new FreezeMonitor(() => Date.now());
        m.startLoopMonitor(100);
        m.pause();
        vi.setSystemTime(Date.now() + 5000);
        vi.advanceTimersByTime(100);
        m.unpause();
        vi.setSystemTime(Date.now() + 2000);   // the resume itself took a moment
        vi.advanceTimersByTime(100);
        expect(m.snapshot()).toHaveLength(0);
        m.stopLoopMonitor();
    });

    it('a freeze capture lowers the threshold to 100 ms for its duration only', () => {
        vi.useFakeTimers();
        const m = new FreezeMonitor(() => Date.now());
        const stalls: number[] = [];
        m.onStall = (ms) => stalls.push(ms);
        m.startLoopMonitor(100);
        m.startCapture(10_000);
        vi.setSystemTime(Date.now() + CAPTURE_STALL_THRESHOLD_MS + 20);
        vi.advanceTimersByTime(100);
        expect(m.snapshot().filter(e => e.source === 'main')).toHaveLength(1);
        vi.advanceTimersByTime(11_000);           // capture over
        vi.setSystemTime(Date.now() + CAPTURE_STALL_THRESHOLD_MS + 20);
        vi.advanceTimersByTime(100);
        expect(m.snapshot().filter(e => e.source === 'main')).toHaveLength(1);
        expect(stalls).toHaveLength(1);
        m.stopLoopMonitor();
    });
});

describe('FreezeMonitor — events and metrics', () => {
    it('stores static events and refuses free text', () => {
        const m = new FreezeMonitor(() => 5);
        m.event('window:restore', 1200, 'from=minimized');
        m.event('hello Alice', 1);
        m.event('renderer:gone', 0, 'https://example.com/?q=secret');
        m.metrics('restore: browser 1.0% 140MB | total 900MB');
        m.metrics('a message from Bob: "hi"');
        expect(m.snapshot().map(e => [e.source, e.activity])).toEqual([
            ['event', 'window:restore from=minimized'],
            ['event', 'renderer:gone'],           // detail dropped, not stored
            ['metrics', 'restore: browser 1.0% 140MB | total 900MB'],
        ]);
    });

    it('events and metrics live in their own bounded rings and never push stalls out', () => {
        const m = new FreezeMonitor(() => 0);
        m.record({ at: 0, source: 'main', ms: 900, activity: 'idle' });
        for (let i = 0; i < MAX_EVENTS + 50; i++) m.event('window:focus');
        for (let i = 0; i < MAX_METRICS + 50; i++) m.metrics('periodic: total 1MB');
        const snap = m.snapshot();
        expect(snap.filter(e => e.source === 'main')).toHaveLength(1);
        expect(snap.filter(e => e.source === 'event')).toHaveLength(MAX_EVENTS);
        expect(snap.filter(e => e.source === 'metrics')).toHaveLength(MAX_METRICS);
        m.clear();
        expect(m.snapshot()).toHaveLength(0);
    });

    it('the snapshot interleaves everything newest first', () => {
        let t = 0;
        const m = new FreezeMonitor(() => t);
        m.record({ at: 10, source: 'main', ms: 300, activity: 'idle' });
        t = 20; m.event('window:restore');
        t = 5; m.metrics('periodic: total 1MB');
        expect(m.snapshot().map(e => e.at)).toEqual([20, 10, 5]);
    });
});
