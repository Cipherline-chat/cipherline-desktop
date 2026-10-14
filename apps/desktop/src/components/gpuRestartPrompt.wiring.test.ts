import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parsePendingCrashesReply } from '../utils/diagnostics/ipc';

/**
 * Wiring of the GPU-restart pieces into the app (source-level, like
 * callRejoinWiring.test.ts — Dashboard / App / CallPane cannot be rendered
 * under vitest).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8');

describe('GPU restart → prompt → relaunch wiring', () => {
    const dash = read('Dashboard.tsx');

    it('Dashboard mounts the prompt with the call state and the relaunch preparation', () => {
        expect(dash).toContain('<GpuRestartPrompt inCall={!!activeCall} onBeforeRelaunch={prepareGpuRelaunch} />');
    });

    it('relaunch preparation refreshes + flushes the rejoin record — and never rejoins by itself', () => {
        const start = dash.indexOf('const prepareGpuRelaunch = useCallback');
        const body = dash.slice(start, dash.indexOf('}, [userId]);', start));
        expect(body).toContain('rejoinWriteNowRef.current?.()');
        expect(body).toContain('await flushRejoinDescriptor(userId)');
        expect(body).not.toMatch(/acceptRejoin|setActiveCall|\/join/);
        // The pinned invariant (callRejoinWiring.test.ts) still holds globally.
        expect(dash.match(/\bacceptRejoin\(/g) ?? []).toHaveLength(0);
    });

    it('the prompt relaunches through the normal app:relaunch bridge, after the preparation', () => {
        const prompt = read('diagnostics/GpuRestartPrompt.tsx');
        const prep = prompt.indexOf('await onBeforeRelaunch()');
        const relaunch = prompt.indexOf('await api.relaunchApp()');
        expect(prep).toBeGreaterThan(-1);
        expect(relaunch).toBeGreaterThan(prep);
        expect(prompt).toContain('Video stopped after a graphics driver reset');
    });

    it('the listener is installed once at the App root, and the controller lives inside the call room', () => {
        expect(read('../App.tsx')).toContain('useEffect(() => installGpuRestartListener(window.electronAPI), []);');
        const pane = read('CallPane.tsx');
        const room = pane.lastIndexOf('</LiveKitRoom>');
        const ctl = pane.indexOf('<GpuRecoveryController />');
        expect(ctl).toBeGreaterThan(-1);
        expect(ctl).toBeLessThan(room);
    });

    it('SidebarConference: H.265 is gated on hasHevcGpuLost everywhere it is chosen, and our own decode is logged', () => {
        const sc = read('SidebarConference.tsx');
        expect(sc.match(/!hasHevcFailed\(\) && !hasHevcGpuLost\(\)/g)?.length).toBe(3); // camera start, policy, share start
        expect(sc).toContain('formatDecodeCaps({ h265: h265 && !hasHevcGpuLost() })');
        expect(sc).toContain('self_decode: selfDecode');
    });
});

describe('pending crash reply: the main-only "handled" bookkeeping', () => {
    const crash = { kind: 'child_process_gone', process_type: 'GPU', reason: 'crashed', exit_code: 34, occurred_at: '2026-10-11T21:50:16.000Z' };
    it('keeps a known value, drops anything else, and never puts it in the crash (report) itself', () => {
        const list = parsePendingCrashesReply([
            { signature: 'a', count: 1, seen: true, handled: 'recovered', crash },
            { signature: 'b', count: 1, seen: true, handled: 'restart_prompted', crash },
            { signature: 'c', count: 1, seen: false, handled: 'pwned', crash },
            { signature: 'd', count: 1, seen: false, crash },
        ]);
        expect(list.map(p => p.handled)).toEqual(['recovered', 'restart_prompted', undefined, undefined]);
        for (const p of list) expect('handled' in p.crash).toBe(false);
    });

    it('the boot "closed unexpectedly" prompt only considers UNSEEN records (handled ones are seen)', () => {
        const host = read('diagnostics/ReportProblemHost.tsx');
        expect(host).toContain('const unseen = pending.filter(p => !p.seen);');
        expect(host).toMatch(/if \(!entry\.handled\) sentClosed\+\+;/);
    });
});
