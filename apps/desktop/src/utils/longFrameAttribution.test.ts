import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attributeFrame, frameLabels, scriptFile, scriptFn, scriptInvoker, type LoafEntryLike } from './longFrameAttribution';
import { recordLongFrame, fetchFreezeLog, beginActivity, setFreezeTap, LONG_TASK_MS, WAKE_SETTLE_MS, __resetFreezeLogForTests } from './freezeLog';
import { getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

const ORIGIN = 'http://127.0.0.1:48123';
const LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

describe('longFrameAttribution — reduces LoAF scripts to code identifiers', () => {
    it('keeps only the basename of a script on our own origin', () => {
        expect(scriptFile(`${ORIGIN}/assets/index-B4xYz12a.js`, ORIGIN)).toBe('index-B4xYz12a.js');
        expect(scriptFile(`${ORIGIN}/assets/ChatPane-Dq3.js?v=2#x`, ORIGIN)).toBe('ChatPane-Dq3.js');
        expect(scriptFile('http://cipherline.chat:5174/src/components/Dashboard.tsx?t=1712', 'http://cipherline.chat:5174')).toBe('Dashboard.tsx');
    });

    it('never passes through a foreign, file:, blob: or missing URL (negative controls)', () => {
        expect(scriptFile('https://cdn.example.com/u/alice/lib.js', ORIGIN)).toBe('ext');
        expect(scriptFile('file:///C:/Users/alice/AppData/Local/Programs/Cipherline/resources/app.asar/dist/assets/index-x.js', ORIGIN)).toBe('ext');
        expect(scriptFile(`blob:${ORIGIN}/7d3f1a2e-9c41-4b8e-a1f0-2b6c9d8e7f10`, ORIGIN)).toBe('ext');
        expect(scriptFile('chrome-extension://abcdef/content.js', ORIGIN)).toBe('ext');
        expect(scriptFile('', ORIGIN)).toBe('none');
        expect(scriptFile(undefined, ORIGIN)).toBe('none');
        expect(scriptFile(`${ORIGIN}/assets/index-x.js`, null)).toBe('ext');
        expect(scriptFile(`${ORIGIN}/assets/a%20b%20c.js`, ORIGIN)).toBe('unknown');
    });

    it('reduces a function name to a plain identifier', () => {
        expect(scriptFn('handleChange')).toBe('handleChange');
        expect(scriptFn('$e')).toBe('e');
        expect(scriptFn('Object.<anonymous>')).toBe('Object__anonymous');
        expect(scriptFn('')).toBe('anon');
        expect(scriptFn(undefined)).toBe('anon');
        expect(scriptFn('x'.repeat(80))).toHaveLength(32);
    });

    it('reduces the invoker to <Interface>.<member>, dropping ids, attributes and URLs', () => {
        expect(scriptInvoker('IMG[src=https://media.cipherline.chat/avatars/alice.png].onload', 'event-listener')).toBe('IMG.onload');
        expect(scriptInvoker('BUTTON#send-to-alice.onclick', 'event-listener')).toBe('BUTTON.onclick');
        expect(scriptInvoker('DIV.message-row.onkeydown', 'event-listener')).toBe('DIV.onkeydown');
        expect(scriptInvoker('Window.requestAnimationFrame', 'user-callback')).toBe('Window.requestAnimationFrame');
        expect(scriptInvoker('TimerHandler:setTimeout', 'user-callback')).toBe('TimerHandler.setTimeout');
        expect(scriptInvoker('MessagePort.onmessage', 'event-listener')).toBe('MessagePort.onmessage');
        // Real Electron 43 invokers seen on window refocus (idle-return harness):
        expect(scriptInvoker('DOMWindow.onfocus', 'event-listener')).toBe('DOMWindow.onfocus');
        expect(scriptInvoker('#document.onvisibilitychange', 'event-listener')).toBe('document.onvisibilitychange');
        expect(scriptInvoker('Scheduler.yield.then', 'resolve-promise')).toBe('Scheduler.then');
        expect(scriptInvoker('Response.json.then', 'resolve-promise')).toBe('Response.then');
        expect(scriptInvoker(`${ORIGIN}/assets/index-x.js`, 'classic-script')).toBe('script');
        expect(scriptInvoker('', 'resolve-promise')).toBe('resolve-promise');
        expect(scriptInvoker('#!?', 'weird')).toBe('unknown');
    });

    it('orders scripts by duration and splits script / render / forced-layout time', () => {
        const a = attributeFrame({
            startTime: 1000, duration: 900, blockingDuration: 850, renderStart: 1800,
            scripts: [
                { sourceURL: `${ORIGIN}/assets/index-a.js`, sourceFunctionName: 'small', sourceCharPosition: 10, duration: 50, invoker: 'Window.setTimeout', invokerType: 'user-callback' },
                { sourceURL: `${ORIGIN}/assets/index-a.js`, sourceFunctionName: 'big', sourceCharPosition: 123456, duration: 700, forcedStyleAndLayoutDuration: 60, invoker: 'DIV#x.onkeydown', invokerType: 'event-listener' },
            ],
        }, ORIGIN);
        expect(a).toMatchObject({ ms: 900, blockingMs: 850, renderMs: 100, layoutMs: 60, scriptMs: 750, scriptCount: 2 });
        expect(a.scripts.map(s => s.fn)).toEqual(['big', 'small']);
        expect(frameLabels(a)).toEqual([
            'js:index-a.js:big:c123456:700ms',
            'js:index-a.js:small:c10:50ms',
            'via:DIV.onkeydown',
            'render:100ms',
            'forced-layout:60ms',
        ]);
    });

    it('every label fits main\'s LABEL_RE, even with long names', () => {
        const a = attributeFrame({
            startTime: 0, duration: 400,
            scripts: [{ sourceURL: `${ORIGIN}/assets/${'v'.repeat(40)}.js`, sourceFunctionName: 'f'.repeat(60), sourceCharPosition: 9_999_999, duration: 399, invoker: 'A'.repeat(31) + '.' + 'b'.repeat(41), invokerType: 'event-listener' }],
        }, ORIGIN);
        const labels = frameLabels(a);
        expect(labels.length).toBeGreaterThanOrEqual(2);
        for (const l of labels) expect(l).toMatch(LABEL_RE);
    });

    it('tolerates malformed entries', () => {
        const a = attributeFrame({ startTime: 0, duration: Number.NaN, scripts: [{} as never, { duration: -5, sourceCharPosition: 1.5 }] } as LoafEntryLike, ORIGIN);
        expect(a).toMatchObject({ ms: 0, scriptMs: 0, scriptCount: 2 });
        expect(a.scripts[0]).toMatchObject({ file: 'none', fn: 'anon', char: -1, invoker: 'unknown' });
    });
});

describe('recordLongFrame — LoAF rows in the freeze log and the call-event ring', () => {
    const realLocation = globalThis.location;
    beforeEach(() => {
        __resetFreezeLogForTests();
        clearCallEvents();
        Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true });
    });
    afterEach(() => {
        Object.defineProperty(globalThis, 'location', { value: realLocation, configurable: true });
        vi.useRealTimers();
    });

    const frame = (ms: number, extra: Partial<LoafEntryLike> = {}): LoafEntryLike => ({
        startTime: performance.now(), duration: ms, blockingDuration: ms - 50, renderStart: 0,
        scripts: [{
            sourceURL: `${ORIGIN}/assets/ChatPane-Dq3.js`, sourceFunctionName: 'onInput', sourceCharPosition: 4242,
            duration: ms - 20, invoker: 'TEXTAREA#composer.oninput', invokerType: 'event-listener',
        }],
        ...extra,
    });

    it('records nothing for a frame under the threshold (negative control)', async () => {
        recordLongFrame(frame(LONG_TASK_MS - 1));
        recordLongFrame(frame(120));
        expect(await fetchFreezeLog()).toHaveLength(0);
        expect(getCallEvents()).toHaveLength(0);
    });

    it('records nothing for a long frame that did not block this thread (compositor wait, negative control)', async () => {
        // Seen in the idle-return harness: 200–565 ms frames, blockingDuration 0, no scripts.
        recordLongFrame(frame(565, { blockingDuration: 0, scripts: [] }));
        recordLongFrame(frame(320, { blockingDuration: LONG_TASK_MS - 51 }));
        expect(await fetchFreezeLog()).toHaveLength(0);
        expect(getCallEvents()).toHaveLength(0);
    });

    it('records a long frame with the overlapping activity AND the script that ran', async () => {
        const end = beginActivity('dm:pull');
        recordLongFrame(frame(1400));
        end();
        const rows = await fetchFreezeLog();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: 'renderer', ms: 1400 });
        expect(rows[0].activity).toBe('dm:pull, js:ChatPane-Dq3.js:onInput:c4242:1380ms, via:TEXTAREA.oninput');
        for (const l of rows[0].activity.split(', ')) expect(l).toMatch(LABEL_RE);

        const ev = getCallEvents();
        expect(ev).toHaveLength(1);
        expect(ev[0].kind).toBe('long_frame');
        expect(ev[0].detail).toEqual({
            ms: 1400, blocking_ms: 1350, render_ms: 0, layout_ms: 0, script_ms: 1380, scripts: 1,
            file: 'ChatPane-Dq3.js', fn: 'onInput', char: 4242, invoker: 'TEXTAREA.oninput', invoker_type: 'event-listener',
        });
        expect(validateCallEvent(ev[0])).toEqual([]);
    });

    it('a frame with no attributable script still records, labelled by context only', async () => {
        recordLongFrame(frame(300, { scripts: [] }));
        const rows = await fetchFreezeLog();
        expect(rows[0].activity).toBe('idle');
        expect(getCallEvents()[0].detail).toMatchObject({ file: 'none', fn: 'none', char: -1, scripts: 0 });
    });

    it('leaks no URL, path, id or attribute from planted script data', async () => {
        recordLongFrame(frame(500, {
            scripts: [{
                sourceURL: 'file:///C:/Users/alice.smith/AppData/Local/Programs/Cipherline/x.js',
                sourceFunctionName: 'run', duration: 480,
                invoker: 'IMG[src=https://cdn.example.com/u/alice.smith/7d3f1a2e-9c41-4b8e-a1f0-2b6c9d8e7f10.png].onload',
                invokerType: 'event-listener',
            }],
        }));
        const text = JSON.stringify([await fetchFreezeLog(), getCallEvents()]);
        expect(text).not.toMatch(/alice|Users|example|7d3f1a2e|https?:|file:/);
        expect(text).toContain('js:ext:run');
        expect(text).toContain('IMG.onload');
    });

    it('hands the freeze tap the BLOCKED time, not a frame span that covers idle or sleep', () => {
        vi.useFakeTimers();
        const seen: number[] = [];
        setFreezeTap((ms) => { seen.push(ms); });
        try {
            // A frame left open across a 101-minute sleep (prod app_freeze ms=6077366):
            // only ~300 ms of it blocked the thread.
            recordLongFrame(frame(6_077_366, { blockingDuration: 300 }));
            // Positive control: a real 1.4 s freeze still reaches the tap as one.
            recordLongFrame(frame(1400));
            // No blockingDuration from this Chromium: falls back to duration - 50.
            recordLongFrame(frame(1200, { blockingDuration: undefined }));
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
        } finally {
            setFreezeTap(null);
            vi.useRealTimers();
        }
        expect(seen).toEqual([300, 1350, 1150]);
    });

    it('caps long_frame call events per minute but keeps every freeze-log row', async () => {
        for (let i = 0; i < 30; i++) recordLongFrame(frame(250));
        expect(await fetchFreezeLog()).toHaveLength(30);
        expect(getCallEvents().filter(e => e.kind === 'long_frame').length).toBeLessThanOrEqual(20);
    });

    it('keeps the row within main\'s 300-character activity limit', async () => {
        const ends = ['startup:hydrate', 'dm:pull', 'resume:rehydrate', 'channel:page'].map(l => beginActivity(l));
        recordLongFrame(frame(900, {
            renderStart: performance.now() + 700,
            scripts: [0, 1, 2].map(i => ({
                sourceURL: `${ORIGIN}/assets/${'chunk'.repeat(5)}${i}.js`, sourceFunctionName: 'f'.repeat(30) + i,
                sourceCharPosition: 1_000_000 + i, duration: 300 - i, invoker: 'DIV.onscroll', invokerType: 'event-listener',
                forcedStyleAndLayoutDuration: 40,
            })),
        }));
        ends.forEach(e => e());
        const [row] = await fetchFreezeLog();
        expect(row.activity.length).toBeLessThanOrEqual(300);
        expect(row.activity).toContain('startup:hydrate');
    });
});

