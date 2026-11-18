import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A moderator's move keeps the moved member's screen share and camera
 * (utils/callMediaCarry.ts; owner report 2026-11-18). The decisions are unit-tested
 * in utils/callMediaCarry.test.ts; Dashboard and SidebarConference have no render
 * harness (they need a live LiveKit room), so these pin the wiring that makes
 * the behaviour real.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const dash = read('Dashboard.tsx');
const conf = read('SidebarConference.tsx');

function between(src: string, start: string, end: string): string {
    const a = src.indexOf(start);
    if (a < 0) throw new Error(`missing: ${start}`);
    const b = src.indexOf(end, a + start.length);
    if (b < 0) throw new Error(`missing after ${start}: ${end}`);
    return src.slice(a, b);
}

describe('Dashboard: the force_move flow snapshots live media before the old pane unmounts', () => {
    const flow = between(dash, 'runForceMove(ev, {', '}, [huddleForceMoveEvent]);');

    it('passes carryMedia, capturing for the destination call', () => {
        expect(flow).toMatch(/carryMedia: e => \{ callMediaCarry\.capture\(e\.call_id, e\.call_name\); \}/);
    });

    it('a carry that expires before the destination connects is not silent', () => {
        const exp = between(dash, 'callMediaCarry.onExpire(c => {', 'return () => callMediaCarry.onExpire(null);');
        expect(exp).toContain("carryStoppedToast('share', 'failed', c.toCallName)");
        expect(exp).toContain("carryStoppedToast('camera', 'failed', c.toCallName)");
    });

    it('a leave (or a failed destination) releases the carry and its capture', () => {
        const leave = between(dash, 'const handleDisconnectCall = async', 'if (wasLastPerson)');
        expect(leave).toContain('callMediaCarry.discard();');
    });
});

describe('SidebarConference: registers what is live, and the destination re-publishes it', () => {
    it('registers a snapshot that clones the live capture, except for generated (native / HDR) tracks', () => {
        const reg = between(conf, 'callMediaCarry.register(() => {', '}));');
        expect(reg).toContain('!nativePipeRef.current && !hdrPipelineRef.current');
        expect(reg).toContain('cropPipelineRef.current.cloneSource()');
        expect(reg).toMatch(/live\.clone\(\)/);
        expect(reg).toContain('camera: lp.isCameraEnabled');
    });

    it('the destination takes the carry once, gates it, and publishes through the normal start with the carried capture', () => {
        const take = between(conf, 'const carry = callMediaCarry.take(sessionId);', '}, [localParticipant, sessionId]);');
        // gated on encryption, the channel bit, a moderator's disable and the SFU grant
        expect(take).toContain('e2eeActive = lp.isE2EEEnabled === true');
        expect(take).toMatch(/channelAllows: canScreenShare, moderatorDisabled: localServerMutedScreenShare/);
        expect(take).toMatch(/channelAllows: canVideo, moderatorDisabled: localServerMutedVideo/);
        expect(take).toContain('canPublishSource(lp, PROTO_SOURCE_SCREEN_SHARE)');
        expect(take).toContain('canPublishSource(lp, PROTO_SOURCE_CAMERA)');
        expect(take).toContain("handleScreenShareSelect(share.options, { fresh: true, carried: share.capture })");
        // a denied share is stopped (never left capturing) and explained
        expect(take).toMatch(/stopCapture\(share\.capture\);\s*toast\.push\(carryStoppedToast\('share', d\.reason, callName\)\)/);
        // a share that did not come back is not silent either
        expect(take).toContain("if (!lp.isScreenShareEnabled) toast.push(carryStoppedToast('share', 'failed', callName));");
    });

    it('startScreenShareFrom publishes a carried capture instead of capturing again, and renews its consent', () => {
        const start = between(conf, 'const carriedCapture =', 'if (!reusedCapture && localParticipant.isScreenShareEnabled');
        expect(start).toContain("reusedHow = 'move_carry'");
        expect(start).toContain('reuseCloneRef.current = carriedCapture'); // a failed start stops it
        expect(start).toContain('await continueShareGrant(options)');
        // the HDR pipeline (its own capture) is not started for a carried capture
        expect(conf).toContain('if (!sliceLayout && !isWindowSource && !carriedCapture) {');
    });

    it('a carried capture that cannot be started is stopped on every early return', () => {
        const sel = between(conf, 'const handleScreenShareSelect = async', 'let outcome: ShareStartOutcome');
        expect(sel.match(/stopCapture\(startOpts\?\.carried\)/g)?.length).toBe(2);
    });
});
