import { describe, it, expect } from 'vitest';
import {
    shouldUseExactConstraint,
    buildSwitchOutcome,
    formatDeviceSwitchLog,
    describeSwitchFailure,
    readCaptureDeviceId,
    isSyntheticDeviceId,
    needsDeviceSwitch,
} from './deviceSwitch';

/**
 * These tests pin the behaviour proved empirically against the Chromium build
 * Electron ships (headless Chromium 153 + two PulseAudio virtual mics,
 * 2026-09-06):
 *
 *   getUserMedia({audio:{deviceId: "<id>"}})          → opened "Default"  ✗
 *   getUserMedia({audio:{deviceId:{ideal:"<id>"}}})   → opened "Default"  ✗
 *   getUserMedia({audio:{deviceId:{exact:"<id>"}}})   → opened "CL_MicA"  ✓
 *   getUserMedia({audio:{deviceId:{exact:"bogus"}}})  → OverconstrainedError
 *
 * i.e. a non-`exact` deviceId is advisory and Chromium ignores it. Since
 * livekit-client builds `exact ? {exact:id} : id`, asking with `exact:false`
 * for a concrete device can never switch. Hence: exact for concrete devices,
 * non-exact for the follow-the-default pseudo-device (where `{exact:'default'}`
 * is the unsatisfiable case that throws AFTER the old track is stopped).
 */

const dev = (deviceId: string, label: string, groupId = `grp-${deviceId}`): MediaDeviceInfo =>
    ({ deviceId, label, groupId, kind: 'audioinput', toJSON: () => ({}) }) as MediaDeviceInfo;

// A realistic Chromium audioinput list: the synthetic 'default' row shares a
// groupId with nothing here (Chromium gives it its own), plus two real mics.
const MIC_A = dev('aaa111', 'CL_MicA');
const MIC_B = dev('bbb222', 'CL_MicB');
const DEFAULT_ROW = dev('default', 'Default', 'grp-default');
const INPUTS = [DEFAULT_ROW, MIC_A, MIC_B];

describe('shouldUseExactConstraint', () => {
    it('uses exact for a concrete device that is present — the whole fix', () => {
        expect(shouldUseExactConstraint('aaa111', INPUTS)).toBe(true);
        expect(shouldUseExactConstraint('bbb222', INPUTS)).toBe(true);
    });

    it("never uses exact for 'default' — {exact:'default'} is the unsatisfiable case that kills the track", () => {
        expect(shouldUseExactConstraint('default', INPUTS)).toBe(false);
    });

    it("treats '' (follow the system default) as non-exact", () => {
        expect(shouldUseExactConstraint('', INPUTS)).toBe(false);
    });

    it('falls back to non-exact for a device that is no longer present', () => {
        // An exact constraint here would throw OverconstrainedError after
        // LiveKit has already stopped the old track — permanently dead mic.
        expect(shouldUseExactConstraint('unplugged-999', INPUTS)).toBe(false);
    });

    it('is non-exact against a pre-permission placeholder list', () => {
        const placeholders = [dev('', '', '')];
        expect(shouldUseExactConstraint('aaa111', placeholders)).toBe(false);
    });
});