describe('long-frame attribution survives the report builder (scrub) intact', () => {
    it('a performance report carries the js: labels and the long_frame event verbatim', async () => {
        const { buildDiagnosticReport } = await import('./diagnostics/bundle');
        const now = Date.UTC(2026, 9, 12, 3, 0, 0);
        const activity = 'view:server, js:index-B4xYz12a.js:Xe:c1234567:1380ms, via:MessagePort.onmessage, render:90ms';
        const built = buildDiagnosticReport({
            category: 'performance', trigger: 'manual', now,
            system: {
                app_version: '1.0.21', build_commit: '4fd9a1b4', channel: 'stable', electron: '43.2.0', chrome: '150.0.7400.1', node: '24.1.0',
                platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'cpu', cpu_cores: 8, ram_gb: 16,
                gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 100,
            },
            settings: {},
            perfLog: [{ at: now - 5000, source: 'renderer', ms: 1400, activity }],
            callEvents: [{ t: now - 5000, kind: 'long_frame', detail: { ms: 1400, file: 'index-B4xYz12a.js', fn: 'Xe', char: 1234567, invoker: 'MessagePort.onmessage', invoker_type: 'event-listener' } }],
            scrub: { sensitiveTerms: ['nightowl42'] },
        });
        const p = built.body.payload;
        expect(p.perf_log?.rows[0].activity).toBe(activity);
        expect(p.call_events?.[0]).toMatchObject({ event: 'long_frame', detail: { file: 'index-B4xYz12a.js', fn: 'Xe', char: 1234567, invoker: 'MessagePort.onmessage' } });
    });
});
