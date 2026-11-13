import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { shareAudioEventDetail } from './shareAudioEvent';
import { windowAudioBlockedReason } from './sharePlatformSupport';
import { CALL_EVENT_KINDS, logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

describe('share_audio event detail', () => {
    it('is a registered call event kind and survives the log contract', () => {
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('share_audio');
        clearCallEvents();
        logCallEvent('share_audio', shareAudioEventDetail({ step: 'first_chunk', mode: 'screen', ms: 312.4, platform: 'linux' }));
        const ev = getCallEvents().find(e => e.kind === 'share_audio')!;
        expect(ev.detail).toEqual({ step: 'first_chunk', mode: 'screen', ms: 312, os: 'linux' });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('carries only fixed words: anything off the lists becomes "other", never the caller\'s text', () => {
        expect(shareAudioEventDetail({ step: 'skipped', why: 'Firefox - /home/me/secret' }).why).toBe('other');
        expect(shareAudioEventDetail({ step: 'failed', reason: 'could not open /run/user/1000/pipewire-0' }).reason).toBe('other');
        expect(shareAudioEventDetail({ step: 'stopped', cause: 'window:132456:0' }).cause).toBe('other');
        expect(shareAudioEventDetail({ step: 'skipped', why: 'window_unsupported' }).why).toBe('window_unsupported');
        expect(shareAudioEventDetail({ step: 'failed', reason: 'unavailable' }).reason).toBe('unavailable');
        expect(shareAudioEventDetail({ step: 'stopped', cause: 'swap' }).cause).toBe('swap');
    });

    it('drops fields that do not belong to the step, bad numbers and unknown platforms', () => {
        const d = shareAudioEventDetail({ step: 'starting', mode: 'window', why: 'off', reason: 'error', cause: 'swap', ms: NaN, platform: 'plan9' });
        expect(d).toEqual({ step: 'starting', mode: 'window' });
        expect(shareAudioEventDetail({ step: 'refused', ms: -5 })).toEqual({ step: 'refused' });
    });
});

describe('share_audio: Wayland window shares take one app\'s audio (mode "app", counts only)', () => {
    it('mode "app" is a fixed word that survives the log contract', () => {
        clearCallEvents();
        logCallEvent('share_audio', shareAudioEventDetail({ step: 'first_chunk', mode: 'app', ms: 41.2, platform: 'linux' }));
        const ev = getCallEvents().find(e => e.kind === 'share_audio')!;
        expect(ev.detail).toEqual({ step: 'first_chunk', mode: 'app', ms: 41, os: 'linux' });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('"picked" carries a COUNT of apps and a fixed "how" - never a name', () => {
        const d = shareAudioEventDetail({ step: 'picked', mode: 'app', apps: 3, how: 'auto', platform: 'linux' });
        expect(d).toEqual({ step: 'picked', mode: 'app', apps: 3, how: 'auto', os: 'linux' });
        expect(shareAudioEventDetail({ step: 'picked', mode: 'app', apps: 0, how: 'none' })).toEqual({ step: 'picked', mode: 'app', apps: 0, how: 'none' });
        // anything off the list is 'other', a bad count is dropped, a huge one is capped
        expect(shareAudioEventDetail({ step: 'picked', how: 'Firefox - YouTube' }).how).toBe('other');
        expect(shareAudioEventDetail({ step: 'picked', apps: NaN, how: 'none' })).toEqual({ step: 'picked', how: 'none' });
        expect(shareAudioEventDetail({ step: 'picked', apps: 5000, how: 'none' }).apps).toBe(99);
        // the fields do not leak onto other steps
        expect(shareAudioEventDetail({ step: 'starting', mode: 'app', apps: 3, how: 'auto' })).toEqual({ step: 'starting', mode: 'app' });
        expect(validateCallEvent({ t: 1_700_000_000_000, kind: 'share_audio', detail: d })).toEqual([]);
    });

    it('an unknown mode is not passed through', () => {
        expect(shareAudioEventDetail({ step: 'starting', mode: 'Spotify' as never })).toEqual({ step: 'starting' });
    });

    it('wiring: the app start logs mode app and passes only the handle; the picker logs a count', () => {
        const start = SC.slice(SC.indexOf('const startNativeWindowAudio = React.useCallback'), SC.indexOf('// Electron IPC: fires when getDisplayMedia is intercepted'));
        expect(start).toContain("const logMode: 'screen' | 'window' | 'app' = viaApp ? 'app' : mode;");
        expect(start).toContain('window.electronAPI!.startAppAudioCapture!(appHandle!, grantTokenFor(shareGrantRef.current, sourceId))');
        expect(start).not.toMatch(/logShareAudio\(\{[^}]*\bmode,/);       // every row says logMode
        const picker = fs.readFileSync(path.resolve(__dirname, '../components/ScreenSharePickerModal.tsx'), 'utf8');
        expect(picker).toContain("step: 'picked', mode: 'app', apps: audioApps?.length ?? 0, how: appPick ? appPick.how : 'none'");
        // names stay out of every log line in the picker's app code
        expect(picker).not.toMatch(/console\.\w+\([^)]*appPick/);
    });
});

describe('windowAudioBlockedReason', () => {
    it('blocks a window only on Linux through the portal (or while that is not known yet)', () => {
        expect(windowAudioBlockedReason('linux', true, true)).toMatch(/whole screen/);
        expect(windowAudioBlockedReason('linux', null, true)).toMatch(/whole screen/);
    });
    it('leaves everything else alone: X11 windows, any screen, other platforms', () => {
        expect(windowAudioBlockedReason('linux', false, true)).toBeNull();
        expect(windowAudioBlockedReason('linux', true, false)).toBeNull();
        expect(windowAudioBlockedReason('windows', true, true)).toBeNull();
        expect(windowAudioBlockedReason('mac', null, true)).toBeNull();
        expect(windowAudioBlockedReason(undefined, true, true)).toBeNull();
    });
});

const SC = fs.readFileSync(path.resolve(__dirname, '../components/SidebarConference.tsx'), 'utf8');
const MAIN = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');

describe('wiring: a source swap keeps the share audio and every step leaves a row', () => {
    beforeEach(() => clearCallEvents());

    it('the picker opens ticked from the running share, so Change source keeps audio', () => {
        // onSelect also clears the remembered annotation-screen answer when the source changes (desktopAnnotationOverlay forgetScreenAnswer),
        // so pin the select handler's routing and the audio props separately.
        const picker = SC.slice(SC.indexOf('<ScreenSharePickerModal onSelect='), SC.indexOf('/>', SC.indexOf('<ScreenSharePickerModal onSelect=')) + 2);
        expect(picker).toContain('return handleScreenShareSelect(o);');
        expect(picker).toContain('initialAudio={currentShare?.audio === true} initialAppAudio={currentShare?.audio === true ? currentShare.appAudio ?? null : null} liveSourceId={currentShare && isPortalSourceId(currentShare.sourceId) ? currentShare.sourceId : null} />');
    });

    it('the hot swap names its stop "swap" and logs when audio is not restarted', () => {
        const swap = SC.slice(SC.indexOf("await stopNativeWindowAudio('swap');"), SC.indexOf("await stopNativeWindowAudio('swap');") + 400);
        expect(swap).toContain("logShareAudio({ step: 'skipped'");
        expect(swap).toContain('startNativeWindowAudio(nativeMode, options.sourceId, options.appAudio?.handle)');
    });

    it('the native start logs starting / refused / first_chunk / no_chunks / failed / exited', () => {
        const start = SC.slice(SC.indexOf('const startNativeWindowAudio = React.useCallback'), SC.indexOf('// Electron IPC: fires when getDisplayMedia is intercepted'));
        for (const step of ['starting', 'refused', 'first_chunk', 'no_chunks', 'failed', 'exited']) {
            expect(start).toContain(`step: '${step}'`);
        }
    });

    it('main logs a change of the addon\'s answer (a boolean and the platform), and whether the addon was loaded when a start is refused', () => {
        expect(MAIN).toContain("native audio capture is ${answer ? 'available' : 'NOT available'} (platform=${process.platform})");
        expect(MAIN).toContain('(addonLoaded=${!!audioCaptureAddon})');
    });
});
