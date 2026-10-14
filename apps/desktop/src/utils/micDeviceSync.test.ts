import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CAPTURE_ENFORCE_COOLDOWN_MS,
    captureFlagMismatches,
    createDebouncer,
    createMicDeviceSync,
    decideMicReacquire,
    defaultDeviceSignature,
    readCaptureTrack,
    setRoomEchoCancellation,
    MIC_DEVICE_DEBOUNCE_MS,
    type MicReacquireInput,
    type MicTrackLike,
} from './micDeviceSync';
import { buildSwitchOutcome } from './deviceSwitch';
import { micCaptureConstraints } from './audioInput';
import { clearCallEvents, getCallEvents, validateCallEvent } from './callEventLog';

// ── Fixtures ────────────────────────────────────────────────────────────────

const row = (deviceId: string, label: string, groupId: string): MediaDeviceInfo =>
    ({ deviceId, label, groupId, kind: 'audioinput', toJSON: () => ({}) }) as MediaDeviceInfo;

const base = (over: Partial<MicReacquireInput> = {}): MicReacquireInput => ({
    force: null,
    setting: '',
    desiredId: 'default',
    hasTrack: true,
    capture: { readyState: 'live', muted: false, groupId: 'g-a' },
    appliedId: 'default',
    appliedDefaultSig: 'g-a|Default - Headset',
    currentDefaultSig: 'g-a|Default - Headset',
    defaultGroupId: 'g-a',
    groupCheckTrusted: true,
    activeId: 'default',
    onRequested: true,
    ...over,
});

// ── Pure decision ───────────────────────────────────────────────────────────

describe('decideMicReacquire', () => {
    it('nothing changed → no re-acquire', () => {
        expect(decideMicReacquire(base())).toEqual({ reacquire: false, reason: null });
    });

    it('following the default and the OS default moved → default_changed (the reported bug)', () => {
        expect(decideMicReacquire(base({ currentDefaultSig: 'g-b|Default - USB Mic', defaultGroupId: 'g-b' })))
            .toEqual({ reacquire: true, reason: 'default_changed' });
    });

    it('two identical headsets: same label, different groupId still counts as a move', () => {
        const a = defaultDeviceSignature([row('default', 'Default - Microphone (USB Audio Device)', 'g-1')]);
        const b = defaultDeviceSignature([row('default', 'Default - Microphone (USB Audio Device)', 'g-2')]);
        expect(a).not.toBe(b);
        expect(decideMicReacquire(base({ appliedDefaultSig: a, currentDefaultSig: b, defaultGroupId: 'g-2', capture: { readyState: 'live', muted: false, groupId: 'g-1' } })).reason)
            .toBe('default_changed');
    });

    it('backstop: no baseline signature, but the capture sits on a different group than the default row', () => {
        expect(decideMicReacquire(base({ appliedDefaultSig: null, defaultGroupId: 'g-b' })))
            .toEqual({ reacquire: true, reason: 'default_mismatch' });
    });

    it('the groupId backstop is ignored once proven not comparable on this platform', () => {
        expect(decideMicReacquire(base({ appliedDefaultSig: null, defaultGroupId: 'g-b', groupCheckTrusted: false })).reacquire)
            .toBe(false);
    });

    it('an explicitly-picked device does NOT follow OS default changes', () => {
        expect(decideMicReacquire(base({
            setting: 'mic-x', desiredId: 'mic-x', appliedId: 'mic-x', activeId: 'mic-x',
            currentDefaultSig: 'g-b|Default - USB Mic', defaultGroupId: 'g-b',
        })).reacquire).toBe(false);
    });

    it('explicit device gone (pickMicDeviceId resolved to default) → device_lost, once', () => {
        expect(decideMicReacquire(base({ setting: 'mic-x', desiredId: 'default', appliedId: 'mic-x' })).reason)
            .toBe('device_lost');
        // Already moved to the default → nothing more to do.
        expect(decideMicReacquire(base({ setting: 'mic-x', desiredId: 'default', appliedId: 'default' })).reacquire)
            .toBe(false);
    });

    it('a dead or OS-muted capture is re-acquired whatever the target', () => {
        expect(decideMicReacquire(base({ capture: { readyState: 'ended', muted: false, groupId: null } })).reason).toBe('track_ended');
        expect(decideMicReacquire(base({ capture: { readyState: 'live', muted: true, groupId: 'g-a' } })).reason).toBe('track_muted');
        expect(decideMicReacquire(base({
            setting: 'mic-x', desiredId: 'mic-x', appliedId: 'mic-x', activeId: 'mic-x',
            capture: { readyState: 'ended', muted: false, groupId: null },
        })).reason).toBe('track_ended');
    });

    it('a forced pass always re-acquires, with the caller\'s reason', () => {
        expect(decideMicReacquire(base({ force: 'setting_changed' }))).toEqual({ reacquire: true, reason: 'setting_changed' });
        expect(decideMicReacquire(base({ force: 'silence' })).reason).toBe('silence');
    });

    it('no published track: a moved default needs no restart (the next capture opens the new default)', () => {
        expect(decideMicReacquire(base({ hasTrack: false, capture: null, currentDefaultSig: 'g-b|x', defaultGroupId: 'g-b' })).reacquire)
            .toBe(false);
    });

    it('no bookkeeping yet: verifies against the live device instead of restarting blindly', () => {
        expect(decideMicReacquire(base({ appliedId: null, onRequested: true })).reacquire).toBe(false);
        expect(decideMicReacquire(base({ appliedId: null, onRequested: false })).reason).toBe('device_mismatch');
    });
});

describe('defaultDeviceSignature', () => {
    it('is null without a default row, and with only pre-permission blanks', () => {
        expect(defaultDeviceSignature([row('abc', 'Mic', 'g')])).toBeNull();
        expect(defaultDeviceSignature([row('default', '', '')])).toBeNull();
    });
});

