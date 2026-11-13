import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideShareBackend, NATIVE_MIN_FPS, NATIVE_SUSTAIN_FACTOR } from './nativeShareSelect';

const both = { vaapi: true, nvenc: true };

describe('decideShareBackend', () => {
    it('flag off is ALWAYS chromium, whatever the probe says', () => {
        for (const platform of ['linux', 'win32', 'darwin']) {
            expect(decideShareBackend({ flagOn: false, platform, probe: both }).path).toBe('chromium');
        }
    });
    it('NEGATIVE: not linux, no probe, or nothing available => chromium', () => {
        expect(decideShareBackend({ flagOn: true, platform: 'win32', probe: both }).path).toBe('chromium');
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: null }).path).toBe('chromium');
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: { vaapi: false, nvenc: false } }).path).toBe('chromium');
    });
    it('on linux with the flag, nvenc wins over vaapi', () => {
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: both })).toMatchObject({ path: 'native', backend: 'nvenc' });
    });
    it('VA-API (Intel/AMD) is taken when NVENC is absent, still only behind the flag', () => {
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: { vaapi: true, nvenc: false } })).toMatchObject({ path: 'native', backend: 'vaapi' });
        expect(decideShareBackend({ flagOn: false, platform: 'linux', probe: { vaapi: true, nvenc: false } }).path).toBe('chromium');
    });
    it('the capability ceiling applies to VA-API too: a weak iGPU gets a lower rate, a hopeless one hands back to Chromium', () => {
        const va = (sustainedFps: number) => ({ vaapi: true, nvenc: false, sustainedFps });
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: va(40), wantFps: 60 })).toMatchObject({ path: 'native', backend: 'vaapi', fps: Math.floor(40 * NATIVE_SUSTAIN_FACTOR) });
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: va(20), wantFps: 60 }).path).toBe('chromium');
    });
});

describe('capability-driven fps ceiling', () => {
    const nv = (sustainedFps: number) => ({ vaapi: false, nvenc: true, sustainedFps });
    it('keeps the requested rate when the encoder sustains it with headroom', () => {
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: nv(281), wantFps: 90 })).toMatchObject({ path: 'native', fps: 90 });
    });
    it('lowers the rate to what the card sustains (never stutters at a rate it cannot hold)', () => {
        const d = decideShareBackend({ flagOn: true, platform: 'linux', probe: nv(80), wantFps: 90 });
        expect(d.path).toBe('native');
        expect(d.fps).toBe(Math.floor(80 * NATIVE_SUSTAIN_FACTOR));
        expect(d.fps).toBeLessThan(90);
    });
    it('NEGATIVE: an encoder too slow for a worthwhile rate at this size hands the share back to Chromium', () => {
        const slow = Math.floor((NATIVE_MIN_FPS - 1) / NATIVE_SUSTAIN_FACTOR);
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: nv(slow), wantFps: 60 }).path).toBe('chromium');
    });
    it('an unmeasured card is not blocked (no calibration is not a "no")', () => {
        expect(decideShareBackend({ flagOn: true, platform: 'linux', probe: { vaapi: false, nvenc: true }, wantFps: 60 })).toMatchObject({ path: 'native', fps: 60 });
    });
});

describe('the opt-out gate and fallback guarantees (source guards)', () => {
    const root = join(__dirname, '..', '..');
    const read = (p: string) => readFileSync(join(root, p), 'utf8');
    it('the preference is ON unless the user stored an explicit off, and the share flow checks it before any IPC', () => {
        expect(read('src/utils/nativeSharePrefs.ts')).toMatch(/getNativeShareEnabled\(\): boolean \{ return read\(ENABLED_KEY\) !== '0'; \}/);
        const sc = read('src/components/SidebarConference.tsx');
        const fn = sc.slice(sc.indexOf('const tryStartNativeShare = async'));
        const gate = fn.indexOf('if (!flagOn) return null;');
        expect(gate).toBeGreaterThan(0);
        expect(gate).toBeLessThan(fn.indexOf('api.available()'));
        expect(gate).toBeLessThan(fn.indexOf('api.probe('));
    });
    it('the native branch is only entered with a pipeline that started cleanly; every failure returns null (Chromium path)', () => {
        const sc = read('src/components/SidebarConference.tsx');
        expect(sc).toContain("nativePipe = await tryStartNativeShare(");
        expect(sc).toMatch(/if \(!started\.ok\) \{[\s\S]{0,400}return null;/);
        expect(sc).toMatch(/catch \(err\) \{[\s\S]{0,200}nativeFailedRef\.current = true;[\s\S]{0,300}return null;/);
    });
    it('main.ts registers the native IPC exactly once, on linux (or the lab env flag), and only when the helper exists', () => {
        const main = read('electron/main.ts');
        expect(main.match(/registerNativeShareIpc\(/g)?.length).toBe(1);
        expect(main).toMatch(/process\.platform === 'linux' \|\| isNativeShareEncoderEnabled\(\)\) \{[\s\S]{0,1800}if \(helper\) \{[\s\S]{0,200}registerNativeShareIpc\(/);
        expect(main).toContain('resolveNativeShareHelper({');
    });
    it('preload exposes window.nativeShare once, on linux (or the lab env flag) only', () => {
        const pre = read('electron/preload.ts');
        expect(pre.match(/exposeInMainWorld\('nativeShare'/g)?.length).toBe(1);
        expect(pre).toMatch(/if \(process\.platform === 'linux' \|\| process\.env\.CIPHERLINE_NATIVE_SHARE_ENCODER === '1'\) \{[\s\S]{0,300}exposeInMainWorld\('nativeShare'/);
    });
    it('the E2EE worker wrapper is installed but inert until a session is bound (see nativeShareWorker.test.ts)', () => {
        expect(read('src/workers/e2eeWorker.ts')).toContain('installNativeInjector(');
    });
    it('NEGATIVE: the pipeline refuses to run without the call\'s E2EE worker (frames are never published outside the cryptor)', () => {
        const sc = read('src/components/SidebarConference.tsx');
        expect(sc).toMatch(/if \(!worker\) \{ why\('no e2ee worker'\); return null; \}/);
    });
    it('NEGATIVE: the lighter copy cannot be published outside the cryptor - it is only requested from the worker-checked start, and is never a second publish', () => {
        const sc = read('src/components/SidebarConference.tsx');
        const start = sc.indexOf('const tryStartNativeShare');
        const guard = sc.indexOf("why('no e2ee worker')", start);
        const low = sc.indexOf('lowerLayer: getShareLowLayerEnabled() && shareHasLowerLayer(resolution', start);
        expect(guard).toBeGreaterThan(start);
        expect(low).toBeGreaterThan(guard);                                               // the copy is requested only AFTER the worker check
        // exactly one publishTrack serves the native share (both layers ride one simulcast track), and nothing else sends a low layer
        const pub = sc.slice(sc.indexOf('const publishNativeShare'), sc.indexOf('A capture or publish error'));
        expect((pub.match(/publishTrack\(/g) ?? []).length).toBe(1);
        const pipe = read('src/utils/nativeSharePipeline.ts');
        expect(pipe).not.toMatch(/publishTrack|addTrack|RTCPeerConnection\(|createEncodedStreams/);
        // the low AUs travel the same port into the worker's injector, which sits in front of LiveKit's cryptor (nativeShareWorker.ts)
        expect(read('src/utils/nativeShareWorker.ts')).toMatch(/createLayeredInjectStage/);
    });
});
