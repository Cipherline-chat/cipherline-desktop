import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Call report 89d66aee (2026-11-20): the API now makes the REST leave routes
 * DEVICE-scoped. A leave is trusted at once only from the device that joined
 * (matched by `x-device-id`); a leave naming another device, or none, while
 * LiveKit still lists the account is re-checked ~5 s later instead (so a late
 * leave from the user's other device cannot remove the one still in the call).
 *
 * So every leave this client sends must carry its own `x-device-id`, or its own
 * deliberate leave waits for the re-check. Dashboard has no render harness, so
 * this is pinned at source level, with a negative control.
 */
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const dash = read('components', 'Dashboard.tsx');
const servers = read('hooks', 'useServers.ts');

/** Every `axios.post(...<path>...)` call expression (up to its closing paren of the options object). */
function postsTo(src: string, pathFragment: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(pathFragment, from);
        if (at < 0) break;
        const start = src.lastIndexOf('axios.post(', at);
        // The call ends at its `.catch(` / `), {` (retry options) / `);`,
        // whichever comes first - never reaching into the next request.
        const ends = ['.catch(', '), {', ');'].map(t => src.indexOf(t, at)).filter(i => i >= 0);
        out.push(src.slice(start, Math.min(...ends)));
        from = at + pathFragment.length;
    }
    return out;
}

describe('device-scoped leave: every leave names this device', () => {
    it('every POST channels/:cid/leave_voice sends x-device-id', () => {
        const calls = postsTo(dash, '/leave_voice`');
        expect(calls.length).toBeGreaterThanOrEqual(5);
        for (const c of calls) expect(c).toMatch(/'x-device-id'/);
    });

    it('join_voice sends x-device-id (the server records the joining device)', () => {
        const calls = postsTo(dash, '/join_voice`');
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const c of calls) expect(c).toMatch(/'x-device-id'/);
    });

    it('the Calls-channel leave uses the same device headers as join', () => {
        const calls = postsTo(servers, '/leave`');
        expect(calls.length).toBe(1);
        expect(calls[0]).toMatch(/huddleJoinHeaders\(token, deviceId\)/);
    });

    it('negative control: a leave without the header is caught', () => {
        const bad = "axios.post(apiUrl`/channels/${x}/leave_voice`, {}, { headers: { Authorization: `Bearer ${token}` } })";
        const calls = postsTo(bad, '/leave_voice`');
        expect(calls).toHaveLength(1);
        expect(calls[0]).not.toMatch(/'x-device-id'/);
    });
});
