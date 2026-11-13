/**
 * Source-wiring pins for Linux system-audio shares, the same approach as screenShareStartWiring.test.ts.
 * 2026-11-02: Linux refused audio outright. Now it is offered exactly when the native PipeWire addon says it
 * is supported (src-native/audio_capture_linux.cc, `audio:is-capture-supported`), and refused - with a true
 * reason - when it is not. The decision itself is tested in utils/sharePlatformSupport.test.ts and
 * electron/share-platform.audio.test.ts; the addon in electron/linuxAudioCapture.wiring.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const sc = read('SidebarConference.tsx');
const picker = read('ScreenSharePickerModal.tsx');
const body = (name: string): string => {
    const i = sc.indexOf(`const ${name} = `);
    if (i < 0) return '';
    const j = sc.indexOf('\n    };\n', i);
    return sc.slice(i, j);
};

describe('Linux: system audio is offered only when the PipeWire addon is supported, and refused honestly otherwise', () => {
    it('a request for audio asks the addon first (a transient "no" is re-asked), then is dropped with the notice before anything starts', () => {
        const h = body('handleScreenShareSelect');
        expect(h).toContain("window.electronAPI?.platform === 'linux' && window.electronAPI.isAudioCaptureSupported");
        expect(h).toMatch(/shareAudioUnavailableReason\(window\.electronAPI\?\.platform, linuxNativeAudio\)/);
        expect(h).toMatch(/options\.audio = false;\s*logShareAudio\(\{ step: 'skipped', why: 'no_native' \}\);\s*setScreenShareNotice\(\{ tone: 'info', text: `\$\{noAudioWhy\} Sharing without audio\.` \}\);/);
    });
    it('the in-call audio toggle is offered only when the addon is supported', () => {
        expect(sc).toContain('onToggleScreenShareAudio={shareAudioUnavailableReason(window.electronAPI?.platform, nativeAudioSupported) ? undefined : toggleScreenShareAudio}');
    });
    it('the picker asks the addon, keeps the checkbox off until it answers yes, and says why when it is off', () => {
        expect(picker).toContain('<ShareAudioToggle audio={audio} setAudio={setAudio} blockedWhy={audioBlockedWhy} />');
        expect(picker).toContain('window.electronAPI?.isAudioCaptureSupported?.()');
        expect(picker).toContain('shareAudioUnavailableReason(platform, native)');
        expect(picker).toMatch(/useState\(false\);\s*useEffect\(\(\) => \{\s*if \(platform !== 'linux'\) return;/);
        expect(picker).toMatch(/disabled=\{!!why\}/);
    });
    it('a window whose process cannot be found says so honestly (a Wayland window has none) instead of sending silence', () => {
        expect(sc).toContain('text: windowAudioUnresolvedNotice(window.electronAPI?.platform),');
    });
    it('a PipeWire daemon that goes away mid-share is told to the user, not swallowed as a user "stopped"', () => {
        expect(sc).toMatch(/reason === 'unavailable' \|\| reason === 'unsupported'\s*\? 'Sharing audio needs PipeWire/);
    });
    it('audio goes through the native path on Linux like Windows and macOS (Chromium is never asked for loopback)', () => {
        expect(sc).toContain('const useNativeAudio = options.audio && nativeReady;');
        expect(sc).toContain('audio: useNativeAudio ? false : (options.audio ?');
    });
});
