/**
 * The window-capture fallback is wired where it must be (windowShareFallback.ts holds the logic and
 * its own tests; this pins the places that run it, which cannot be unit-tested without a real
 * Electron + LiveKit share).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const sc = read('src/components/SidebarConference.tsx');
const main = read('electron/main.ts');
const preload = read('electron/preload.ts');

describe('window-capture fallback wiring', () => {
    it('main answers the geometry only on Windows, only for a picker-offered window, never with a title', () => {
        const h = main.slice(main.indexOf("ipcMain.handle('screen-share:window-geometry'"));
        const body = h.slice(0, h.indexOf('\n  });') + 6);
        expect(body).toContain("process.platform !== 'win32'");
        expect(body).toContain("sourceId.startsWith('window:')");
        expect(body).toContain('cachedDesktopSources.some(s => s.id === sourceId)');
        expect(body).toContain('cleanWindowInfo(');
        expect(body).toContain("thumbnailSize: { width: 0, height: 0 }");
        // the follow tick's window-only form never enumerates screens
        expect(body).toContain("if (windowOnly !== true && typeof addon?.getScreenRectFromDeviceIndex === 'function') {");
        expect(body).not.toMatch(/\.name\b/);
        expect(body).toContain('return { window, screens };');
    });

    it('preload exposes it', () => {
        expect(preload).toContain("ipcRenderer.invoke('screen-share:window-geometry', sourceId, windowOnly === true)");
    });

    it('a failed ordinary capture of a window runs the ladder; anything else reports as before', () => {
        expect(sc).toContain('if (!(fallbackEligible && defaultCapturePath)) return reportShareStartError(err);');
        expect(sc).toContain('const fb = await runWindowFallback(err);');
        // the flag is set only on the ordinary getDisplayMedia path, and the resolve answer is reset for it
        const i = sc.indexOf('defaultCapturePath = true;');
        expect(i).toBeGreaterThan(-1);
        expect(sc.slice(i, i + 200)).toContain('resolveOutcomeRef.current = null;');
    });

    it('a capture that ends before its first frame is a failure, not a share of nothing', () => {
        expect(sc).toContain("if (fallbackEligible && st.how === 'ended') throw captureEndedError();");
    });

    it('the whole-screen offer keeps the window\'s audio and goes through the normal share start', () => {
        expect(sc).toContain('audioWindowId: options.sourceId');
        expect(sc).toContain("label: 'Share the whole screen instead'");
        expect(sc).toContain('republishShareRef.current?.(screenShare);');
        expect(sc).toContain('const audioSourceId = options.audioWindowId ?? options.sourceId;');
        expect(sc).toContain('await startNativeWindowAudio(nativeMode, audioSourceId, options.appAudio?.handle);');
    });

    it('the crop fallback captures the SCREEN video-only and follows the window', () => {
        expect(sc).toContain('{ ...options, sourceId: plan.screenSourceId, audio: false, layout: undefined, appAudio: null }');
        expect(sc).toContain('followWindowCrop(options.sourceId, windowCropPlan);');
        expect(sc).toMatch(/const stopCropPipeline = \(\) => \{\s*stopWindowCropFollow\(\);/);
        // screens listed once per crop session; each tick asks for the window alone
        const follow = sc.slice(sc.indexOf('const followWindowCrop = '), sc.indexOf('const stopCropPipeline = '));
        expect(follow.match(/getWindowShareGeometry!?\(windowSourceId\)/g)).toHaveLength(1);
        expect(follow).toContain('getWindowShareGeometry!(windowSourceId, true)');
    });
});