describe('buildSwitchOutcome — the verification that was missing', () => {
    it('POSITIVE CONTROL: landing on the requested concrete device is ok', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'aaa111',
            devices: INPUTS, usedExact: true,
        });
        expect(o.ok).toBe(true);
        expect(o.deferred).toBe(false);
        expect(o.activeLabel).toBe('CL_MicA');
    });

    it('THE BUG: requested a concrete device, Chromium opened the default → NOT ok', () => {
        // This is exactly what the old `exact:false` call produced, and exactly
        // what the old code recorded as a success (and announced in a banner).
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'default',
            devices: INPUTS, usedExact: false,
        });
        expect(o.ok).toBe(false);
        expect(o.requestedLabel).toBe('CL_MicA');
        expect(o.activeLabel).toBe('System default');
    });

    it('landing on a different concrete device is not ok', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'bbb222',
            devices: INPUTS, usedExact: true,
        });
        expect(o.ok).toBe(false);
    });

    it("requesting 'default' and getting 'default' back is ok (Chromium's report)", () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: 'default',
            devices: INPUTS, usedExact: false,
        });
        expect(o.ok).toBe(true);
    });

    it("requesting 'default' and getting the concrete device sharing its groupId is ok", () => {
        // Engines that resolve the synthetic row to the real device it points at.
        const paired = [dev('default', 'Default', 'grp-shared'), dev('aaa111', 'CL_MicA', 'grp-shared'), MIC_B];
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: 'aaa111',
            devices: paired, usedExact: false,
        });
        expect(o.ok).toBe(true);
    });

    it("requesting 'default' and getting an UNRELATED device is not ok", () => {
        const paired = [dev('default', 'Default', 'grp-shared'), dev('aaa111', 'CL_MicA', 'grp-shared'), MIC_B];
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: 'bbb222',
            devices: paired, usedExact: false,
        });
        expect(o.ok).toBe(false);
    });

    it("requesting 'default' on a platform with no synthetic default row accepts any live device", () => {
        const noDefaultRow = [MIC_A, MIC_B];
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: 'bbb222',
            devices: noDefaultRow, usedExact: false,
        });
        expect(o.ok).toBe(true);
    });

    it('a muted track is deferred, not failed — LiveKit restarts it on unmute', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'bbb222',
            devices: INPUTS, usedExact: true, muted: true,
        });
        expect(o.ok).toBe(true);
        expect(o.deferred).toBe(true);
        expect(o.deferredReason).toMatch(/unmute/);
    });

    it('camera off (no publication) is deferred, not failed', () => {
        const o = buildSwitchOutcome({
            kind: 'camera', requestedId: 'aaa111', activeId: null,
            devices: INPUTS, usedExact: true, noPublication: true,
        });
        expect(o.ok).toBe(true);
        expect(o.deferred).toBe(true);
        expect(o.deferredReason).toMatch(/turn it on/);
    });

    it('no live track and not deferred is a failure, not a silent pass', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: null,
            devices: INPUTS, usedExact: true,
        });
        expect(o.ok).toBe(false);
    });

    it('an error always wins over any inferred success', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'aaa111',
            devices: INPUTS, usedExact: true, error: 'OverconstrainedError',
        });
        expect(o.ok).toBe(false);
        expect(o.deferred).toBe(false);
    });

    it('labels an unknown active id rather than rendering it blank', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'ghost-abcdef123',
            devices: INPUTS, usedExact: true,
        });
        expect(o.ok).toBe(false);
        expect(o.activeLabel).toBe('Device ghost-ab');
    });
});

describe('formatDeviceSwitchLog', () => {
    it('reports the ACTUAL device, the ok flag and the exact flag', () => {
        const line = formatDeviceSwitchLog(buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'default',
            devices: INPUTS, usedExact: false,
        }));
        expect(line).toContain('[devices] mic switch');
        expect(line).toContain('requested=CL_MicA');
        expect(line).toContain('active=System default');
        expect(line).toContain('ok=false');
        expect(line).toContain('exact=false');
    });

    it('POSITIVE CONTROL: a successful switch reads ok=true exact=true', () => {
        const line = formatDeviceSwitchLog(buildSwitchOutcome({
            kind: 'camera', requestedId: 'bbb222', activeId: 'bbb222',
            devices: INPUTS, usedExact: true,
        }));
        expect(line).toContain('[devices] camera switch');
        expect(line).toContain('ok=true');
        expect(line).toContain('exact=true');
        expect(line).not.toContain('deferred=');
    });

    it('names the deferral reason so a "nothing happened" report is explainable', () => {
        const line = formatDeviceSwitchLog(buildSwitchOutcome({
            kind: 'camera', requestedId: 'aaa111', activeId: null,
            devices: INPUTS, usedExact: true, noPublication: true,
        }));
        expect(line).toContain('deferred=camera is off');
    });
});