describe('readCaptureTrack', () => {
    const raw = { readyState: 'live', muted: false, getSettings: () => ({ deviceId: 'default' }) };
    const processed = { readyState: 'live', muted: false, getSettings: () => ({ deviceId: 'WebAudio-1' }) };

    it('prefers the raw capture field over the processor-output getter', () => {
        const t = { isMuted: false, restartTrack: async () => {}, _mediaStreamTrack: raw, mediaStreamTrack: processed, getProcessor: () => ({}) };
        expect(readCaptureTrack(t as unknown as MicTrackLike)).toBe(raw);
    });

    it('never returns the processed track when a processor is attached', () => {
        const t = { isMuted: false, restartTrack: async () => {}, mediaStreamTrack: processed, getProcessor: () => ({}) };
        expect(readCaptureTrack(t as unknown as MicTrackLike)).toBeNull();
    });

    it('livekit-client still keeps the capture track in `_mediaStreamTrack` and still short-circuits setDeviceId (tripwire for SDK bumps)', () => {
        const req = createRequire(import.meta.url);
        const esm = readFileSync(join(dirname(req.resolve('livekit-client')), 'livekit-client.esm.mjs'), 'utf8');
        expect(esm).toMatch(/getSourceTrackSettings\(\)\s*\{\s*return this\._mediaStreamTrack\.getSettings\(\)/);
        // The no-op this module works around. If a bump removes it, the
        // explicit restartTrack in micDeviceSync becomes merely redundant.
        expect(esm).toMatch(/this\._constraints\.deviceId === deviceId && this\._mediaStreamTrack\.getSettings\(\)\.deviceId === unwrapConstraint\(deviceId\)/);
    });
});

describe('createDebouncer', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('collapses a SoundSwitch-style burst into one call, after the quiet period', () => {
        const fn = vi.fn();
        const d = createDebouncer(fn, 300);
        for (let i = 0; i < 5; i++) { d.trigger(); vi.advanceTimersByTime(60); }
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('cancel drops a pending call', () => {
        const fn = vi.fn();
        const d = createDebouncer(fn, 300);
        d.trigger(); d.cancel();
        vi.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
    });
});

// ── Wiring, against a fake that reproduces livekit-client 2.18.8 ────────────
//
// FakeOs is the machine: physical mics and which one is the OS default.
// FakeLocalAudioTrack copies the relevant livekit-client code paths verbatim
// in behaviour: setDeviceId's short-circuit (LocalTrack.ts:244-264), restart's
// stop → getUserMedia → setMediaStreamTrack (LocalTrack.ts:344-402), and
// setMediaStreamTrack's `sender.replaceTrack(...)` + `enabled = !isMuted`
// (LocalTrack.ts:150-215). `sender.track` is what the SFU actually receives.

interface Mic { id: string; name: string; group: string; present: boolean }

class FakeMst {
    readyState: 'live' | 'ended' = 'live';
    muted = false;
    enabled = true;
    private listeners: Record<string, Array<() => void>> = {};
    constraints: MediaTrackConstraints = {};
    readonly opened: string;
    readonly boundTo: Mic;
    constructor(opened: string, boundTo: Mic) { this.opened = opened; this.boundTo = boundTo; }
    /** Chromium fixes the processing flags when the capture is OPENED, and an
     *  absent constraint means ON (measured on Chromium 153: a bare
     *  {deviceId:'default'} reports echoCancellation/noiseSuppression/
     *  autoGainControl all true). */
    private flags = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    /** Called once by FakeOs.getUserMedia, right after the open constraints are set. */
    latchFlags() {
        this.flags = {
            echoCancellation: this.constraints.echoCancellation !== false,
            noiseSuppression: this.constraints.noiseSuppression !== false,
            autoGainControl: this.constraints.autoGainControl !== false,
        };
    }
    getSettings(): MediaTrackSettings {
        return { deviceId: this.opened, groupId: this.boundTo.group, ...this.flags };
    }
    getConstraints() { return { ...this.constraints }; }
    /** Chromium records the constraint and changes NOTHING about the capture
     *  (settings and audio stay as opened) — see micDeviceSync.captureFlagMismatches. */
    applyConstraints = vi.fn(async (c: MediaTrackConstraints) => { this.constraints = { ...this.constraints, ...c }; });
    stop() { this.readyState = 'ended'; }
    addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn); }
    removeEventListener(t: string, fn: () => void) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
    fire(t: string) { (this.listeners[t] ?? []).forEach(f => f()); }
}

class FakeOs {
    mics: Mic[] = [
        { id: 'id-headset', name: 'Headset', group: 'g-headset', present: true },
        { id: 'id-usb', name: 'USB Mic', group: 'g-usb', present: true },
    ];
    defaultId = 'id-headset';
    gumCalls: unknown[] = [];
    failNextGum = 0;
    /** A platform that ignores the processing constraints (flags stay at Chromium's ON defaults). */
    ignoreFlags = false;
    get defaultMic() { return this.mics.find(m => m.id === this.defaultId)!; }
    enumerate = async (): Promise<MediaDeviceInfo[]> => {
        const live = this.mics.filter(m => m.present);
        return [
            row('default', `Default - ${this.defaultMic.name}`, this.defaultMic.group),
            ...live.map(m => row(m.id, m.name, m.group)),
        ];
    };
    getUserMedia(deviceId: unknown, constraints: MediaTrackConstraints = {}): FakeMst {
        const t = this.open(deviceId);
        t.constraints = { ...constraints, deviceId: deviceId as ConstrainDOMString };
        if (!this.ignoreFlags) t.latchFlags();
        return t;
    }
    private open(deviceId: unknown): FakeMst {
        this.gumCalls.push(deviceId);
        if (this.failNextGum > 0) { this.failNextGum--; throw new Error('NotReadableError'); }
        const unwrap = typeof deviceId === 'object' && deviceId !== null
            ? ((deviceId as { exact?: string; ideal?: string }).exact ?? (deviceId as { ideal?: string }).ideal)
            : deviceId as string | undefined;
        const exact = typeof deviceId === 'object' && deviceId !== null && 'exact' in deviceId;
        if (!unwrap || unwrap === 'default') return new FakeMst('default', this.defaultMic);
        const m = this.mics.find(x => x.id === unwrap && x.present);
        if (!m) {
            if (exact) throw new Error('OverconstrainedError');
            return new FakeMst('default', this.defaultMic);
        }
        return new FakeMst(m.id, m);
    }
}

