/**
 * Wiring and contract checks for the X11 annotation overlay's run-time compositor check and window
 * shares: that the pieces are actually connected (main -> preload -> renderer for the "ended" report,
 * the helper's X11 modes, the harness), and that the helper keeps the properties the design rests on
 * (libX11 dlopen()ed only, read-only queries, no new link-time or licence-restricted dependency).
 * The helper against a real X server and the real Electron overlay: harness/wayland-annotation/run.sh x11.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.resolve(root, ...p), 'utf8');
const OVERLAY = read('electron', 'annotation-overlay.ts');
const MAIN = read('electron', 'main.ts');
const PRELOAD = read('electron', 'preload.ts');
const ENV_D = read('src', 'env.d.ts');
const RENDERER = read('src', 'utils', 'desktopAnnotationOverlay.ts');
const PROBE_INC = read('src-native', 'wayland_overlay', 'x11_probe.inc');
const HELPER_C = read('src-native', 'wayland_overlay', 'cl_wayland_overlay.c');
const ABI = read('harness', 'wayland-annotation', 'check-x11-abi.sh');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PROBE_CODE = strip(PROBE_INC);

describe('compositor check: main -> renderer', () => {
    it('the precheck asks the helper at run time (only where it applies) and passes the answer to the verdict', () => {
        expect(OVERLAY).toMatch(/if \(!shouldProbeX11Compositor\(process\.env\) \|\| isNativeWaylandClient\(process\.env, ozonePlatform\)\) return decide\(null\);/);
        expect(OVERLAY).toMatch(/return probe\.get\(\)\.then\(decide\);/);
        // asynchronous only: a synchronous child process on the main thread is banned (main-thread-blockers.test.ts)
        expect(OVERLAY).toMatch(/execFile\(bin, \['--x11-probe'\], \{ env: waylandHelperEnv\(\), timeout: 1500/);
        expect(strip(OVERLAY)).not.toMatch(/\b(spawnSync|execFileSync|execSync)\b/);
        expect(OVERLAY).not.toMatch(/execFile\([^)]*shell:\s*true/);
        // the IPC handler waits for it before looking the source up
        expect(MAIN).toMatch(/const pre = await annotationOverlayPrecheck\(kind\);/);
    });

    it('a screen overlay is watched while it is up, and a window overlay is driven by the same watcher', () => {
        expect(OVERLAY).toMatch(/if \(!createOverlay\(display\.bounds, true\)\) return refuse\('create_failed'\);\s*watchCompositorForScreen\(\);/);
        expect(OVERLAY).toMatch(/spawn\(bin, \['--x11-watch'\], \{ stdio: \['pipe', 'pipe', 'ignore'\], env: waylandHelperEnv\(\) \}\)/);
        expect(OVERLAY).toMatch(/if \(kind === 'window'\) return process\.platform === 'linux' \? showForX11Window\(source\) : showForWindow\(source\);/);
        expect(OVERLAY).toMatch(/if \(process\.platform === 'linux'\) \{ trackX11Window\(\); return; \}/);
    });

    it('losing the compositor takes the overlay down FIRST, then tells the renderer; hide stops the watcher', () => {
        expect(OVERLAY).toMatch(/hideAnnotationOverlay\(\);\s*endedListener\?\.\('no_compositor'\);/);
        expect(OVERLAY).toMatch(/export function hideAnnotationOverlay\(\): void \{[\s\S]*?stopX11Watcher\(\);/);
        expect(OVERLAY).toMatch(/win\.on\('closed', \(\) => \{[\s\S]*?stopX11Watcher\(\);/);
    });

    it('main forwards it to the main window only, the preload exposes a payload-less subscription, the renderer type has it', () => {
        expect(MAIN).toMatch(/setAnnotationOverlayEndedListener\(\(reason\) => \{[\s\S]*?mainWindow\.webContents\.send\('annot-overlay:ended', reason\)/);
        expect(PRELOAD).toContain("onAnnotationOverlayEnded: (callback: () => void): (() => void) => subscribeNoArgs('annot-overlay:ended', callback)");
        expect(ENV_D).toContain('onAnnotationOverlayEnded?: (callback: () => void) => () => void;');
    });

    it('the renderer reports it like a refusal (status off + one call event), forgets what it showed, and asks again on the next stroke', () => {
        expect(RENDERER).toMatch(/unsubscribeEnded = window\.electronAPI\.onAnnotationOverlayEnded\?\.\(onOverlayEndedByMain\) \?\? null;/);
        const fn = /export function onOverlayEndedByMain\(\): void \{[\s\S]*?\n\}/.exec(RENDERER)![0];
        expect(fn).toContain('shown = false;');
        expect(fn).toContain("setStatus({ kind: 'off', reason: 'no_compositor' });");
        expect(fn).toContain("logCallEvent('annot_overlay', { result: 'ended', reason: 'no_compositor'");
        expect(fn).toContain('retryAt = Date.now() + REFUSED_RETRY_MS;');
        expect(RENDERER).toMatch(/function stop\(\): void \{\s*unsubscribeEnded\?\.\(\);/);
    });

    it('the X11 window share is only for a real X11 session; Wayland / portal window shares stay refused', () => {
        expect(OVERLAY).toMatch(/&& !\(process\.platform === 'linux' && x11WindowShareAllowed\(process\.env, safeSwitch\('ozone-platform'\)\)\)\) return refuse\('platform'\)/);
    });
});

describe('helper: plain-X11 modes', () => {
    it('are dispatched before anything touches Wayland', () => {
        const main = HELPER_C.slice(HELPER_C.indexOf('int main('));
        expect(main.indexOf('--x11-probe')).toBeGreaterThan(-1);
        expect(main.indexOf('--x11-watch')).toBeGreaterThan(-1);
        expect(main.indexOf('--x11-probe')).toBeLessThan(main.indexOf('load_wayland()'));
        expect(main.indexOf('--x11-watch')).toBeLessThan(main.indexOf('load_wayland()'));
        expect(HELPER_C).toContain('#include "x11_probe.inc"');
    });

    it('libX11 is dlopen()ed, never linked, and the probe needs nothing else (no Xext / Xrandr / XFixes)', () => {
        expect(PROBE_CODE).toContain('dlopen("libX11.so.6"');
        expect(PROBE_CODE).not.toMatch(/dlopen\("(?!libX11\.so\.6)/);
        expect(PROBE_CODE).not.toMatch(/#include\s*<X11/);
    });

    it('is read-only on the X server: no window is created, moved, mapped or selected', () => {
        for (const call of ['XCreateWindow', 'XMapWindow', 'XMapRaised', 'XMoveWindow', 'XResizeWindow', 'XDestroyWindow', 'XSelectInput', 'XChangeProperty', 'XSetSelectionOwner', 'XSendEvent', 'XKillClient', 'XGrabPointer']) {
            expect(PROBE_CODE).not.toContain(call);
        }
        expect(PROBE_CODE).toContain('XGetSelectionOwner');
        expect(PROBE_CODE).toContain('XGetWindowAttributes');
        expect(PROBE_CODE).toContain('XTranslateCoordinates');
    });

    it('asks the real signal: the _NET_WM_CM_S<screen> selection', () => {
        expect(PROBE_CODE).toContain('"_NET_WM_CM_S%d"');
    });

    it('every hand-declared struct / constant the probe uses is asserted against the real headers', () => {
        for (const needle of ['XWindowAttributes', 'map_state', 'IsViewable == CX_IS_VIEWABLE', 'XA_ATOM == CX_XA_ATOM', 'XA_CARDINAL == CX_XA_CARDINAL']) {
            expect(ABI).toContain(needle);
        }
    });

    it('no new dependency: the helper target still links libc/libm/libdl only', () => {
        const gyp = read('binding.gyp');
        expect(gyp).toContain('"libraries": [ "-ldl", "-lm" ]');
    });
});

describe('harness', () => {
    const RUN = read('harness', 'wayland-annotation', 'run.sh');
    it('the x11 stage is wired into run.sh (helper-level and the real Electron overlay)', () => {
        expect(RUN).toContain('lab/run-x11.sh');
        expect(RUN).toContain('lab/run-x11-electron.sh');
        expect(fs.existsSync(path.resolve(root, 'harness', 'wayland-annotation', 'lab', 'x11-overlay-main.ts'))).toBe(true);
    });
});
