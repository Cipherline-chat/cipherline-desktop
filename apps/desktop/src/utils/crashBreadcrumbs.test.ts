import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBreadcrumbDetail, mirrorBreadcrumb, BREADCRUMB_KINDS } from './crashBreadcrumbs';
import { FreezeMonitor, BREADCRUMB_MAX, BREADCRUMB_WINDOW_MS } from '../../electron/freeze-monitor';
import { CALL_EVENT_KINDS, logCallEvent, clearCallEvents } from './callEventLog';

describe('formatBreadcrumbDetail', () => {
    it('keeps scalars as k=v and drops free-text-ish fields', () => {
        expect(formatBreadcrumbDetail({
            codec: 'h264', profile: 'cb', hardware: true, fps: 60, reason: 'auto: HW H.264',
            fg_exe: 'BeamNG.drive.x64.exe', enc: 'OpenH264',
        })).toBe('codec=h264 profile=cb hardware=1 fps=60');
    });
    it('empty for nothing safe', () => {
        expect(formatBreadcrumbDetail(undefined)).toBe('');
        expect(formatBreadcrumbDetail({ reason: 'has spaces in it' })).toBe('');
    });
    it('is bounded', () => {
        const big: Record<string, number> = {};
        for (let i = 0; i < 40; i++) big[`k${i}`] = 123456 + i;
        expect(formatBreadcrumbDetail(big).length).toBeLessThanOrEqual(200);
    });
});

describe('mirrorBreadcrumb', () => {
    it('sends allowlisted kinds as call:<kind>, nothing else', () => {
        const send = vi.fn();
        expect(mirrorBreadcrumb('share_codec', { codec: 'h264' }, send)).toBe(true);
        expect(send).toHaveBeenCalledWith('call:share_codec', 'codec=h264');
        expect(mirrorBreadcrumb('focus_switched', { ms: 3 }, send)).toBe(false);
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('never throws, with or without a bridge', () => {
        expect(mirrorBreadcrumb('share_codec', {}, () => { throw new Error('x'); })).toBe(false);
        expect(mirrorBreadcrumb('share_codec', {}, undefined)).toBe(false);
    });
    it('every allowlisted kind is a real call-event kind', () => {
        for (const k of BREADCRUMB_KINDS) expect(CALL_EVENT_KINDS as readonly string[]).toContain(k);
    });
});

describe('logCallEvent mirrors through window.electronAPI.perfBreadcrumb', () => {
    afterEach(() => { delete (globalThis as { window?: unknown }).window; clearCallEvents(); });
    it('a share_codec event reaches the bridge', () => {
        const perfBreadcrumb = vi.fn();
        (globalThis as { window?: unknown }).window = { electronAPI: { perfBreadcrumb } };
        logCallEvent('share_codec', { codec: 'h264', profile: 'cb', hardware: true });
        expect(perfBreadcrumb).toHaveBeenCalledWith('call:share_codec', 'codec=h264 profile=cb hardware=1');
    });
});

describe('FreezeMonitor.breadcrumb (main side)', () => {
    it('stores call:<kind> rows that survive in the snapshot; rejects anything else', () => {
        const t = 1000;
        const m = new FreezeMonitor(() => t);
        expect(m.breadcrumb('call:share_codec', 'codec=h264 fps=60')).toBe(true);
        expect(m.breadcrumb('ipc:fake', 'x')).toBe(false);
        expect(m.breadcrumb('call:share codec', '')).toBe(false);
        expect(m.breadcrumb('call:share_codec', 'name="Alice" <script>')).toBe(false);
        expect(m.breadcrumb(42, 'x')).toBe(false);
        expect(m.snapshot().map(r => r.activity)).toEqual(['call:share_codec codec=h264 fps=60']);
    });
    it(`is rate-limited to ${BREADCRUMB_MAX} per ${BREADCRUMB_WINDOW_MS} ms`, () => {
        let t = 1000;
        const m = new FreezeMonitor(() => t);
        let ok = 0;
        for (let i = 0; i < BREADCRUMB_MAX + 10; i++) if (m.breadcrumb('call:share_fps', `n=${i}`)) ok++;
        expect(ok).toBe(BREADCRUMB_MAX);
        t += BREADCRUMB_WINDOW_MS + 1;
        expect(m.breadcrumb('call:share_fps', 'n=late')).toBe(true);
    });
});

describe('wiring', () => {
    it('main registers perf:breadcrumb into the freeze monitor; preload exposes it', () => {
        const main = readFileSync(join(__dirname, '../../electron/main.ts'), 'utf8');
        const preload = readFileSync(join(__dirname, '../../electron/preload.ts'), 'utf8');
        expect(main).toMatch(/ipcMain\.on\('perf:breadcrumb',[^\n]*freezeMonitor\.breadcrumb\(name, detail\)/);
        expect(preload).toMatch(/perfBreadcrumb:[\s\S]{0,120}ipcRenderer\.send\('perf:breadcrumb'/);
    });
});