const unwrapConstraint = (c: unknown) =>
    typeof c === 'string' ? c : (c as { exact?: string; ideal?: string }).exact ?? (c as { ideal?: string }).ideal;

class FakeLocalAudioTrack {
    _constraints: MediaTrackConstraints;
    _mediaStreamTrack: FakeMst;
    isMuted = false;
    pendingDeviceChange = false;
    sender: { track: FakeMst | null };
    restarts = 0;
    private os: FakeOs;
    /** livekit-client's `get constraints()` returns the live object. */
    get constraints() { return this._constraints; }
    constructor(os: FakeOs, deviceId: string, echoCancellation = true) {
        this.os = os;
        // createLocalTracks turns a string deviceId into {exact: id} (create.ts),
        // and LiveKit's audioDefaults add voiceIsolation.
        this._constraints = { ...micCaptureConstraints(echoCancellation), voiceIsolation: true, deviceId: { exact: deviceId } } as MediaTrackConstraints;
        this._mediaStreamTrack = os.getUserMedia(this._constraints.deviceId, this._constraints);
        this.sender = { track: this._mediaStreamTrack };
    }
    get mediaStreamTrack() { return this._mediaStreamTrack; }
    getSourceTrackSettings() { return this._mediaStreamTrack.getSettings(); }
    getProcessor() { return undefined; }
    async setDeviceId(deviceId: ConstrainDOMString): Promise<boolean> {
        if (this._constraints.deviceId === deviceId &&
            this._mediaStreamTrack.getSettings().deviceId === unwrapConstraint(deviceId)) {
            return true;
        }
        this._constraints.deviceId = deviceId;
        if (this.isMuted) { this.pendingDeviceChange = true; return true; }
        await this.restartTrack();
        return unwrapConstraint(deviceId) === this._mediaStreamTrack.getSettings().deviceId;
    }
    async restartTrack(options?: MediaTrackConstraints) {
        const constraints = options ?? this._constraints;
        this._mediaStreamTrack.stop();
        const next = this.os.getUserMedia(constraints.deviceId, constraints);
        this.sender.track = next;          // sender.replaceTrack(processedTrack ?? newTrack)
        next.enabled = !this.isMuted;      // mute preserved across the swap
        this._mediaStreamTrack = next;
        this._constraints = constraints;
        this.pendingDeviceChange = false;
        this.restarts++;
    }
}

class FakeRoom {
    track: FakeLocalAudioTrack | null;
    constructor(track: FakeLocalAudioTrack | null) { this.track = track; }
    switchCalls: Array<[string, boolean]> = [];
    async switchActiveDevice(id: string, exact: boolean) {
        this.switchCalls.push([id, exact]);
        const constraint = exact ? { exact: id } : id;
        if (!this.track) return true;
        return this.track.setDeviceId(constraint);
    }
}

/** Injected clock for the enforcement cooldown. */
const clock = { t: 0 };

function setup(opts: { setting?: string; initialDevice?: string; muted?: boolean; hint?: { label?: string; groupId?: string }; echoCancellation?: boolean } = {}) {
    const os = new FakeOs();
    const setting = { value: opts.setting ?? '' };
    // The live echo-cancellation setting: the follower reads it lazily, as the
    // real wiring does (SidebarConference's echoCancellationRef).
    const echo = { value: opts.echoCancellation ?? true };
    const track = new FakeLocalAudioTrack(os, opts.initialDevice ?? (setting.value || 'default'), echo.value);
    track.isMuted = !!opts.muted;
    track._mediaStreamTrack.enabled = !opts.muted;
    const room = new FakeRoom(track);
    const fellBack = vi.fn();
    const unrecoverable = vi.fn();
    const outcomes: Array<{ ok: boolean; reason: string }> = [];
    const sync = createMicDeviceSync({
        enumerateDevices: os.enumerate,
        getMicTrack: () => room.track as unknown as MicTrackLike,
        switchActiveDevice: (id, exact) => room.switchActiveDevice(id, exact),
        getSetting: () => setting.value,
        getSettingHint: () => opts.hint ?? null,
        captureConstraints: () => micCaptureConstraints(echo.value),
        onOutcome: (o, reason) => outcomes.push({ ok: o.ok, reason }),
        onFellBackToDefault: fellBack,
        onUnrecoverable: unrecoverable,
        now: () => clock.t,
    });
    return { os, setting, echo, track, room, sync, fellBack, unrecoverable, outcomes };
}

/** Let the debounce fire and the async sync settle. */
async function settle() {
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_DEBOUNCE_MS + 50);
    await vi.advanceTimersByTimeAsync(10);
}

