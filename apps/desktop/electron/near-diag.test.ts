import { describe, expect, it } from 'vitest';
import { createNearTrail, formatTrailDetail, NEAR_CAUSES } from './near-diag';
import { DETAIL_RE, LABEL_RE } from './freeze-monitor';

function rig() {
    const rows: Array<{ name: string; detail?: string }> = [];
    const trail = createNearTrail({ event: (name, _ms, detail) => { rows.push({ name, detail }); } });
    return { rows, trail, text: () => rows.map((r) => (r.detail ? `${r.name} ${r.detail}` : r.name)) };
}

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const MAC = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i;

describe('near trail: what a row may say', () => {
    it('keeps a field only when it is in the schema and inside its closed set; everything else is dropped, never coerced', () => {
        expect(formatTrailDetail({ role: 'sender', state: 'failed', cause: 'different_network', elig: 2, usable: true, same_subnet: false })).toBe('role=sender state=failed cause=different_network elig=2 usable=1 same_subnet=0');
        // an unlisted key, a value outside its set, a wrong type, a negative or fractional-NaN number
        expect(formatTrailDetail({ ssid: 'HomeWifi', adapter: 'Ethernet 3', ip: '192.168.1.20', user: 'dawson' })).toBe('');
        expect(formatTrailDetail({ cause: 'dawsons-iphone', role: 'PC-of-Dawson', state: 'x y' })).toBe('');
        expect(formatTrailDetail({ elig: -1, wifi: Number.NaN, eth: '2', usable: 'yes' })).toBe('');
        expect(formatTrailDetail({ __proto__: 'x', constructor: 'y', toString: 'z' } as never)).toBe('');
    });

    it('stays inside the freeze monitor\'s alphabet and budget, whatever it is fed', () => {
        const d = formatTrailDetail({ usable: true, peer_usable: true, plan: 'dial', elig: 3, wifi: 1, eth: 1, unk: 1, filt: 2, virt: 1, vpn: 1, unres: 0, bytes: 12345678901, bytes_total: 12345678901, recs: 9, recs_total: 9, tries: 2 });
        expect(d).toMatch(DETAIL_RE);
        expect(d.length).toBeLessThanOrEqual(200);
    });

    it('every cause the engine can say is a short lowercase word that survives the freeze monitor and the scrubber unchanged', () => {
        for (const c of NEAR_CAUSES) {
            expect(`near:outcome`).toMatch(LABEL_RE);
            expect(formatTrailDetail({ cause: c })).toBe(`cause=${c}`);
            expect(formatTrailDetail({ cause: c })).toMatch(DETAIL_RE);
        }
    });
});

