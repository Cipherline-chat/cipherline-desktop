import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createCaptureConsent, type ConsentPrompt } from './capture-consent';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';
import { describeForeground } from './share-foreground';

/**
 * Quick Screen Share targets the window that was in front at the key press.
 * main.ts cannot run under vitest, so these read it: the decisions are tested
 * in quick-share-foreground.test.ts and src/utils/quickShareTarget.test.ts;
 * this proves main reads the foreground in the shortcut callback (not later,
 * not from the renderer), validates against its own source list, and that the
 * quick path adds no consent dialog.
 */
const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');
const MAIN = read('electron', 'main.ts');
const PRELOAD = read('electron', 'preload.ts');
const NATIVE = read('src-native', 'share_power.cc');
const SIDEBAR = read('src', 'components', 'SidebarConference.tsx');

/** From `start` to the first line that is exactly `end` (a closing brace at that indent). */
function slice(src: string, start: string, end: string): string {
    const i = src.indexOf(start);
    expect(i, `missing: ${start}`).toBeGreaterThanOrEqual(0);
    const j = src.indexOf(end, i);
    expect(j, `unterminated: ${start}`).toBeGreaterThan(i);
    return src.slice(i, j);
}

describe('main captures the foreground window at shortcut time', () => {
    const press = slice(MAIN, 'function noteGlobalShortcutPress(', '\n}\n');

    it('the helper notes presence, then (quick share only) reads the addon and stores it', () => {
        expect(press).toContain('captureConsent.notePresence(null)');
        expect(press).toContain("actionId !== 'quick-screenshare'");
        expect(press).toContain("process.platform === 'win32'");
        expect(press).toContain('audioCaptureAddon.getForegroundInfo()');
        expect(press).toContain('quickShareForeground.capture(raw)');
        // a throwing / missing addon still OVERWRITES the capture (no stale window)
        expect(press.indexOf('quickShareForeground.capture(raw)')).toBeGreaterThan(press.indexOf('catch'));
    });

    it('both shortcut paths (Electron globalShortcut and KDE) call it BEFORE telling the renderer', () => {
        const calls = MAIN.match(/noteGlobalShortcutPress\(actionId\);[^\n]*\n\s*mainWindow\?\.webContents\.send\('global-shortcut-fired', actionId\);/g);
        expect(calls?.length).toBe(2);
        // and neither path still calls notePresence on its own (that would skip the capture)
        const sync = slice(MAIN, "ipcMain.handle('keybinds:sync-global-shortcuts'", "app.on('will-quit'");
        expect(sync).not.toContain('captureConsent.notePresence');
    });

    it('the foreground is read in the main process, never taken from the renderer', () => {
        const h = slice(MAIN, "ipcMain.handle('share:quick-share-foreground'", '\n  });\n');
        expect(h).toContain("ipcMain.handle('share:quick-share-foreground', async (): Promise<string | null> =>");   // no parameters
        expect(h).not.toMatch(/\(_?event|_?sourceId|_?hwnd/);
        expect(h).toContain('quickShareForeground.take()');
        expect(PRELOAD).toContain("getQuickShareForegroundSource: (): Promise<string | null> =>\n        ipcRenderer.invoke('share:quick-share-foreground')");
    });

    it('the id handed back is validated against main\'s own window list and admitted to the source cache', () => {
        const h = slice(MAIN, "ipcMain.handle('share:quick-share-foreground'", '\n  });\n');
        expect(h).toContain('hasForegroundCandidate(fg)');
        expect(h).toContain("desktopSources.request({ types: ['window']");
        expect(h).toContain('resolveForegroundSource(fg, sources)');
        expect(h.indexOf('resolveForegroundSource(fg, sources)')).toBeLessThan(h.indexOf('cachedDesktopSources = sources'));
        // a failure falls back (null), never throws a half answer
        expect(h).toContain('return null;');
    });

    it('the channel goes through the sender guard like every other handler', () => {
        expect(UNGUARDED_IPC_CHANNELS.has('share:quick-share-foreground')).toBe(false);
        expect(MAIN.indexOf("ipcMain.handle('share:quick-share-foreground'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('the renderer never receives the handle: share:get-foreground-info drops fgWindow', () => {
        const info = describeForeground({
            raw: { notificationState: 'QUNS_BUSY', fgExe: 'a.exe', fgWindow: '123456', fgCoversMonitor: false, fgIsCipherline: false, fgMonitor: null },
            sourceId: null, sharedScreenRect: null, displayCount: 1,
        });
        expect(info).not.toBeNull();
        expect(JSON.stringify(info)).not.toContain('123456');
        expect(MAIN).not.toMatch(/send\([^)]*fgWindow/);
    });

    it('logs carry no window titles or program names for this feature', () => {
        const mine = slice(MAIN, "ipcMain.handle('share:quick-share-foreground'", '\n  });\n');
        expect(mine).not.toMatch(/console\.\w+\([^)]*(\.name|exe|title)/);
        expect(SIDEBAR).toContain('console.log(`[quick-screenshare] target=${picked.why}`)');
    });
});

describe('the addon exposes the root window, ABI-compatibly', () => {
    it('getForegroundInfo adds fgWindow (decimal string, "" for none/shell) inside the _WIN32 block', () => {
        const fn = slice(NATIVE, 'napi_value GetForegroundInfo(', '\nnapi_value GetWindowExe(');
        expect(fn).toContain('GetAncestor(fg, GA_ROOT)');
        expect(fn).toContain('SetString(env, obj, "fgWindow", fgWindow)');
        expect(fn.indexOf('#ifdef _WIN32')).toBeLessThan(fn.indexOf('"fgWindow"'));
        expect(fn.indexOf('"fgWindow"')).toBeLessThan(fn.indexOf('#else'));
        // existing fields untouched
        for (const f of ['"fgExe"', '"fgCoversMonitor"', '"fgIsCipherline"', '"fgMonitor"', '"notificationState"']) expect(fn).toContain(f);
    });
});

describe('the quick path stays dialog-free (capture-consent treats the shortcut as trusted input)', () => {
    const WIN = 1;
    const WINDOW = { id: 'window:2222:0', name: 'Some Editor' };
    function setup() {
        let t = 1_000_000;
        const prompts: ConsentPrompt[] = [];
        const c = createCaptureConsent({ confirm: async (p) => { prompts.push(p); return false; }, now: () => t });
        return { c, prompts, advance: (ms: number) => { t += ms; } };
    }

    it('shortcut press -> mint (as handleScreenShareSelect does) -> video resolve -> audio start: no native dialog', async () => {
        const { c, prompts } = setup();
        c.notePresence(null); // noteGlobalShortcutPress
        const m = c.mint(WIN, WINDOW.id, true);
        expect(m.ok && m.trusted).toBe(true);
        if (!m.ok) return;
        const v = await c.authorizeVideo(WIN, m.token, WINDOW, true);
        expect(v).toMatchObject({ allowed: true, via: 'grant' });
        const a = await c.authorizeAudio(WIN, m.token, sid => sid === WINDOW.id, { kind: 'audio-app', name: WINDOW.name });
        expect(a).toMatchObject({ allowed: true, via: 'grant' });
        expect(prompts).toHaveLength(0);
    });

    it('control: the same mint with NO shortcut press and no input is untrusted and DOES ask', async () => {
        const { c, prompts } = setup();
        const m = c.mint(WIN, WINDOW.id, true);
        expect(m.ok && m.trusted).toBe(false);
        if (!m.ok) return;
        const v = await c.authorizeVideo(WIN, m.token, WINDOW, true);
        expect(v.allowed).toBe(false);
        expect(prompts).toHaveLength(1);
    });

    it('the quick path mints through the ordinary grant helper (handleScreenShareSelect), not a bypass', () => {
        expect(SIDEBAR).toContain('shareGrantRef.current = await mintCaptureGrant(o.sourceId, o.audio);');
        const quick = slice(SIDEBAR, "'keybind:quick-screenshare':", "const listener = (e: Event)");
        expect(quick).toContain('await handleScreenShareSelect({');
        expect(quick).toContain('audio:       true');
    });
});