describe('createMicDeviceSync — wiring against livekit-client semantics', () => {
    beforeEach(() => { vi.useFakeTimers(); clearCallEvents(); });
    afterEach(() => { vi.useRealTimers(); });

    it('NEGATIVE CONTROL: the pre-fix call, switchActiveDevice("default", exact:false), follows the FIRST default change, then silently stops', async () => {
        const { os, track, room } = setup();
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
        // Change #1 works: the stored constraint is {exact:'default'}, not === 'default'.
        os.defaultId = 'id-usb';
        await room.switchActiveDevice('default', false);
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
        // Change #2: now 'default' === 'default' → setDeviceId short-circuits.
        os.defaultId = 'id-headset';
        const libSaysOk = await room.switchActiveDevice('default', false);
        expect(libSaysOk).toBe(true);
        expect(track.restarts).toBe(1);
        expect(track.sender.track!.boundTo.id).toBe('id-usb');       // others still get the old mic
        // …and the old verification step was satisfied by it:
        const outcome = buildSwitchOutcome({
            kind: 'mic', requestedId: 'default', activeId: track.getSourceTrackSettings().deviceId ?? null,
            devices: await os.enumerate(), usedExact: false,
        });
        expect(outcome.ok).toBe(true);
    });

    it('THE FIX survives repeated default changes (the second and later ones are what used to die)', async () => {
        const { os, track, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        for (const target of ['id-usb', 'id-headset', 'id-usb', 'id-headset']) {
            os.defaultId = target;
            sync.schedule();
            await settle();
            expect(track.sender.track!.boundTo.id).toBe(target);
            expect(track.sender.track!.readyState).toBe('live');
        }
        expect(track.restarts).toBe(4);
        // Capture settings re-asserted every time — including over LiveKit's own
        // `voiceIsolation: true` default, which micCaptureConstraints turns off
        // (no platform noise suppression behind the user's NS toggle).
        expect(track.sender.track!.getConstraints()).toMatchObject({
            deviceId: 'default', echoCancellation: true, noiseSuppression: false, autoGainControl: false, voiceIsolation: false,
        });
    });

    it('THE FIX: OS default changes while following "Default" → the SENDER moves to the new mic after one debounced burst', async () => {
        const { os, track, room, sync, outcomes } = setup();
        sync.setApplied('default');
        await sync.seed();

        os.defaultId = 'id-usb';
        for (let i = 0; i < 4; i++) { sync.schedule(); await vi.advanceTimersByTimeAsync(50); } // event storm
        await settle();

        expect(track.restarts).toBe(1);                              // one re-acquire for the whole burst
        expect(track.sender.track!.boundTo.id).toBe('id-usb');       // what the SFU now receives
        expect(track.sender.track!.readyState).toBe('live');
        expect(track.sender.track!.enabled).toBe(true);
        expect(room.switchCalls).toEqual([['default', false]]);      // Room defaults still updated
        expect(os.gumCalls.at(-1)).toBe('default');                  // a fresh getUserMedia on 'default'
        expect(outcomes).toEqual([{ ok: true, reason: 'default_changed' }]);
        // The restart carried our capture constraints (NS/AGC off, echo cancellation = the setting, default ON).
        expect(track._constraints).toMatchObject({ echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    });

    it('logs a contract-valid mic_device_switch event with no device ids or labels', async () => {
        const { os, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        os.defaultId = 'id-usb';
        sync.schedule();
        await settle();
        const ev = getCallEvents().filter(e => e.kind === 'mic_device_switch');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ reason: 'default_changed', to_default: true, verdict: 'ok' });
        expect(validateCallEvent(ev[0])).toEqual([]);
        expect(JSON.stringify(ev)).not.toMatch(/USB|Headset|id-/);
    });

    it('preserves mute: a muted (or push-to-talk idle) user is moved too, and stays muted', async () => {
        const { os, track, sync } = setup({ muted: true });
        sync.setApplied('default');
        await sync.seed();
        os.defaultId = 'id-usb';
        sync.schedule();
        await settle();
        expect(track.restarts).toBe(1);
        expect(track.isMuted).toBe(true);
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
        expect(track.sender.track!.enabled).toBe(false);             // still muted on the wire
        expect(track.pendingDeviceChange).toBe(false);               // no second restart on unmute
    });

    it('an unrelated devicechange (default unchanged) does not touch the mic', async () => {
        const { os, track, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        os.mics.push({ id: 'id-cam', name: 'Webcam mic', group: 'g-cam', present: true });
        sync.schedule();
        await settle();
        expect(track.restarts).toBe(0);
        expect(getCallEvents().filter(e => e.kind === 'mic_device_switch')).toHaveLength(0);
    });

    it('an explicitly-picked mic is NOT moved when the OS default changes', async () => {
        const { os, track, sync } = setup({ setting: 'id-usb', initialDevice: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        os.defaultId = 'id-headset';
        os.mics.reverse();
        sync.schedule();
        await settle();
        expect(track.restarts).toBe(0);
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
    });

    it('explicit mic unplugged (its capture ends first) → falls back to the system default and tells the user once', async () => {
        const { os, track, sync, fellBack, outcomes } = setup({ setting: 'id-usb', initialDevice: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        os.mics.find(m => m.id === 'id-usb')!.present = false;
        track._mediaStreamTrack.readyState = 'ended';
        track._mediaStreamTrack.fire('ended');
        sync.schedule();                                             // + the devicechange
        await settle();
        expect(outcomes).toEqual([{ ok: true, reason: 'track_ended' }]);
        expect(fellBack).toHaveBeenCalledTimes(1);
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
        expect(track.sender.track!.readyState).toBe('live');
        // Later events don't re-notify or re-acquire.
        sync.schedule();
        await settle();
        expect(track.restarts).toBe(1);
        expect(fellBack).toHaveBeenCalledTimes(1);
    });

    it('explicit mic unplugged while its capture is still live → device_lost + notification', async () => {
        const { os, track, sync, fellBack, outcomes } = setup({ setting: 'id-usb', initialDevice: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        os.mics.find(m => m.id === 'id-usb')!.present = false;
        sync.schedule();
        await settle();
        expect(outcomes).toEqual([{ ok: true, reason: 'device_lost' }]);
        expect(fellBack).toHaveBeenCalledTimes(1);
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
    });

    it('a capture that ENDS (driver reset on default switch) is re-acquired via its own ended event', async () => {
        const { track, sync, outcomes } = setup();
        sync.setApplied('default');
        await sync.seed();
        const old = track._mediaStreamTrack;
        old.readyState = 'ended';
        old.fire('ended');
        await settle();
        expect(track.restarts).toBe(1);
        expect(outcomes[0].reason).toBe('track_ended');
        expect(track.sender.track).not.toBe(old);
    });

    it('a capture the OS mutes is re-acquired via its mute event', async () => {
        const { track, sync, outcomes } = setup();
        sync.setApplied('default');
        await sync.seed();
        track._mediaStreamTrack.muted = true;
        track._mediaStreamTrack.fire('mute');
        await settle();
        expect(outcomes[0].reason).toBe('track_muted');
        expect(track.sender.track!.muted).toBe(false);
    });

    it('switching explicit → "Default" restarts exactly once (no double restart)', async () => {
        const { os, track, setting, sync } = setup({ setting: 'id-usb', initialDevice: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        setting.value = '';
        await sync.sync('setting_changed');
        expect(track.restarts).toBe(1);
        expect(track.sender.track!.boundTo.id).toBe(os.defaultId);
    });

    it('a sync requested while one is in flight is coalesced and serviced afterwards', async () => {
        const { os, track, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        os.defaultId = 'id-usb';
        const first = sync.sync(null);
        // A second change lands mid-restart.
        os.defaultId = 'id-headset';
        void sync.sync(null);
        await first;
        await vi.advanceTimersByTimeAsync(10);
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
        expect(track.restarts).toBe(2);
    });

    it('groupId backstop stays silent where the default row has its own groupId (PulseAudio "Default")', async () => {
        const { os, track, sync } = setup();
        os.enumerate = async () => [
            row('default', 'Default', 'g-synthetic'),
            ...os.mics.map(m => row(m.id, m.name, m.group)),
        ];
        sync.setApplied('default');
        await sync.seed();
        for (let i = 0; i < 3; i++) { sync.schedule(); await settle(); }
        expect(track.restarts).toBe(0);
    });

    it('groupId backstop catches a stale capture with no baseline, then self-disables if the platform proves it incomparable', async () => {
        // (a) Real staleness: the default moved before any baseline was seeded.
        const a = setup();
        a.sync.setApplied('default');
        a.os.defaultId = 'id-usb';                                   // before seed()
        await a.sync.seed();
        a.sync.schedule();
        await settle();
        expect(a.track.sender.track!.boundTo.id).toBe('id-usb');
        expect(a.track.restarts).toBe(1);

        // (b) Quirk: paired rows, but the capture reports a different groupId
        // even right after a fresh open → one probe, then the signal is dropped.
        const b = setup();
        const realGum = b.os.getUserMedia.bind(b.os);
        b.os.getUserMedia = (id: unknown) => {
            const t = realGum(id);
            t.getSettings = () => ({ deviceId: t.opened, groupId: 'g-quirk' });
            return t;
        };
        b.track._mediaStreamTrack.getSettings = () => ({ deviceId: 'default', groupId: 'g-quirk' });
        b.sync.setApplied('default');
        await b.sync.seed();
        for (let i = 0; i < 3; i++) { b.sync.schedule(); await settle(); }
        expect(b.track.restarts).toBe(1);
        expect(b.sync.state().groupCheckTrusted).toBe(false);
    });

    it('a failed re-acquire recovers onto the default; a failed recovery is surfaced', async () => {
        const a = setup({ setting: 'id-usb', initialDevice: 'id-usb' });
        a.sync.setApplied('id-usb');
        a.os.failNextGum = 1;
        await a.sync.sync('setting_changed');
        expect(a.track.sender.track!.readyState).toBe('live');
        expect(a.unrecoverable).not.toHaveBeenCalled();

        const b = setup();
        b.sync.setApplied('default');
        b.os.failNextGum = 2;
        await b.sync.sync('silence');
        expect(b.unrecoverable).toHaveBeenCalledTimes(1);
        const ev = getCallEvents().filter(e => e.kind === 'mic_device_switch').at(-1)!;
        expect(ev.detail).toMatchObject({ verdict: 'failed' });
    });

    it('dispose stops pending work', async () => {
        const { os, track, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        os.defaultId = 'id-usb';
        sync.schedule();
        sync.dispose();
        await settle();
        expect(track.restarts).toBe(0);
    });
});

// ── Source-shape pins: the follower is actually connected ───────────────────

describe('SidebarConference wiring', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(join(here, '..', 'components', 'SidebarConference.tsx'), 'utf8');

    it('creates the follower and routes devicechange through its debounce', () => {
        expect(sidebar).toMatch(/createMicDeviceSync\(\{/);
        expect(sidebar).toMatch(/const onDeviceChange = \(\) => follower\.schedule\(\);/);
        expect(sidebar).toMatch(/addEventListener\('devicechange', onDeviceChange\)/);
        expect(sidebar).toMatch(/follower\.dispose\(\)/);
    });

    it('setting changes and silence detection go through the follower', () => {
        expect(sidebar).toMatch(/micSyncRef\.current\?\.sync\('setting_changed'\)/);
        expect(sidebar).toMatch(/micSyncRef\.current\?\.sync\('silence'\)/);
    });

    it('no other mic path calls switchActiveDevice("audioinput") directly any more', () => {
        const direct = sidebar.match(/\.switchActiveDevice\('audioinput'/g) ?? [];
        expect(direct).toHaveLength(1); // the follower's dependency, and nothing else
        expect(sidebar).toMatch(/switchActiveDevice: \(id, exact\) => room\.switchActiveDevice\('audioinput', id, exact\)/);
    });

    it('re-asserts capture flags through the follower (RAW track, by reading getSettings) — not applyConstraints on the processor output', () => {
        // Restarted -> follower.applyCapture(), which reads readCaptureTrack()'s
        // getSettings() and re-opens on a mismatch. A bare applyConstraints is a
        // no-op for echoCancellation/NS/AGC in Chromium.
        expect(sidebar).toMatch(/onRestarted = \(\) => \{[\s\S]{0,900}micSyncRef\.current\?\.applyCapture\(\)/);
        expect(sidebar).not.toMatch(/micTrack\.mediaStreamTrack\s*\n?\s*\?\.applyConstraints/);
        expect(sidebar).not.toMatch(/\.applyConstraints\?*\.?\(\s*(?:MIC_CAPTURE|micCapture)/);
    });
});

// ── Explicit picks: the capture must be ON the picked mic (2026-10) ──────────
//
// "When I set my input device to something other than the default, it just
// ignores it and uses the default." Two ways the call landed on the default
// with an explicit pick, both invisible to the old follower because its check
// ended at `appliedId === desiredId`:
//   - livekit-client's ended-recovery (LocalParticipant.handleTrackEnded)
//     reopens the mic with `{deviceId:'default'}` whatever was picked;
//   - a stored id that Windows re-enumerated makes the join's `{exact}` fail,
//     and createLocalTracks retries with `{ideal}`, i.e. the default.

describe('decideMicReacquire — a concrete pick whose capture is elsewhere', () => {
    const pick = (over: Partial<MicReacquireInput> = {}) => base({
        setting: 'mic-x', desiredId: 'mic-x', appliedId: 'mic-x', activeId: 'default', onRequested: false, ...over,
    });

    it('applied === desired but the capture is verifiably on another device → device_mismatch', () => {
        expect(decideMicReacquire(pick())).toEqual({ reacquire: true, reason: 'device_mismatch' });
    });

    it('…not while the track is muted (LiveKit defers a concrete switch to the unmute)', () => {
        expect(decideMicReacquire(pick({ trackMuted: true })).reacquire).toBe(false);
    });

    it('…not when the capture device cannot be read (unverifiable is not evidence)', () => {
        expect(decideMicReacquire(pick({ activeId: null })).reacquire).toBe(false);
    });

    it('…not for a target that just failed (verify must not loop restart → verify → restart)', () => {
        expect(decideMicReacquire(pick({ suppressMismatch: true })).reacquire).toBe(false);
        expect(decideMicReacquire(pick({ appliedId: 'default', suppressMismatch: true })).reacquire).toBe(false);
    });

    it('…and a forced pass (setting change) is never suppressed', () => {
        expect(decideMicReacquire(pick({ force: 'setting_changed', suppressMismatch: true })).reason).toBe('setting_changed');
    });

    it('following the default is unaffected by the new check', () => {
        expect(decideMicReacquire(base({ activeId: 'id-somewhere', onRequested: false })).reacquire).toBe(false);
    });
});

describe('createMicDeviceSync — explicit picks survive restarts, reconnects and stale ids', () => {
    beforeEach(() => { vi.useFakeTimers(); clearCallEvents(); });
    afterEach(() => { vi.useRealTimers(); });

    it("LiveKit's ended-recovery reopens 'default' → verify() puts the SENDER back on the picked mic", async () => {
        const { os, track, sync } = setup({ setting: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        expect(track.sender.track!.boundTo.id).toBe('id-usb');

        // LocalParticipant.handleTrackEnded: restartTrack({ deviceId: 'default' }).
        track._mediaStreamTrack.readyState = 'ended';
        await track.restartTrack({ deviceId: 'default' });
        expect(track.sender.track!.boundTo.id).toBe('id-headset'); // the OS default
        const gum0 = os.gumCalls.length;

        sync.verify();                                              // TrackEvent.Restarted → verify
        await settle();
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
        expect(os.gumCalls.length).toBe(gum0 + 1);
        expect(os.gumCalls.at(-1)).toEqual({ exact: 'id-usb' });     // only {exact} opens a picked mic

        // And the landed state is stable: another verify does nothing.
        sync.verify();
        await settle();
        expect(os.gumCalls.length).toBe(gum0 + 1);
    });

    it('a reconnect republish (restartTrack() with no options) reopens the PICKED mic, with {exact}', async () => {
        const { os, track, sync } = setup({ setting: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        // LocalParticipant.republishAllTracks → track.restartTrack() → this._constraints.
        await track.restartTrack();
        expect(os.gumCalls.at(-1)).toEqual({ exact: 'id-usb' });
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
    });

    it('join with a STALE stored id: the call fell back to the default; verify() follows the pick by groupId+label', async () => {
        // Windows re-enumerated the USB mic: stored id 'id-usb-OLD', the device
        // is now listed as 'id-usb' (same group, same label). The join's
        // {exact:'id-usb-OLD'} failed → createLocalTracks retried {ideal} → default.
        const { os, track, sync, fellBack } = setup({
            setting: 'id-usb-OLD', initialDevice: 'default', hint: { label: 'USB Mic', groupId: 'g-usb' },
        });
        sync.setApplied('id-usb-OLD');            // what SidebarConference records at mount
        await sync.seed();
        sync.verify();                            // the mic publication
        await settle();
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
        expect(os.gumCalls.at(-1)).toEqual({ exact: 'id-usb' });
        expect(fellBack).not.toHaveBeenCalled();  // it was found, not lost
    });

    it('NEGATIVE CONTROL: the same stale id WITHOUT the stored label/groupId cannot be followed → default + one notice', async () => {
        const { track, sync, fellBack } = setup({ setting: 'id-usb-OLD', initialDevice: 'default' });
        sync.setApplied('id-usb-OLD');
        await sync.seed();
        sync.verify();
        await settle();
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
        expect(fellBack).toHaveBeenCalledTimes(1);
    });

    it('a pick that cannot be opened is not retried by verify() (no restart loop) — only by a device change', async () => {
        const { os, track, sync } = setup({ setting: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        await track.restartTrack({ deviceId: 'default' });           // LiveKit's recovery
        os.failNextGum = 1;                                           // the picked mic refuses to open once
        sync.verify();
        await settle();
        // The failed switch was recovered onto the default (the old capture had
        // already been stopped by LiveKit's restart).
        expect(track.sender.track!.boundTo.id).toBe('id-headset');
        const gumAfterFailure = os.gumCalls.length;

        sync.verify();                                                // TrackEvent.Restarted of that recovery
        await settle();
        sync.verify();
        await settle();
        expect(os.gumCalls.length).toBe(gumAfterFailure);             // no loop

        sync.schedule();                                              // devicechange: new information
        await settle();
        expect(track.sender.track!.boundTo.id).toBe('id-usb');
    });

    it('a muted user on a deferred pick is not restarted by verify()', async () => {
        const { track, sync } = setup({ setting: 'id-usb', initialDevice: 'default', muted: true });
        sync.setApplied('id-usb');
        await sync.seed();
        sync.verify();
        await settle();
        expect(track.restarts).toBe(0);
    });
});

describe('SidebarConference wiring — verification points', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebar = readFileSync(join(here, '..', 'components', 'SidebarConference.tsx'), 'utf8');

    it('verifies on every mic publication and every track restart, with the stored device hint', () => {
        const watchdog = sidebar.slice(sidebar.indexOf('const onRestarted = () => {'));
        const onRestarted = watchdog.slice(0, watchdog.indexOf('};'));
        expect(onRestarted).toMatch(/micSyncRef\.current\?\.verify\(\)/);
        // …and once at the effect's setup, which re-runs per publication (micTrackSid).
        expect(watchdog.slice(watchdog.indexOf('};'), watchdog.indexOf('let recovered'))).toMatch(/micSyncRef\.current\?\.verify\(\)/);
        expect(sidebar).toMatch(/getSettingHint: \(\) => micHintRef\.current/);
    });
});

// ── Echo cancellation: live toggle + every re-open path ─────────────────────
//
// Measured on Chromium 153 (the fake models it): the processing flags are fixed
// when the capture is OPENED, an absent constraint means ON, and
// applyConstraints({echoCancellation|noiseSuppression|autoGainControl}) records
// the constraint but changes neither getSettings() nor the audio. So a toggle
// (and a livekit-client re-open with narrow constraints) can only be honoured by
// re-opening the capture — restartTrack on the same sender.

const flagsOf = (t: FakeMst) => {
    const s = t.getSettings();
    return { ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl };
};

describe('echo cancellation — live toggle and re-open paths', () => {
    beforeEach(() => { vi.useFakeTimers(); clearCallEvents(); clock.t = 0; });
    afterEach(() => { vi.useRealTimers(); });

    it('a call joins with echo cancellation ON by default, and NS/AGC OFF (our chain owns those)', () => {
        const { track } = setup();
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: true, ns: false, agc: false });
    });

    it('MODEL CHECK (negative control): applyConstraints does not change what the capture reports', async () => {
        const { track } = setup();
        const raw = track._mediaStreamTrack;
        await raw.applyConstraints({ echoCancellation: false });
        expect(raw.getConstraints().echoCancellation).toBe(false);   // recorded…
        expect(flagsOf(raw).ec).toBe(true);                           // …but not applied
    });

    it('toggling OFF mid-call re-opens the capture on the SAME sender, same device, without unpublishing', async () => {
        const { track, echo, sync, os } = setup({ setting: 'id-usb' });
        const sender = track.sender;
        const before = track._mediaStreamTrack;
        echo.value = false;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(track.sender).toBe(sender);                             // same RTCRtpSender → E2EE cryptor stays bound
        expect(track.sender.track).toBe(track._mediaStreamTrack);      // replaceTrack'd
        expect(track._mediaStreamTrack).not.toBe(before);
        expect(before.readyState).toBe('ended');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: false, ns: false, agc: false });
        expect(track._mediaStreamTrack.boundTo.id).toBe('id-usb');     // did not hop to the default
        expect(track.restarts).toBe(1);
        expect(os.gumCalls.at(-1)).toEqual({ exact: 'id-usb' });
        // LiveKit's stored copy follows, so a later restart()/stopProcessor() cannot revert it.
        expect(track.constraints.echoCancellation).toBe(false);
    });

    it('toggling back ON re-opens again (both directions work)', async () => {
        const { track, echo, sync } = setup();
        echo.value = false;
        await sync.applyCapture();
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
        echo.value = true;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: true, ns: false, agc: false });
        expect(track.restarts).toBe(2);
    });

    it('does not use applyConstraints for the change, and does nothing when the capture already matches', async () => {
        const { track, echo, sync, os } = setup();
        expect(await sync.applyCapture()).toBe('unchanged');
        expect(track.restarts).toBe(0);
        expect(os.gumCalls).toHaveLength(1);                           // only the join's own open
        echo.value = false;
        const raw = track._mediaStreamTrack;
        await sync.applyCapture();
        expect(raw.applyConstraints).not.toHaveBeenCalled();
    });

    it('a muted user stays muted across the toggle (the swap keeps `enabled = !isMuted`)', async () => {
        const { track, echo, sync } = setup({ muted: true });
        echo.value = false;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(track.isMuted).toBe(true);
        expect(track._mediaStreamTrack.enabled).toBe(false);
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
    });

    it('nothing published yet: no_track, no capture opened (the next open reads the setting)', async () => {
        const { room, echo, sync, os } = setup();
        room.track = null;
        echo.value = false;
        expect(await sync.applyCapture()).toBe('no_track');
        expect(os.gumCalls).toHaveLength(1);
    });

    it('default-follow restart carries the CURRENT setting (not the one from join)', async () => {
        const { os, track, echo, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        echo.value = false;                       // toggled; no applyCapture yet
        os.defaultId = 'id-usb';
        sync.schedule();
        await settle();
        expect(track._mediaStreamTrack.boundTo.id).toBe('id-usb');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: false, ns: false, agc: false });
    });

    it('explicit-device switch (livekit restarts from ITS stored constraints) carries the setting', async () => {
        const { track, echo, sync, setting } = setup({ setting: 'id-headset' });
        sync.setApplied('id-headset');
        echo.value = false;
        setting.value = 'id-usb';
        await sync.sync('setting_changed');
        expect(track._mediaStreamTrack.boundTo.id).toBe('id-usb');
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
    });

    it('NEGATIVE CONTROL: without syncing the stored copy, livekit-client would reopen with the stale value', async () => {
        // What the fake's setDeviceId does when nobody updated `_constraints`.
        const { track } = setup({ setting: 'id-headset' });
        await track.setDeviceId({ exact: 'id-usb' });
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(true);        // stale (join value), proving the sync matters
    });

    it('device-lost fallback (the picked mic is unplugged) carries the setting', async () => {
        const { os, track, echo, sync, setting } = setup({ setting: 'id-usb' });
        sync.setApplied('id-usb');
        await sync.seed();
        echo.value = false;
        os.mics.find(m => m.id === 'id-usb')!.present = false;
        track._mediaStreamTrack.readyState = 'ended';
        void setting;
        await sync.sync('track_ended');
        expect(track._mediaStreamTrack.boundTo.id).toBe('id-headset');
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
    });

    it('the widest recovery (after a throw) carries the setting too', async () => {
        const { os, track, echo, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        echo.value = false;
        os.defaultId = 'id-usb';
        os.failNextGum = 1;                       // the targeted re-acquire throws…
        await sync.sync('default_changed');       // …the recovery restart does not
        expect(track._mediaStreamTrack.readyState).toBe('live');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: false, ns: false, agc: false });
    });

    it("livekit-client's own narrow reopen ({deviceId:'default'} → Chromium defaults ON) is corrected", async () => {
        const { track, echo, sync } = setup();
        echo.value = false;
        await track.restartTrack({ deviceId: 'default' });             // LocalParticipant.handleTrackEnded
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: true, ns: true, agc: true });  // wrong on every flag
        expect(await sync.applyCapture()).toBe('restarted');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: false, ns: false, agc: false });
    });

    it('with the setting ON that same narrow reopen still gets NS and AGC switched back off', async () => {
        const { track, sync } = setup();
        await track.restartTrack({ deviceId: 'default' });
        expect(await sync.applyCapture()).toBe('restarted');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: true, ns: false, agc: false });
    });

    it('loop guard: a platform that will not honour the flags is retried at most once per cooldown', async () => {
        const { os, track, echo, sync } = setup();
        echo.value = false;
        os.ignoreFlags = true;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(await sync.applyCapture()).toBe('cooldown');
        expect(await sync.applyCapture()).toBe('cooldown');
        expect(track.restarts).toBe(1);
        clock.t += CAPTURE_ENFORCE_COOLDOWN_MS + 1;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(track.restarts).toBe(2);
    });

    it('the cooldown does not outlive a restart that worked: a narrow reopen seconds after a toggle is still corrected', async () => {
        const { track, echo, sync } = setup();
        echo.value = false;
        expect(await sync.applyCapture()).toBe('restarted');
        clock.t += 2_000;                                              // well inside the cooldown window
        await track.restartTrack({ deviceId: 'default' });            // livekit's ended-recovery: all flags back ON
        expect(await sync.applyCapture()).toBe('restarted');
        expect(flagsOf(track._mediaStreamTrack)).toEqual({ ec: false, ns: false, agc: false });
    });

    it('the cooldown never blocks a genuinely NEW request (ON → OFF → ON in quick succession)', async () => {
        const { track, echo, sync } = setup();
        echo.value = false;
        expect(await sync.applyCapture()).toBe('restarted');
        echo.value = true;
        expect(await sync.applyCapture()).toBe('restarted');
        echo.value = false;
        expect(await sync.applyCapture()).toBe('restarted');
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
        expect(track.restarts).toBe(3);
    });

    it('a toggle during a device sync is deferred, then applied when the sync finishes', async () => {
        const { os, track, echo, sync } = setup();
        sync.setApplied('default');
        await sync.seed();
        os.defaultId = 'id-usb';
        const running = sync.sync('default_changed');
        echo.value = false;
        expect(await sync.applyCapture()).toBe('deferred');
        await running;
        await vi.advanceTimersByTimeAsync(10);
        expect(track._mediaStreamTrack.boundTo.id).toBe('id-usb');
        expect(flagsOf(track._mediaStreamTrack).ec).toBe(false);
    });

    it('a failed restart reports failed and logs a failed event', async () => {
        const { os, echo, sync } = setup();
        echo.value = false;
        os.failNextGum = 1;
        expect(await sync.applyCapture()).toBe('failed');
        const ev = getCallEvents().filter(e => e.kind === 'mic_echo_cancellation');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ on: false, changed: true, verdict: 'failed' });
    });

    it('logs a contract-valid mic_echo_cancellation event with booleans/enums only', async () => {
        const { echo, sync } = setup();
        echo.value = false;
        await sync.applyCapture();
        const ev = getCallEvents().filter(e => e.kind === 'mic_echo_cancellation');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ on: false, changed: true, verdict: 'ok' });
        expect(validateCallEvent(ev[0])).toEqual([]);
        // An unchanged capture logs nothing.
        clearCallEvents();
        await sync.applyCapture();
        expect(getCallEvents().filter(e => e.kind === 'mic_echo_cancellation')).toHaveLength(0);
    });
});

describe('setRoomEchoCancellation', () => {
    it("updates the Room's audioCaptureDefaults in place (a mic created later is opened from them)", () => {
        const room = { options: { audioCaptureDefaults: { echoCancellation: true, noiseSuppression: false } as MediaTrackConstraints } };
        setRoomEchoCancellation(room, false);
        expect(room.options.audioCaptureDefaults).toEqual({ echoCancellation: false, noiseSuppression: false });
        setRoomEchoCancellation(room, true);
        expect(room.options.audioCaptureDefaults.echoCancellation).toBe(true);
    });
    it('tolerates a missing room / options (no throw, nothing created)', () => {
        expect(() => setRoomEchoCancellation(null, true)).not.toThrow();
        expect(() => setRoomEchoCancellation({}, true)).not.toThrow();
        const bare: { options: { audioCaptureDefaults?: MediaTrackConstraints } } = { options: {} };
        setRoomEchoCancellation(bare, true);
        expect(bare.options.audioCaptureDefaults).toBeUndefined();
    });
});

describe('captureFlagMismatches', () => {
    const raw = (s: MediaTrackSettings) => ({ readyState: 'live', muted: false, getSettings: () => s });
    it('lists only the flags that disagree', () => {
        expect(captureFlagMismatches(raw({ echoCancellation: true, noiseSuppression: true, autoGainControl: false }),
            { echoCancellation: false, noiseSuppression: false, autoGainControl: false })).toEqual(['echoCancellation', 'noiseSuppression']);
    });
    it('is empty when everything matches, for a missing track, and for flags the platform does not report', () => {
        expect(captureFlagMismatches(raw({ echoCancellation: true }), { echoCancellation: true, noiseSuppression: false })).toEqual([]);
        expect(captureFlagMismatches(null, { echoCancellation: true })).toEqual([]);
        expect(captureFlagMismatches(raw({}), { echoCancellation: true })).toEqual([]);
    });
    it('does not treat a non-boolean wanted value (e.g. {exact:true}) as a mismatch', () => {
        expect(captureFlagMismatches(raw({ echoCancellation: false }), { echoCancellation: { exact: true } })).toEqual([]);
    });
});

describe('the join opens the picked mic with {exact}', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const callPane = readFileSync(join(here, '..', 'components', 'CallPane.tsx'), 'utf8');

    it('CallPane hands the stored pick to audioCaptureDefaults, and livekit-client turns a string id into {exact}', () => {
        expect(callPane).toMatch(/useState\(\(\) => resolveMicDeviceId\(voice\?\.settings\.micDeviceId\)\)/);
        expect(callPane).toMatch(/\.\.\.micCaptureConstraints\(initialEchoCancellation\),[\s\S]{0,400}deviceId: initialMicDeviceId,/);
        const req = createRequire(import.meta.url);
        const esm = readFileSync(join(dirname(req.resolve('livekit-client')), 'livekit-client.esm.mjs'), 'utf8');
        // createLocalTracks: "if the user passes a device id as a string, we default to exact match"
        expect(esm).toMatch(/internalOptions\.audio\.deviceId = \{\s*exact: deviceId\s*\}/);
    });
});
