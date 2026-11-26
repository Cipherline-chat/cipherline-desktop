/**
 * The own-device transfer trail (electron/near-diag.ts) as the report carries it: the rows survive the scrubber verbatim, a category with
 * a small row budget still shows them, and a row that somehow held an address or a name would be scrubbed anyway.
 */
import { describe, it, expect } from 'vitest';
import { createNearTrail, NEAR_CAUSES } from '../../../electron/near-diag';
import { buildDiagnosticReport, NEAR_TRAIL_MAX_ROWS, type BundleInput, type PerfLogInput } from './bundle';
import { createScrubber } from './scrub';
import type { SystemInfo } from './reportTypes';

const NOW = Date.UTC(2026, 10, 26, 18, 0, 0);
const SYSTEM: SystemInfo = {
    app_version: '0.1.5', build_commit: '34f51243', channel: 'stable', electron: '43.2.0', chrome: '140.0.7339.133', node: '22.19.0',
    platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', cpu_cores: 12, ram_gb: 15.9,
    gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 100,
};
const input = (category: BundleInput['category'], perfLog: PerfLogInput[]): BundleInput => ({
    category, trigger: 'manual', now: NOW, system: SYSTEM, settings: {} as never, perfLog,
    scrub: { sensitiveTerms: ['dawson', 'Dawson Kraai', 'HomeWifi'], homeDir: 'C:\\Users\\Dawson Kraai' },
} as BundleInput);

/** What main would have in the freeze monitor ring after the owner's failed PC to phone attempt. */
function failedAttempt(): string[] {
    const out: string[] = [];
    const trail = createNearTrail({ event: (name, _ms, detail) => { out.push(detail ? `${name} ${detail}` : name); } });
    trail.onHelper({ kind: 'spawned' });
    trail.onHelper({ kind: 'ready' });
    trail.record('offer_received', { result: 'offer' });
    trail.onState({ role: 'own_sender', state: 'awaiting_approval' });
    trail.record('prompt_shown', { method: 'password' });
    trail.record('password_result', { result: 'ok' });
    trail.record('approve', { result: 'approved' });
    trail.onState({
        role: 'own_sender', state: 'refused', error: { code: 'no_proximity', message: 'refused' },
        diag: { adapters: { eligible: 0, wifi: 0, ethernet: 0, unknown: 0, filtered: 2, filteredVirtual: 1, filteredVpn: 1, filteredUnresolved: 0 }, lanUsable: false, peerLan: true, lanPlan: 'none', dialAttempts: 0, lanFail: 'no_usable_network', cause: 'no_usable_network' },
    });
    return out;
}
const rowsOf = (acts: string[], endAt: number): PerfLogInput[] => acts.map((a, i) => ({ at: endAt - (acts.length - i) * 500, source: 'event' as const, ms: 0, activity: a }));
const metrics = (n: number, endAt: number): PerfLogInput[] => Array.from({ length: n }, (_, i) => ({ at: endAt - (n - i) * 1000, source: 'metrics' as const, ms: 0, activity: `browser 1.2% 140MB | tab ${i}.0% 620MB | total 1100MB` }));

describe('near trail rows in a report', () => {
    it('every row the trail can write passes the report scrubber UNCHANGED (nothing in them is a secret-looking, path-like or blob-like token)', () => {
        const scrub = createScrubber({ sensitiveTerms: ['dawson', 'HomeWifi'], homeDir: 'C:\\Users\\Dawson Kraai' });
        const all = [...failedAttempt()];
        const trail = createNearTrail({ event: (name, _ms, detail) => { all.push(detail ? `${name} ${detail}` : name); } });
        for (const cause of NEAR_CAUSES) {
            trail.onState({ role: 'own_receiver', state: 'idle' });
            trail.onState({ role: 'own_receiver', state: 'failed', diag: { dialAttempts: 3, sameSubnet: true, lanResult: 'listen_timeout', lanFail: cause, cause }, error: { code: 'peer_error', message: 'x' }, transfer: { bytesDone: 4294967296, bytesTotal: 9999999999, recordsDone: 120, recordsTotal: 4000, attempt: 3 } });
        }
        trail.onHelper({ kind: 'exited', code: 3221225477, signal: null });
        expect(all.length).toBeGreaterThan(40);
        for (const row of all) expect(scrub.text(row, 300), row).toBe(row);
    });

    it('a 60-row category still shows the trail, even with a minute of newer metrics on top of it', () => {
        const trail = failedAttempt();
        const log = [...rowsOf(trail, NOW - 120_000), ...metrics(200, NOW)];
        const rows = buildDiagnosticReport(input('other', log)).body.payload.perf_log!.rows;
        const near = rows.filter((r) => r.activity.startsWith('near:')).map((r) => r.activity);
        expect(near).toEqual(trail);
        // the newest 60 rows of anything are still there too, in time order
        expect(rows.length).toBe(60 + trail.length);
        expect(rows.map((r) => r.t_s)).toEqual([...rows.map((r) => r.t_s)].sort((a, b) => a - b));
        // and it says what happened to the PC
        expect(near.join('\n')).toContain('near:outcome role=sender state=refused cause=no_usable_network code=no_proximity');
        expect(near.join('\n')).toContain('near:capabilities usable=0 peer_usable=1 plan=none elig=0 wifi=0 eth=0 unk=0 filt=2 virt=1 vpn=1 unres=0');
    });

    it('rows already inside the newest window are not duplicated, and the extra trail is capped', () => {
        const trail = failedAttempt();
        const inWindow = buildDiagnosticReport(input('other', rowsOf(trail, NOW))).body.payload.perf_log!.rows;
        expect(inWindow).toHaveLength(trail.length);
        const flood = Array.from({ length: 200 }, (_, i) => `near:state role=sender state=awaiting_approval n${i}`);
        const rows = buildDiagnosticReport(input('other', [...rowsOf(flood, NOW - 300_000), ...metrics(120, NOW)])).body.payload.perf_log!.rows;
        expect(rows.filter((r) => r.activity.startsWith('near:'))).toHaveLength(NEAR_TRAIL_MAX_ROWS);
    });

    it('a planted IPv4 / IPv6 address or MAC in a near row is scrubbed by the report anyway (defence in depth behind the trail\'s schema, which is what keeps names out: perf rows are code-chosen words and are not run through the name list)', () => {
        const hostile: PerfLogInput[] = [
            { at: NOW - 3000, source: 'event', ms: 0, activity: 'near:lan result=timeout 192.168.1.20:5555' },
            { at: NOW - 2000, source: 'event', ms: 0, activity: 'near:capabilities mac=aa:bb:cc:dd:ee:ff mac2=AA-BB-CC-DD-EE-FF' },
            { at: NOW - 1000, source: 'event', ms: 0, activity: 'near:state fe80::1ff:fe23:4567:890a 2001:db8:85a3:0:0:8a2e:370:7334' },
        ];
        const body = JSON.stringify(buildDiagnosticReport(input('other', hostile)).body.payload.perf_log);
        for (const leak of ['192.168.1.20', 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'fe80::1ff', '2001:db8']) expect(body).not.toContain(leak);
        expect(body).toContain('<mac>');
    });
});