describe('near trail: a failed own-device transfer, as the report will show it', () => {
    const own = (state: string, extra: Record<string, unknown> = {}) => ({ seq: 1, role: 'own_sender', state, ...extra });

    it('records the holder\'s whole attempt: helper, offer, sheet, prompt, capabilities, the dial, the outcome', () => {
        const { trail, text } = rig();
        trail.onHelper({ kind: 'spawned' });
        trail.onHelper({ kind: 'ready' });
        trail.record('offer_received', { result: 'offer' });
        trail.onState(own('creating_session'));
        trail.onState(own('awaiting_approval'));
        trail.onState(own('awaiting_approval')); // a re-sent snapshot is not a new row
        trail.record('prompt_shown', { method: 'password' });
        trail.record('password_result', { result: 'wrong' });
        trail.record('password_result', { result: 'ok' });
        trail.record('prompt_closed', { verdict: 'approved', why: 'submit' });
        trail.record('approve', { result: 'approved' });
        const diag = { adapters: { eligible: 0, wifi: 0, ethernet: 0, unknown: 0, filtered: 2, filteredVirtual: 1, filteredVpn: 1, filteredUnresolved: 0 }, lanUsable: false, peerLan: true, lanPlan: 'none', dialAttempts: 0, lanFail: 'no_usable_network' };
        trail.onState(own('approving', { diag }));
        trail.onState(own('refused', { diag: { ...diag, cause: 'no_usable_network' }, error: { code: 'no_proximity', message: 'refused' } }));
        trail.onHelper({ kind: 'exited', code: 0, signal: null });
        expect(text()).toEqual([
            'near:helper_spawned',
            'near:helper_ready',
            'near:offer_received result=offer',
            'near:state role=sender state=creating_session',
            'near:state role=sender state=awaiting_approval',
            'near:sheet_shown role=sender',
            'near:prompt_shown method=password',
            'near:password_result result=wrong',
            'near:password_result result=ok',
            'near:prompt_closed verdict=approved why=submit',
            'near:approve result=approved',
            'near:state role=sender state=approving',
            'near:capabilities usable=0 peer_usable=1 plan=none elig=0 wifi=0 eth=0 unk=0 filt=2 virt=1 vpn=1 unres=0',
            'near:state role=sender state=refused',
            'near:outcome role=sender state=refused cause=no_usable_network code=no_proximity',
            'near:helper_exited exit=0',
        ]);
    });

    it('records the dial attempts and the same-subnet answer once, and bytes and records when something moved', () => {
        const { trail, text } = rig();
        const base = { role: 'own_receiver', seq: 1 };
        trail.onState({ ...base, state: 'proving_lan', diag: { dialAttempts: 0, sameSubnet: false, lanResult: 'off_link', lanFail: 'different_network' } });
        trail.onState({ ...base, state: 'proving_lan', seq: 2, diag: { dialAttempts: 0, sameSubnet: false, lanResult: 'off_link', lanFail: 'different_network' } });
        trail.onState({ ...base, state: 'failed', transfer: { bytesDone: 1048576, bytesTotal: 5000000, recordsDone: 3, recordsTotal: 9, attempt: 2 }, diag: { dialAttempts: 1, lanResult: 'ok', cause: 'failed' }, error: { code: 'peer_error', message: 'x' } });
        expect(text()).toEqual([
            'near:state role=receiver state=proving_lan',
            'near:lan same_subnet=0 dials=0 result=off_link fail=different_network',
            'near:state role=receiver state=failed',
            'near:lan dials=1 result=ok',
            'near:transfer bytes=1048576 bytes_total=5000000 recs=3 recs_total=9 tries=2',
            'near:outcome role=receiver state=failed cause=failed code=peer_error',
        ]);
    });

    it('a cause or code this build does not know becomes `other`, and a helper that died is an outcome with its code', () => {
        const { trail, text } = rig();
        trail.onState({ role: 'own_receiver', state: 'failed', diag: { dialAttempts: 0, cause: 'a_cause_from_the_future' }, error: { code: 'http_500_for_dawson', message: 'x' } });
        trail.onState({ role: null, state: 'idle' });
        trail.onState({ role: null, state: 'failed', error: { code: 'helper_exited', message: 'exited (3221225477)' } });
        trail.onHelper({ kind: 'exited', code: 3221225477, signal: null });
        trail.onHelper({ kind: 'exited', code: null, signal: 'SIGSEGV' });
        trail.onHelper({ kind: 'exited', code: null, signal: 'SIGDANCE' });
        trail.onHelper({ kind: 'unavailable', why: 'no_binary' });
        expect(text()).toEqual([
            'near:state role=receiver state=failed',
            'near:outcome role=receiver state=failed cause=other code=other',
            'near:state role=none state=failed',
            'near:outcome role=none state=failed code=helper_exited',
            'near:helper_exited exit=3221225477',
            'near:helper_exited sig=SIGSEGV',
            'near:helper_exited sig=other',
            'near:helper_unavailable why=no_binary',
        ]);
    });

    it('whatever a hostile or confused snapshot carries, no row holds an IP address, a MAC, a name or free text', () => {
        const { trail, rows, text } = rig();
        trail.onState({
            role: 'own_sender', state: 'refused', peer: { label: 'Dawson\'s iPhone', platform: 'ios' }, linkId: 'own:3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b',
            diag: {
                adapters: { eligible: 1, wifi: 1, ethernet: 0, unknown: 0, filtered: 0, filteredVirtual: 0, filteredVpn: 0, filteredUnresolved: 0, name: 'Intel(R) Wi-Fi 6 AX201', ssid: 'HomeWifi', mac: 'aa:bb:cc:dd:ee:ff' },
                lanUsable: true, peerLan: true, lanPlan: '192.168.1.20', sameSubnet: false, dialAttempts: 1, lanResult: '192.168.1.20:5555', lanFail: 'different_network', cause: 'different_network',
                addr: '192.168.1.20',
            },
            error: { code: 'no_proximity', message: 'could not reach 192.168.1.20 (Dawson-PC)' },
        });
        const all = text().join('\n');
        expect(all).not.toMatch(IPV4);
        expect(all).not.toMatch(MAC);
        for (const needle of ['Dawson', 'HomeWifi', 'Intel', 'iPhone', '3f9a12bc', 'ssid', 'addr', 'could not reach', '192.168']) expect(all).not.toContain(needle);
        for (const r of rows) {
            expect(r.name).toMatch(LABEL_RE);
            if (r.detail) expect(r.detail).toMatch(DETAIL_RE);
        }
        // the lan result outside its set became `other`; the rest of the real facts still got through
        expect(all).toContain('near:lan same_subnet=0 dials=1 result=other fail=different_network');
        expect(all).toContain('near:outcome role=sender state=refused cause=different_network code=no_proximity');
    });

    it('a sink that throws never breaks the transfer', () => {
        const trail = createNearTrail({ event: () => { throw new Error('disk full'); } });
        expect(() => { trail.onState({ role: 'own_sender', state: 'refused' }); trail.record('request'); trail.onHelper({ kind: 'ready' }); }).not.toThrow();
    });

    it('unknown steps are ignored', () => {
        const { trail, rows } = rig();
        trail.record('what_is_this', { role: 'sender' });
        trail.record('../etc/passwd');
        expect(rows).toEqual([]);
    });
});