describe('describeSwitchFailure', () => {
    it('names both the target and what is still live', () => {
        const msg = describeSwitchFailure(buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'bbb222',
            devices: INPUTS, usedExact: true,
        }));
        expect(msg).toContain('CL_MicA');
        expect(msg).toContain('CL_MicB');
    });

    it('surfaces the underlying error when there was one', () => {
        const msg = describeSwitchFailure(buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: null,
            devices: INPUTS, usedExact: true, error: 'OverconstrainedError',
        }));
        expect(msg).toContain('OverconstrainedError');
    });
});

/**
 * ── The "still using Device WebAudio" regression ────────────────────────────
 *
 * Reported from live DM/group-DM calls: an intermittent
 * "Couldn't switch to System default — still using Device WebAudio".
 *
 * `Device WebAudio` is `labelFor`'s unknown-device fallback,
 * `Device ${id.slice(0, 8)}`, applied to an id beginning "WebAudio" — Blink's
 * name for the track a `MediaStreamAudioDestinationNode` produces. Cipherline's
 * mic is exactly that: `voiceProcessor.ts` publishes
 * `destination.stream.getAudioTracks()[0]` from the rnnoise graph.
 *
 * It reached the verification because livekit-client's
 * `LocalTrack.mediaStreamTrack` getter returns
 * `processor?.processedTrack ?? _mediaStreamTrack`, so reading `getSettings()`
 * off it reports the PROCESSOR'S OUTPUT, never the microphone. Intermittent
 * because the processor is attached asynchronously by CallPane's
 * MicProcessorBridge: whether the initial mic sync read the raw track or the
 * processed one was a race.
 */
describe('readCaptureDeviceId — reads past an attached processor', () => {
    const settings = (deviceId?: string): MediaTrackSettings =>
        (deviceId === undefined ? {} : { deviceId }) as MediaTrackSettings;

    /** A LiveKit LocalTrack with the rnnoise processor attached: the public
     *  `mediaStreamTrack` getter yields the WebAudio output track. */
    const processedMic = {
        getSourceTrackSettings: () => settings('aaa111'),
        mediaStreamTrack: { getSettings: () => settings('WebAudio-3f2b1c0d-dead-beef') },
    };

    it('returns the CAPTURE device, not the WebAudio processor output', () => {
        expect(readCaptureDeviceId(processedMic)).toBe('aaa111');
    });

    it('never reports a synthesized WebAudio id as the active device', () => {
        // The exact shape that produced the bug: no source accessor available,
        // so the only readable id is the processor's. "Cannot tell" beats
        // "definitely still on the previous device".
        expect(readCaptureDeviceId({
            mediaStreamTrack: { getSettings: () => settings('WebAudio-3f2b1c0d') },
        })).toBeNull();
    });

    it('falls back to the post-processor track when it IS a real device', () => {
        // No processor attached: the getter returns the raw capture track.
        expect(readCaptureDeviceId({
            mediaStreamTrack: { getSettings: () => settings('bbb222') },
        })).toBe('bbb222');
    });

    it("ignores a camera processor's canvas track, which carries no deviceId", () => {
        expect(readCaptureDeviceId({
            getSourceTrackSettings: () => settings('cam-1'),
            mediaStreamTrack: { getSettings: () => settings(undefined) },
        })).toBe('cam-1');
        expect(readCaptureDeviceId({
            mediaStreamTrack: { getSettings: () => settings(undefined) },
        })).toBeNull();
    });

    it('survives an SDK that throws from either accessor', () => {
        expect(readCaptureDeviceId({
            getSourceTrackSettings: () => { throw new Error('gone'); },
            mediaStreamTrack: { getSettings: () => settings('bbb222') },
        })).toBe('bbb222');
        expect(readCaptureDeviceId({
            getSourceTrackSettings: () => { throw new Error('gone'); },
            mediaStreamTrack: { getSettings: (): MediaTrackSettings => { throw new Error('gone'); } },
        })).toBeNull();
    });

    it('returns null for no track at all', () => {
        expect(readCaptureDeviceId(null)).toBeNull();
        expect(readCaptureDeviceId(undefined)).toBeNull();
    });

    it('isSyntheticDeviceId does not misclassify real ids', () => {
        expect(isSyntheticDeviceId('WebAudio-abc')).toBe(true);
        expect(isSyntheticDeviceId('aaa111')).toBe(false);
        expect(isSyntheticDeviceId('')).toBe(false);
        expect(isSyntheticDeviceId(null)).toBe(false);
    });
});

