import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Audit lead desktop-preload-raw-ipcrenderer-on-callback-leaks-event-sender.
 *
 * `ipcRenderer.on(channel, cb)` calls cb(event, ...args), and `event.sender` is
 * the preload's own `ipcRenderer`. Eleven bridged subscriptions registered the
 * page's callback directly, so the page received that event (and `onReady`
 * returned `ipcRenderer.on(...)`, i.e. the ipcRenderer itself). Whether Electron's
 * contextBridge proxies `send`/`invoke` across is a runtime fact; the preload must
 * not hand the object over to find out. main.ts trusts `fs:register-resolved-path`
 * as preload-only, and that allowlist is what stops a compromised renderer from
 * encrypting and uploading an arbitrary file.
 *
 * Every subscription now registers a wrapper that drops the IpcRendererEvent, and
 * returns an unsubscribe function (or nothing), never the emitter.
 *
 * Runtime test: the real preload.ts is loaded against a fake `electron` module
 * whose ipcRenderer carries a tripwire `send`, the exposed API is driven, and the
 * arguments the page callback actually receives are inspected.
 */

type Listener = (event: unknown, ...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const sent: unknown[][] = [];
const ipcRenderer: Record<string, any> = {
    on: (channel: string, l: Listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(l);
        return ipcRenderer; // what the real one returns, and what onReady used to hand to the page
    },
    removeListener: (channel: string, l: Listener) => { listeners.get(channel)?.delete(l); return ipcRenderer; },
    send: (...a: unknown[]) => { sent.push(a); },
    invoke: async () => undefined,
    sendSync: () => undefined,
};
let exposed: Record<string, any> = {};

let api: Record<string, any>;
beforeAll(() => {
    // `electron` cannot be imported under vitest (the npm package resolves to a
    // binary downloader), so the real preload source is transpiled and run in a
    // function scope with a fake `electron` module: same code, no Electron.
    const source = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const fakeElectron = {
        contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { exposed[name] = value; } },
        ipcRenderer,
        sharedTexture: undefined,
        webUtils: undefined,
    };
    const fakeRequire = (id: string) => {
        if (id === 'electron') return fakeElectron;
        throw new Error(`unexpected require(${id}) in preload`);
    };
    const fakeWindow = { addEventListener: () => {} };
    const run = new Function('require', 'module', 'exports', 'window', 'process', 'console', js);
    run(fakeRequire, { exports: {} }, {}, fakeWindow, process, { log: () => {}, warn: () => {}, error: () => {} });
    api = exposed.electronAPI;
});

beforeEach(() => { listeners.clear(); sent.length = 0; });

/** Fire `channel` the way Electron does: handler(IpcRendererEvent, ...args), event.sender = ipcRenderer. */
function fire(channel: string, ...args: unknown[]) {
    const event = { sender: ipcRenderer, senderId: 1, ports: [] };
    for (const l of [...(listeners.get(channel) ?? [])]) l(event, ...args);
}

const NO_ARG_SUBSCRIPTIONS: Array<[string, string]> = [
    ['onTrayLock', 'tray:lock'],
    ['onTraySignOut', 'tray:sign-out'],
    ['onShowScreensharePicker', 'show-screenshare-picker'],
    ['onWindowFocus', 'window:focus'],
    ['onWindowBlur', 'window:blur'],
    ['onWindowMinimize', 'window:minimize'],
    ['onWindowHide', 'window:hide'],
    ['onBeforeQuit', 'app:before-quit'],
    ['onRendererUnresponsive', 'main:renderer-unresponsive'],
    ['onRendererResponsive', 'main:renderer-responsive'],
];

describe('preload subscriptions never hand the IpcRendererEvent to the page', () => {
    it.each(NO_ARG_SUBSCRIPTIONS)('%s: the page callback is called with NO arguments (no event, no sender)', (method, channel) => {
        const received: unknown[][] = [];
        api[method]((...a: unknown[]) => { received.push(a); });
        fire(channel);
        expect(received).toEqual([[]]);
    });

    it.each(NO_ARG_SUBSCRIPTIONS)('%s: still returns a working unsubscribe', (method, channel) => {
        const cb = vi.fn();
        const off = api[method](cb);
        expect(typeof off).toBe('function');
        fire(channel);
        expect(cb).toHaveBeenCalledTimes(1);
        off();
        fire(channel);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(listeners.get(channel)?.size ?? 0).toBe(0);
    });

    it('onReady: no event, and it no longer returns the ipcRenderer (it returns an unsubscribe)', () => {
        const received: unknown[][] = [];
        const ret = api.onReady((...a: unknown[]) => { received.push(a); });
        expect(ret).not.toBe(ipcRenderer);
        expect(typeof ret?.send).toBe('undefined');
        expect(typeof ret?.invoke).toBe('undefined');
        fire('ready');
        expect(received).toEqual([[]]);
        ret();
        fire('ready');
        expect(received).toHaveLength(1);
    });

    it('TRIPWIRE: nothing a page callback can reach on any of these subscriptions can send on the preload-private channel', () => {
        const calls: unknown[][] = [];
        const grab = (...a: unknown[]) => { calls.push(a); };
        for (const [method, channel] of NO_ARG_SUBSCRIPTIONS) { api[method](grab); fire(channel); }
        api.onReady(grab); fire('ready');
        expect(calls).toHaveLength(NO_ARG_SUBSCRIPTIONS.length + 1);
        expect(calls.every(a => a.length === 0)).toBe(true); // no event object, so no `.sender`
        expect(sent.filter(a => a[0] === 'fs:register-resolved-path')).toEqual([]);
    });

    it('CONTROL: an already-wrapped subscription still passes its payload (the wrapper drops only the event)', () => {
        const got: unknown[] = [];
        api.onNotificationClicked((conv: string) => got.push(conv));
        fire('notification:clicked', 'conv-1');
        expect(got).toEqual(['conv-1']);
    });

    it('SOURCE GUARD: no ipcRenderer.on registers a bare cb/callback parameter, and none is returned', () => {
        const src = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(src.match(/ipcRenderer\.on\(\s*'[^']+'\s*,\s*(cb|callback)\s*\)/g) ?? []).toEqual([]);
        expect(src.match(/=>\s*ipcRenderer\.on\(/g) ?? []).toEqual([]);
        expect(src.match(/return\s+ipcRenderer\.on\(/g) ?? []).toEqual([]);
    });
});
