import { describe, it, expect, beforeEach } from 'vitest';
import { HoldMicController, type MicPort } from './holdMic';
import { getPttUiState, setPttUiState, resetPttUiState } from './pushToTalk';

/** A fake call mic. `set` applies immediately (the awaited promise just resolves). */
function fakeMic(initial: { enabled: boolean; canOpen?: boolean; deafened?: boolean }) {
    const st = { enabled: initial.enabled, canOpen: initial.canOpen ?? true, deafened: initial.deafened ?? false, sets: [] as boolean[], cues: [] as string[] };
    const port: MicPort = {
        isEnabled: () => st.enabled,
        set: async (on) => { st.sets.push(on); st.enabled = on; },
        canOpen: () => st.canOpen,
        canRestore: () => st.canOpen && !st.deafened,
        cue: (k) => { st.cues.push(k); },
    };
    return { st, port };
}
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { setPttUiState({ recording: false }); resetPttUiState(); });

describe('push-to-talk mode', () => {
    it('press opens the mic, release closes it', async () => {
        const { st, port } = fakeMic({ enabled: false });
        setPttUiState({ active: true });
        const c = new HoldMicController(port);
        c.pttPress(); await flush();
        expect(st.enabled).toBe(true);
        expect(getPttUiState().keyDown).toBe(true);
        c.pttRelease();
        expect(st.enabled).toBe(false);
        expect(getPttUiState().keyDown).toBe(false);
    });

    it('a repeated press (two delivery paths, key repeat) opens once', async () => {
        const { st, port } = fakeMic({ enabled: false });
        setPttUiState({ active: true });
        const c = new HoldMicController(port);
        c.pttPress(); c.pttPress(); await flush();
        expect(st.sets).toEqual([true]);
    });

    it('a deliberate Mute (manualMuted) makes the key do nothing until unmuted', async () => {
        const { st, port } = fakeMic({ enabled: false });
        setPttUiState({ active: true, manualMuted: true });
        const c = new HoldMicController(port);
        c.pttPress(); await flush();
        expect(st.enabled).toBe(false);
        expect(getPttUiState().keyDown).toBe(false);
        setPttUiState({ manualMuted: false });
        c.pttPress(); await flush();
        expect(st.enabled).toBe(true);
    });

    it('a tap released before the mic finished opening does not leave it hot', async () => {
        const st = { enabled: false };
        let resolveOpen!: () => void;
        const port: MicPort = {
            isEnabled: () => st.enabled,
            set: (on) => on ? new Promise<void>(r => { resolveOpen = () => { st.enabled = true; r(); }; }) : Promise.resolve().then(() => { st.enabled = false; }),
            canOpen: () => true, canRestore: () => true,
        };
        setPttUiState({ active: true });
        const c = new HoldMicController(port);
        c.pttPress();
        c.pttRelease();          // still not open: nothing to close yet
        resolveOpen();           // the open completes AFTER the release
        await flush();
        expect(st.enabled).toBe(false);
    });

    it('does not open a mic the user may not speak on, and ignores presses while a key is being recorded', async () => {
        const a = fakeMic({ enabled: false, canOpen: false });
        setPttUiState({ active: true });
        new HoldMicController(a.port).pttPress(); await flush();
        expect(a.st.sets).toEqual([]);
        const b = fakeMic({ enabled: false });
        setPttUiState({ recording: true });
        new HoldMicController(b.port).pttPress(); await flush();
        expect(b.st.sets).toEqual([]);
    });

    it('is a no-op outside push-to-talk mode', async () => {
        const { st, port } = fakeMic({ enabled: false });
        new HoldMicController(port).pttPress(); await flush();
        expect(st.sets).toEqual([]);
    });
});

describe('push-to-talk on with NO key bound', () => {
    it('the mic stays closed and no press path can open it (it is never left hot)', async () => {
        const { st, port } = fakeMic({ enabled: false });
        setPttUiState({ active: true, keyDown: false });   // what the call sets for "PTT on, waiting"
        const c = new HoldMicController(port);
        c.pttRelease(); c.mutePress(); c.muteRelease(); await flush();   // no key wired: only stray releases / inert mute
        expect(st.sets).toEqual([]);
        expect(st.enabled).toBe(false);
    });
});

describe('push-to-mute (normal mode)', () => {
    it('holding mutes a live mic, and release gives it back', async () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();
        expect(st.enabled).toBe(false);
        c.muteRelease();
        expect(st.enabled).toBe(true);
    });

    it('never UNMUTES someone who was already manually muted when they pressed it', () => {
        const { st, port } = fakeMic({ enabled: false });
        const c = new HoldMicController(port);
        c.mutePress();
        c.muteRelease();
        expect(st.sets).toEqual([]);
        expect(st.enabled).toBe(false);
    });

    it('if the user toggles Mute during the hold they have taken over: release restores nothing', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();                 // muted by the hold
        c.userToggled();               // user clicks Mute/Unmute meanwhile
        port.set(true);                // ... which unmuted them
        c.muteRelease();
        expect(st.enabled).toBe(true); // untouched by release (no extra set)
        expect(st.sets).toEqual([false, true]);
        // and the opposite: user mutes themselves during the hold, release must not unmute
        const m = fakeMic({ enabled: true });
        const c2 = new HoldMicController(m.port);
        c2.mutePress(); c2.userToggled();
        c2.muteRelease();
        expect(m.st.enabled).toBe(false);
    });

    it('does not give the mic back to someone who deafened (or lost permission) during the hold', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();
        st.deafened = true;
        c.muteRelease();
        expect(st.enabled).toBe(false);
    });

    it('repeated press / release are idempotent', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress(); c.mutePress();
        c.muteRelease(); c.muteRelease();
        expect(st.sets).toEqual([false, true]);
    });

    it('is inert while push-to-talk mode is on', () => {
        const { st, port } = fakeMic({ enabled: true });
        setPttUiState({ active: true });
        const c = new HoldMicController(port);
        c.mutePress(); c.muteRelease();
        expect(st.sets).toEqual([]);
    });

    it('turning push-to-talk on mid-hold drops the hold so release cannot reopen a PTT-closed mic', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();                  // muted by the hold
        setPttUiState({ active: true });
        c.enteredPttMode();
        c.muteRelease();
        expect(st.enabled).toBe(false);
    });

    it('window blur with no system-wide watcher releases everything', async () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();
        c.releaseAll();
        expect(st.enabled).toBe(true);
    });
});

describe('push-to-mute sounds', () => {
    it('plays mute on press and unmute on release, exactly once each', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress(); c.mutePress();
        c.muteRelease(); c.muteRelease();
        expect(st.cues).toEqual(['mute', 'unmute']);
    });

    it('is silent when the mic was already muted (nothing changed)', () => {
        const { st, port } = fakeMic({ enabled: false });
        const c = new HoldMicController(port);
        c.mutePress(); c.muteRelease();
        expect(st.cues).toEqual([]);
    });

    it('no unmute sound when release does not give the mic back (deafened during the hold)', () => {
        const { st, port } = fakeMic({ enabled: true });
        const c = new HoldMicController(port);
        c.mutePress();
        st.deafened = true;
        c.muteRelease();
        expect(st.cues).toEqual(['mute']);
    });

    it('push-to-talk itself stays silent', async () => {
        const { st, port } = fakeMic({ enabled: false });
        const c = new HoldMicController(port);
        setPttUiState({ active: true });
        c.pttPress(); await flush(); c.pttRelease();
        expect(st.cues).toEqual([]);
    });
});
