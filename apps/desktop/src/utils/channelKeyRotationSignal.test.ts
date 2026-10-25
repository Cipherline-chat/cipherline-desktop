import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    coalesceRotationEvents,
    computeRotationEpoch,
    mergeEpochAtSignal,
    parseEpochAtSignal,
    rotationAlreadyDone,
} from './channelKeyDistribution';

/**
 * 2026-10-20 (owner: a member who joined right after someone left waited a
 * long time for keys). One member_left minted up to THREE epochs per channel
 * within 3 s: every remaining holder gets the rotation signal, waits a
 * 0.5-3.5 s jitter, reads the server's latest and mints latest+1 — so each
 * holder whose jitter fired after another's registration minted on top of it.
 * The joiner, arriving in the middle, asked for an epoch that kept moving and
 * that only its minter held yet.
 *
 * The API now sends `epoch_at_signal` (the latest epoch at the access change);
 * a holder that finds the server already past it stands down.
 */

describe('rotationAlreadyDone', () => {
    it('server already past the epoch at the signal → another holder rotated: stand down', () => {
        expect(rotationAlreadyDone(22, 21)).toBe(true);
        expect(rotationAlreadyDone(24, 21)).toBe(true);
    });

    it('server still at the epoch at the signal → nobody rotated yet: rotate', () => {
        expect(rotationAlreadyDone(21, 21)).toBe(false);
    });

    it('unknown epoch at signal (older API) → rotate, as before', () => {
        expect(rotationAlreadyDone(30, undefined)).toBe(false);
    });

    it('a server that reports an older latest than the signal (lagging replica) → rotate', () => {
        expect(rotationAlreadyDone(20, 21)).toBe(false);
    });
});

describe('member_left herd: three holders racing one signal', () => {
    /** Each holder: after its jitter, read the latest, maybe mint latest+1. */
    function race(standDown: boolean): number[] {
        let serverLatest = 21;
        const epochAtSignal = 21;
        const minted: number[] = [];
        for (let holder = 0; holder < 3; holder++) {
            if (standDown && rotationAlreadyDone(serverLatest, epochAtSignal)) continue;
            const target = computeRotationEpoch(serverLatest, 21)!;
            minted.push(target);
            serverLatest = target; // registered before the next holder's jitter fires
        }
        return minted;
    }

    it('CONTROL — without the stand-down every holder mints on top (the 2026-10-20 22/23/24)', () => {
        expect(race(false)).toEqual([22, 23, 24]);
    });

    it('with it, exactly one rotation answers the signal', () => {
        expect(race(true)).toEqual([22]);
    });
});

describe('two signals for one channel', () => {
    it('the higher epoch wins (the rotation must come after the LATER change)', () => {
        expect(mergeEpochAtSignal(21, 22)).toBe(22);
        expect(mergeEpochAtSignal(22, 21)).toBe(22);
    });

    it('one without the field makes it unknown → rotate unconditionally', () => {
        expect(mergeEpochAtSignal(21, undefined)).toBeUndefined();
        expect(mergeEpochAtSignal(undefined, 21)).toBeUndefined();
    });

    it('coalesceRotationEvents keeps last-wins on the reason but merges the epoch', () => {
        const out = coalesceRotationEvents([
            { server_id: 's', channel_id: 'c', reason: 'permission_change', epoch_at_signal: 21 },
            { server_id: 's', channel_id: 'c', reason: 'member_removed', epoch_at_signal: 22 },
            { server_id: 's', channel_id: 'd', reason: 'member_removed', epoch_at_signal: 5 },
        ]);
        expect(out).toEqual([
            { server_id: 's', channel_id: 'c', reason: 'member_removed', epoch_at_signal: 22 },
            { server_id: 's', channel_id: 'd', reason: 'member_removed', epoch_at_signal: 5 },
        ]);
        const unknown = coalesceRotationEvents([
            { server_id: 's', channel_id: 'c', reason: 'member_removed', epoch_at_signal: 21 },
            { server_id: 's', channel_id: 'c', reason: 'member_removed' },
        ]);
        expect(unknown[0].epoch_at_signal).toBeUndefined();
    });
});

describe('parseEpochAtSignal', () => {
    it('accepts non-negative safe integers only', () => {
        expect(parseEpochAtSignal(21)).toBe(21);
        expect(parseEpochAtSignal(0)).toBe(0);
        for (const bad of [undefined, null, '21', 1.5, -1, Number.NaN, Infinity, 2 ** 60]) {
            expect(parseEpochAtSignal(bad)).toBeUndefined();
        }
    });
});

describe('wiring', () => {
    const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
    const realtime = readFileSync(join(__dirname, '../hooks/useRealtime.ts'), 'utf8');

    it('the rotation checks rotationAlreadyDone against the fresh server latest BEFORE minting', () => {
        const fn = dash.slice(dash.indexOf('const rotateCallsChannelKey = useCallback('));
        const check = fn.indexOf('rotationAlreadyDone(serverLatest, epochAtSignal)');
        const mint = fn.indexOf('rotateChannelKey(channelId, target)');
        expect(check).toBeGreaterThan(0);
        expect(mint).toBeGreaterThan(check);
    });

    it('the signal epoch is recorded from each drained event and taken by the run', () => {
        expect(dash).toMatch(/mergeEpochAtSignal\(pending\.get\(evt\.channel_id\), evt\.epoch_at_signal\)/);
        expect(dash).toContain('rotationSignalEpochRef.current.delete(channelId)');
    });

    it('standing down is verified: if the other holder\'s epoch never reaches us, we rotate after all (no stranding on the old key)', () => {
        const fn = dash.slice(dash.indexOf('const rotateCallsChannelKey = useCallback('));
        const branch = fn.slice(fn.indexOf('if (rotationAlreadyDone(serverLatest, epochAtSignal)) {'));
        const body = branch.slice(0, branch.indexOf('const target = computeRotationEpoch('));
        expect(body).toContain('}, ROTATION_STAND_DOWN_VERIFY_MS);');
        expect(body).toContain('if (held != null && held >= serverLatest) return;');
        expect(body).toContain('rotationOpsRef.current.schedule(serverId, channelId, reason);');
        // …answering "as of" the epoch it waited for, so the others stand down again.
        expect(body).toMatch(/mergeEpochAtSignal\(pending\.get\(channelId\), serverLatest\) : serverLatest/);
    });

    it('a holder that loses the rotation race asks for the WINNER\'S epoch only, not every epoch', () => {
        const fn = dash.slice(dash.indexOf('const rotateCallsChannelKey = useCallback('));
        const lost = fn.slice(fn.indexOf('Lost rotation race for'));
        expect(lost.slice(0, 400)).toContain('await fileKeyRequest(serverId, channelId, [epoch]);');
        const fb = dash.slice(dash.indexOf('Fallback rotation lost arbitration'));
        expect(fb.slice(0, 300)).toContain('await fileKeyRequest(serverId, channelId, [epoch]);');
    });

    it('useRealtime carries epoch_at_signal through from the WS payload', () => {
        expect(realtime).toContain('parseEpochAtSignal(msg.data.epoch_at_signal)');
    });
});