describe('buildSwitchOutcome — unverifiable is not a failure', () => {
    it('does NOT accuse the user of being on the wrong device when it cannot tell', () => {
        // Reached only if a future SDK drops getSourceTrackSettings and the
        // published track is the processor's. Previously this rendered as
        // "Couldn't switch to System default — still using Device WebAudio".
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: null,
            devices: INPUTS, usedExact: false, unverifiable: true,
        });
        expect(o.ok).toBe(true);
        expect(o.unverifiable).toBe(true);
        expect(o.deferred).toBe(false);
    });

    it('an explicit error still wins over unverifiable', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: null,
            devices: INPUTS, usedExact: false, unverifiable: true, error: 'NotReadableError',
        });
        expect(o.ok).toBe(false);
    });

    it('a verified landing is still reported as such', () => {
        const o = buildSwitchOutcome({
            kind: 'mic', requestedId: 'aaa111', activeId: 'aaa111',
            devices: INPUTS, usedExact: true,
        });
        expect(o.ok).toBe(true);
        expect(o.unverifiable).toBe(false);
    });
});

/**
 * The second half of the same report: "I OFTEN start out muted".
 *
 * `appliedMicDeviceRef` starts null on every join, so the old
 * `appliedId !== desiredId` test fired a switchActiveDevice on EVERY call —
 * even though CallPane has already opened that exact device via
 * `audioCaptureDefaults.deviceId`. `LocalTrack.restart()` stops the live
 * MediaStreamTrack before re-acquiring it, with no rollback, and that restart
 * raced MicProcessorBridge's asynchronous setProcessor attach.
 */
describe('needsDeviceSwitch — no redundant restart at join', () => {
    const base = {
        force: false, defaultMoved: false, trackAlive: true,
        devices: INPUTS,
    };

    it('does NOT switch when the track is already on the requested device', () => {
        expect(needsDeviceSwitch({
            ...base, appliedId: null, desiredId: 'aaa111', activeId: 'aaa111',
        })).toBe(false);
    });

    it("does NOT switch at join when following 'default' and already on it", () => {
        expect(needsDeviceSwitch({
            ...base, appliedId: null, desiredId: 'default', activeId: 'default',
        })).toBe(false);
    });

    it('DOES switch when the live device is genuinely the wrong one', () => {
        expect(needsDeviceSwitch({
            ...base, appliedId: null, desiredId: 'aaa111', activeId: 'bbb222',
        })).toBe(true);
    });

    it('DOES switch when the capture device cannot be read at all', () => {
        // Unknown is not "already correct" — verify by acting.
        expect(needsDeviceSwitch({
            ...base, appliedId: null, desiredId: 'aaa111', activeId: null,
        })).toBe(true);
    });

    it('still honours force, defaultMoved and a dead track', () => {
        const already = { ...base, appliedId: 'aaa111', desiredId: 'aaa111', activeId: 'aaa111' };
        expect(needsDeviceSwitch({ ...already, force: true })).toBe(true);
        expect(needsDeviceSwitch({ ...already, defaultMoved: true })).toBe(true);
        expect(needsDeviceSwitch({ ...already, trackAlive: false })).toBe(true);
    });

    it('short-circuits on the cheap applied===desired test without touching activeId', () => {
        expect(needsDeviceSwitch({
            ...base, appliedId: 'aaa111', desiredId: 'aaa111', activeId: null,
        })).toBe(false);
    });
});
