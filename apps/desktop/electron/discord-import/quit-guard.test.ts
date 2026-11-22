import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUIT_PROMPT, createQuitGuard, shouldAskBeforeClose } from './quit-guard';
import { createDiscordImportHandlers, registerDiscordImportIpc, DISCORD_IMPORT_CHANNELS } from './ipc';

const store = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, delete: (k: string) => { m.delete(k); } }; };

describe('quit guard: "An import is running — quit anyway?"', () => {
    it('nothing running: quits at once, no dialog', async () => {
        const ask = vi.fn();
        const g = createQuitGuard(ask);
        expect(await g.confirmQuit()).toBe(true);
        expect(ask).not.toHaveBeenCalled();
    });
    it('running: asks with the owner\'s words; Keep importing stays, Quit anyway goes', async () => {
        const ask = vi.fn().mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
        const g = createQuitGuard(ask);
        g.setRunning(true);
        expect(await g.confirmQuit()).toBe(false);
        expect(await g.confirmQuit()).toBe(true);
        expect(ask.mock.calls[0][0]).toBe(QUIT_PROMPT);
        expect(QUIT_PROMPT.message).toBe('An import is running — quit anyway?');
        expect(QUIT_PROMPT.detail).toBe('It will stop and what’s copied stays.');
        expect(QUIT_PROMPT.buttons).toEqual(['Keep importing', 'Quit anyway']);
        expect(QUIT_PROMPT.cancelId).toBe(0);            // Esc / closing the dialog = keep importing
    });
    it('one question at a time; a dialog that fails never traps the user', async () => {
        let answer!: (v: { response: number }) => void;
        const ask = vi.fn(() => new Promise<{ response: number }>(r => { answer = r; }));
        const g = createQuitGuard(ask);
        g.setRunning(true);
        const a = g.confirmQuit(); const b = g.confirmQuit();
        expect(ask).toHaveBeenCalledTimes(1);
        answer({ response: 1 });
        expect(await a).toBe(true); expect(await b).toBe(true);
        const g2 = createQuitGuard(() => Promise.reject(new Error('no display')));
        g2.setRunning(true);
        expect(await g2.confirmQuit()).toBe(true);
    });
    it('the window close asks only for a real close while running', () => {
        const base = { isQuitting: false, hidesToTray: false, importRunning: true, confirmed: false };
        expect(shouldAskBeforeClose(base)).toBe(true);
        expect(shouldAskBeforeClose({ ...base, hidesToTray: true })).toBe(false);   // hidden to the tray: it keeps going
        expect(shouldAskBeforeClose({ ...base, isQuitting: true })).toBe(false);    // tray Quit already asked
        expect(shouldAskBeforeClose({ ...base, confirmed: true })).toBe(false);
        expect(shouldAskBeforeClose({ ...base, importRunning: false })).toBe(false);
    });
});

describe('IPC discord-import:running', () => {
    it('strict payload: { running: boolean } only', async () => {
        const seen: boolean[] = [];
        const h = createDiscordImportHandlers({ store: store(), onRunningChange: (r) => seen.push(r) });
        expect(await h.setRunning({ running: true })).toEqual({ ok: true });
        expect(await h.setRunning({ running: false })).toEqual({ ok: true });
        for (const bad of [null, true, { running: 'yes' }, { running: 1 }, { running: true, extra: 1 }, [], Object.create({ running: true })]) {
            expect((await h.setRunning(bad)).ok).toBe(false);
        }
        expect(seen).toEqual([true, false]);
    });
    it('is registered on its channel', async () => {
        const channels = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
        const seen: boolean[] = [];
        registerDiscordImportIpc({ handle: (c, l) => { channels.set(c, l); } }, { store: store(), onRunningChange: (r) => seen.push(r) });
        expect(DISCORD_IMPORT_CHANNELS.running).toBe('discord-import:running');
        await channels.get('discord-import:running')!({}, { running: true });
        expect(seen).toEqual([true]);
    });
});

describe('main / tray / preload wiring (source)', () => {
    const MAIN = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const TRAY = readFileSync(join(__dirname, '..', 'tray.ts'), 'utf8');
    const PRELOAD = readFileSync(join(__dirname, '..', 'preload.ts'), 'utf8');
    it('the renderer report reaches the guard', () => {
        expect(MAIN).toMatch(/registerDiscordImportIpc\(ipcMain, \{ store: secureStore, onRunningChange: \(running\) => discordImportQuitGuard\.setRunning\(running\) \}\)/);
        expect(PRELOAD).toContain("setRunning: (running: boolean) => ipcRenderer.invoke('discord-import:running', { running })");
    });
    it('the window close asks (never from before-quit), and only re-closes after "Quit anyway"', () => {
        const close = MAIN.slice(MAIN.indexOf("mainWindow.on('close', (e) => {"));
        const body = close.slice(0, close.indexOf('\n  });'));
        expect(body).toContain('shouldAskBeforeClose({ isQuitting, hidesToTray, importRunning: discordImportQuitGuard.isRunning(), confirmed: closeConfirmedWhileImporting })');
        expect(body).toMatch(/e\.preventDefault\(\);[\s\S]*confirmQuit\(\)\.then\(\(go\) => \{\s*if \(!go[^\n]*return;\s*closeConfirmedWhileImporting = true;\s*win\.close\(\);/);
        for (const m of MAIN.matchAll(/app\.on\('before-quit'[\s\S]*?\n\}\);|app\.on\('before-quit'[^\n]*\n/g)) expect(m[0]).not.toContain('confirmQuit');
    });
    it('the tray Quit asks first and quits only on yes', () => {
        expect(MAIN).toContain('setTrayQuitConfirm(() => discordImportQuitGuard.confirmQuit());');
        expect(TRAY).toMatch(/label: 'Quit Cipherline',[\s\S]*?if \(!trayQuitConfirm\) \{ quit\(\); return; \}[\s\S]*?trayQuitConfirm\(\)\.then\(\(go\) => \{ if \(go\) quit\(\); \}/);
    });
    it('a renderer reload / crash clears the flag (no stale prompt)', () => {
        expect(MAIN).toContain('const importWc = mainWindow.webContents;');
        expect(MAIN).toContain("importWc.on('did-navigate', () => discordImportQuitGuard.setRunning(false));");
        expect(MAIN).toContain("importWc.on('render-process-gone', () => discordImportQuitGuard.setRunning(false));");
    });
});
