import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const MAIN = read('main.ts');
const PRELOAD = read('preload.ts');
const NATIVE = readFileSync(join(__dirname, '../src-native/key_state.cc'), 'utf8');

describe('system-wide push-to-talk wiring', () => {
    it('main owns the watcher, trusts only its own renderer, and stops it on quit', () => {
        expect(MAIN).toContain("from './global-ptt'");
        const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('hold-key:set'"));
        expect(h.slice(0, 300)).toContain('isTrustedSender(event)');
        expect(MAIN).toContain("webContents.send('hold-key:state', slot, down)");
        expect(MAIN).toMatch(/app\.on\('will-quit', \(\) => \{ globalHold\.stop\(\); holdElevation\.setRunning\(false\); \}\)/);
    });

    it('the dry-run and diagnostics handlers trust only our renderer too', () => {
        for (const ch of ["ipcMain.handle('hold-key:check'", "ipcMain.handle('hold-key:diagnostics'"]) {
            const h = MAIN.slice(MAIN.indexOf(ch));
            expect(MAIN.indexOf(ch), ch).toBeGreaterThan(0);
            expect(h.slice(0, 200)).toContain('isTrustedSender(event)');
        }
    });

    it('the elevated-foreground monitor runs only on Windows while a native watch is active', () => {
        expect(MAIN).toContain("process.platform === 'win32' && globalHold.watchingNatively");
        expect(MAIN).toContain("webContents.send('hold-key:elevation', blocked)");
    });

    it('main hands the addon to the watcher lazily (it loads after app.whenReady)', () => {
        expect(MAIN).toMatch(/new GlobalHoldKeyWatcher\(\s*\(\) => audioCaptureAddon,/);
    });

    it('the preload bridge exposes the PTT calls (set, state, check, elevation, diagnostics)', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('hold-key:set', slot, combo)");
        expect(PRELOAD).toContain("ipcRenderer.on('hold-key:state', wrapped)");
        expect(PRELOAD).toContain("ipcRenderer.invoke('hold-key:check', combo)");
        expect(PRELOAD).toContain("ipcRenderer.on('hold-key:elevation', wrapped)");
        expect(PRELOAD).toContain("ipcRenderer.invoke('hold-key:diagnostics')");
    });

    it('native: mouse buttons and elevation stay read-only polls (no hook, no input injection)', () => {
        expect(NATIVE).toContain('VK_XBUTTON1');
        expect(NATIVE).toContain('XIQueryPointer');
        expect(NATIVE).toContain('MapVirtualKeyExW');
        expect(NATIVE).toContain('getForegroundElevation');
        // The foreground probe is cached per pid (and our own token read once): no OpenProcess/OpenProcessToken on someone else's
        // process every 1.5 s tick, which behavioural engines read as token reconnaissance.
        const fn = NATIVE.slice(NATIVE.indexOf('napi_value GetForegroundElevation'));
        expect(fn).toContain('kForegroundCacheMs');
        expect(fn.indexOf('pid == g_fgPid')).toBeGreaterThan(-1);
        expect(fn.indexOf('pid == g_fgPid')).toBeLessThan(fn.indexOf('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION'));
        expect(fn).toContain('if (!g_selfRead)');
        expect(NATIVE).not.toMatch(/SendInput\s*\(|XTestFake|XIGrabDevice\s*\(|XGrabPointer\s*\(/);
    });

    it('does not import from src/ (the electron rootDir trap)', () => {
        expect(read('global-ptt.ts')).not.toMatch(/from '\.\.\/src/);
    });

    it('the native watcher is in the build and registered by the Windows addon', () => {
        expect(readFileSync(join(__dirname, '../binding.gyp'), 'utf8')).toContain('src-native/key_state.cc');
        expect(readFileSync(join(__dirname, '../src-native/audio_capture.cc'), 'utf8')).toContain('RegisterKeyState(env, exports);');
    });

    it('Wayland: portal release (Deactivated) is delivered as the hold key being let go, and the Linux addon registers the watcher', () => {
        const wl = read('wayland-global-shortcuts.ts');
        expect(wl).toContain("m.member !== 'Deactivated'");
        expect(wl).toContain('this.onReleased(body[1])');
        expect(MAIN).toContain('specs.push(...holdPortalSpecs())');
        expect(readFileSync(join(__dirname, '../src-native/audio_capture_linux.cc'), 'utf8')).toContain('RegisterKeyState(env, exports);');
    });

    it('the native watcher polls (never a hook or a key grab that could swallow a key) and watches at most 4 groups', () => {
        expect(NATIVE).toContain('GetAsyncKeyState');
        expect(NATIVE).toContain('XQueryKeymap');
        expect(NATIVE).not.toMatch(/XGrabKey\s*\(/);
        expect(NATIVE).not.toMatch(/SetWindowsHookEx\w*\s*\(/);
        expect(NATIVE).toContain('kMaxGroups = 4');
    });
});
