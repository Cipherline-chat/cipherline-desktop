import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const KEYBIND_SETTINGS = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'KeybindSettings.tsx'), 'utf8');
const USE_KEYBINDS = fs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', 'useKeybinds.ts'), 'utf8');

/** The body of the keybinds:sync-global-shortcuts handler. */
function handler(): string {
    const at = MAIN.indexOf("ipcMain.handle('keybinds:sync-global-shortcuts'");
    expect(at).toBeGreaterThan(-1);
    return MAIN.slice(at, MAIN.indexOf('// Clean up global shortcuts when the app quits', at));
}

describe('global shortcut wiring in main.ts', () => {
    it('Electron\'s globalShortcut is used ONLY on the non-Wayland branch (Windows, macOS, X11 are unchanged)', () => {
        const h = handler();
        const branch = h.indexOf("if (!(process.platform === 'linux' && isNativeWaylandClient(process.env, gsOzone())))");
        expect(branch).toBeGreaterThan(-1);
        expect(h.slice(branch)).toMatch(/return \{ \.\.\.syncNativeGlobalShortcuts\(map, validated\.rejected\)/);
        // the native sync is the only place that calls register(); the Wayland path never does
        const registers = MAIN.match(/globalShortcut\.register\(/g) ?? [];
        expect(registers).toHaveLength(1);
        const wayland = MAIN.slice(MAIN.indexOf('const syncWaylandGlobalShortcuts'), MAIN.indexOf("ipcMain.handle('keybinds:sync-global-shortcuts'"));
        expect(wayland).not.toMatch(/globalShortcut\./);
        expect(wayland).toMatch(/new WaylandGlobalShortcuts\(/);
    });

    it('the Wayland path is asked of the desktop asynchronously, never with a synchronous probe', () => {
        expect(MAIN).toMatch(/const gsPortal = \(\): Promise<PortalProbeResult> => \(gsPortalProbe \?\?= probeGlobalShortcutsPortal\(\)\);/);
        const region = MAIN.slice(MAIN.indexOf('const gsOzone'), MAIN.indexOf("ipcMain.handle('keybinds:sync-global-shortcuts'"));
        expect(region).not.toMatch(/execSync|spawnSync|busctl/);
    });

    it('the feature-switch decision: no GlobalShortcutsPortal feature is appended (Chromium\'s own portal path is refused by the portal)', () => {
        expect(MAIN).not.toMatch(/enable-features[^\n]*GlobalShortcutsPortal|'GlobalShortcutsPortal'/);
        // still exactly one enable-features append (a second would drop the first list)
        expect(MAIN.match(/appendSwitch\('enable-features'/g) ?? []).toHaveLength(1);
    });

    it('the retired KGlobalAccel workaround is gone and its leftovers are cleaned up once', () => {
        expect(MAIN).not.toMatch(/kde-global-shortcuts|syncKdeGlobalShortcuts|teardownKdeGlobalShortcuts/);
        expect(fs.existsSync(path.join(__dirname, 'kde-global-shortcuts.ts'))).toBe(false);
        expect(MAIN).toMatch(/void cleanupLegacyKdeComponent\(\);/);
    });

    it('a portal press goes through the same renderer path as a native one (global-shortcut-fired)', () => {
        const h = MAIN.slice(MAIN.indexOf('const syncWaylandGlobalShortcuts'), MAIN.indexOf("ipcMain.handle('keybinds:sync-global-shortcuts'"));
        expect(h).toMatch(/noteGlobalShortcutPress\(actionId\);[^\n]*\n\s*mainWindow\?\.webContents\.send\('global-shortcut-fired', actionId\);/);
    });

    it('the sync result carries the status for Settings, and a failed action is always reported', () => {
        const h = handler();
        expect(h).toMatch(/status: \{ \.\.\.gsBaseDecision\('absent'\), desktop: gsDesktop \}/);
        // the Wayland error path reports every action it tried to bind (the stable portal map)
        expect(h).toMatch(/failed: \[\.\.\.portalMap\.rejected, \.\.\.Object\.values\(portalMap\.map\)\]/);
    });
});

describe('Settings → Keybinds shows the honest state', () => {
    it('the hook keeps the status from the sync result and exposes it', () => {
        expect(USE_KEYBINDS).toMatch(/setGlobalShortcutStatus\(readGlobalShortcutStatus\(result && result\.status\)\)/);
        expect(USE_KEYBINDS).toMatch(/failedGlobalActions,\n\s+globalShortcutStatus,/);
    });
    it('the pane renders the notice only when there is one', () => {
        expect(KEYBIND_SETTINGS).toMatch(/const globalNotice = globalShortcutNotice\(globalShortcutStatus\);/);
        expect(KEYBIND_SETTINGS).toMatch(/\{globalNotice && \(\s*<div className="sd-card" role="status" data-testid="global-shortcuts-notice">/);
    });
});
