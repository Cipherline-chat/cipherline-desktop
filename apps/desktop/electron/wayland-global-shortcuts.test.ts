import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    acceleratorToPortalTrigger, buildPortalShortcuts, boundActionIds, boundTriggers, triggerMatches, buildDesktopEntry, ensureDesktopEntry,
    WaylandGlobalShortcuts, ignoredKeyChanges, PORTAL_APP_ID, type PortalSessionBus,
} from './wayland-global-shortcuts';

describe('acceleratorToPortalTrigger', () => {
    it('maps the keybind vocabulary (the defaults leave-call / toggle-camera first)', () => {
        expect(acceleratorToPortalTrigger('CmdOrCtrl+Shift+H')).toBe('CTRL+SHIFT+H');
        expect(acceleratorToPortalTrigger('CmdOrCtrl+Shift+V')).toBe('CTRL+SHIFT+V');
        expect(acceleratorToPortalTrigger('F9')).toBe('F9');
        expect(acceleratorToPortalTrigger('Alt+Space')).toBe('ALT+space');
        expect(acceleratorToPortalTrigger('Ctrl+Alt+.')).toBe('CTRL+ALT+period');
        expect(acceleratorToPortalTrigger('Shift+Up')).toBe('SHIFT+Up');
    });
    it('refuses what it cannot express instead of guessing', () => {
        expect(acceleratorToPortalTrigger('Super+H')).toBeNull();
        expect(acceleratorToPortalTrigger('Ctrl+PrintScreen')).toBeNull();
        expect(acceleratorToPortalTrigger('F99')).toBeNull();
    });
});

describe('buildPortalShortcuts', () => {
    it('keys the portal shortcut by the action id and reports skipped ones', () => {
        const { specs, skipped } = buildPortalShortcuts({ 'CmdOrCtrl+Shift+H': 'leave-call', 'Super+X': 'lock-screen' });
        expect(specs).toEqual([{ id: 'leave-call', description: 'Leave call', trigger: 'CTRL+SHIFT+H' }]);
        expect(skipped).toEqual(['lock-screen']);
    });
});

describe('boundActionIds', () => {
    it('lists the shortcuts the portal echoed with a trigger; a cleared one is not bound', () => {
        const body = [0, { shortcuts: [['a', { trigger_description: 'Ctrl+Shift+H' }], ['b', { trigger_description: '' }]] }];
        expect(boundActionIds(body)).toEqual(['a']);
    });
    it('a cancelled dialog (non-zero response) is null, not an empty grant', () => {
        expect(boundActionIds([1, {}])).toBeNull();
        expect(boundActionIds([2, {}])).toBeNull();
        expect(boundActionIds('nonsense')).toBeNull();
        expect(boundActionIds([0, {}])).toEqual([]);
    });
});

describe('desktop entry', () => {
    it('is hidden, launches the given binary, and quotes it', () => {
        const e = buildDesktopEntry('/opt/Cipher line/$x"y');
        expect(e).toContain('NoDisplay=true');
        expect(e).toContain('Exec="/opt/Cipher line/\\$x\\"y" %U');
    });
    it('is written once under the user data dir and never overwrites', () => {
        const files = new Map<string, string>();
        const fsApi = {
            existsSync: (p: string) => files.has(p),
            mkdirSync: () => undefined,
            writeFileSync: (p: string, c: string) => { files.set(p, c); },
        } as never;
        const env = { HOME: '/home/u', XDG_DATA_DIRS: '/usr/share' };
        expect(ensureDesktopEntry('/opt/cl/cipherline', env, fsApi)).toBe(true);
        const key = `/home/u/.local/share/applications/${PORTAL_APP_ID}.desktop`;
        expect(files.get(key)).toContain('/opt/cl/cipherline');
        files.set(key, 'USER EDIT');
        expect(ensureDesktopEntry('/opt/other', env, fsApi)).toBe(true);
        expect(files.get(key)).toBe('USER EDIT');
    });
    it('a package-installed entry under XDG_DATA_DIRS is respected (nothing written)', () => {
        const write = vi.fn();
        const fsApi = { existsSync: (p: string) => p === `/usr/share/applications/${PORTAL_APP_ID}.desktop`, mkdirSync: vi.fn(), writeFileSync: write } as never;
        expect(ensureDesktopEntry('/x', { HOME: '/h', XDG_DATA_DIRS: '/usr/share' }, fsApi)).toBe(true);
        expect(write).not.toHaveBeenCalled();
    });
    it('a read-only home reports false and does not throw', () => {
        const fsApi = { existsSync: () => false, mkdirSync: () => { throw new Error('EROFS'); }, writeFileSync: vi.fn() } as never;
        expect(ensureDesktopEntry('/x', { HOME: '/h' }, fsApi)).toBe(false);
    });
});

type Msg = { path?: string; interface?: string; member?: string; body?: unknown };

/** A fake session bus that answers like xdg-desktop-portal does. */
function fakePortal(opts: { registerError?: string; bindCode?: number; bindOnly?: string[]; createCode?: number; desktopKey?: Record<string, string> } = {}) {
    const listeners = new Set<(m: Msg) => void>();
    const calls: Array<{ member: string; body: unknown[]; path: string }> = [];
    let n = 0;
    const emit = (m: Msg) => { for (const l of [...listeners]) l(m); };
    const bus: PortalSessionBus = {
        uniqueName: async () => ':1.77',
        addMatch: () => undefined,
        onMessage: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        close: () => undefined,
        invoke: async (msg) => {
            const member = String(msg.member);
            const body = (msg.body ?? []) as unknown[];
            calls.push({ member, body, path: String(msg.path) });
            if (member === 'Register') {
                if (opts.registerError) throw new Error(opts.registerError);
                return undefined;
            }
            const optsList = (member === 'CreateSession' ? body[0] : body[3]) as Array<[string, [string, string]]> | undefined;
            const token = optsList?.find((e) => e[0] === 'handle_token')?.[1][1];
            if (member === 'CreateSession') {
                const session = `/org/freedesktop/portal/desktop/session/1_77/s${++n}`;
                setTimeout(() => emit({ path: `/org/freedesktop/portal/desktop/request/1_77/${token}`, interface: 'org.freedesktop.portal.Request', member: 'Response', body: [opts.createCode ?? 0, { session_handle: session }] }), 0);
            } else if (member === 'BindShortcuts') {
                const shortcuts = (body[1] as Array<[string, unknown]>).filter((s) => !opts.bindOnly || opts.bindOnly.includes(s[0]))
                    // like a desktop on first bind: it reports the key it was asked for, unless told otherwise
                    .map((s) => {
                        const pref = ((s[1] as Array<[string, [string, string]]>).find((e) => e[0] === 'preferred_trigger')?.[1][1] ?? '');
                        const human = pref.split('+').map((p) => (p.length > 1 && !/^F\d+$/.test(p) ? p[0] + p.slice(1).toLowerCase() : p)).join('+');
                        return [s[0], { trigger_description: opts.desktopKey?.[s[0]] ?? human }];
                    });
                setTimeout(() => emit({ path: `/org/freedesktop/portal/desktop/request/1_77/${token}`, interface: 'org.freedesktop.portal.Request', member: 'Response', body: [opts.bindCode ?? 0, { shortcuts }] }), 0);
            }
            return undefined;
        },
    };
    return { bus, calls, emit };
}

describe('WaylandGlobalShortcuts', () => {
    const specs = [
        { id: 'leave-call', description: 'Leave call', trigger: 'CTRL+SHIFT+H' },
        { id: 'toggle-camera', description: 'Camera on / off', trigger: 'CTRL+SHIFT+V' },
    ];

    it('registers the app id, opens a session, binds, and fires leave-call / toggle-camera on Activated', async () => {
        const p = fakePortal();
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        const r = await w.sync(specs);
        expect(r).toMatchObject({ ok: true, granted: ['leave-call', 'toggle-camera'], denied: [] });
        expect(p.calls.map((c) => c.member)).toEqual(['Register', 'CreateSession', 'BindShortcuts']);
        expect(p.calls[0].body[0]).toBe(PORTAL_APP_ID);
        const session = p.calls[2].body[0] as string;
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [session, 'leave-call', 1n, {}] });
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [session, 'toggle-camera', 2n, {}] });
        expect(fired).toEqual(['leave-call', 'toggle-camera']);
    });

    it('ignores Activated for another session, an id we never registered, and the Deactivated signal', async () => {
        const p = fakePortal({ bindOnly: ['leave-call'] });
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        const r = await w.sync(specs);
        expect(r).toMatchObject({ ok: true, granted: ['leave-call'], denied: ['toggle-camera'] });
        const session = p.calls[2].body[0] as string;
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: ['/other/session', 'leave-call', 1n, {}] });
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [session, 'some-other-action', 1n, {}] });
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Deactivated', body: [session, 'leave-call', 1n, {}] });
        expect(fired).toEqual([]);
    });

    it('a shortcut the desktop did not assign a key to still fires when the compositor activates it (Hyprland: bound 0, user binds it in hyprland.conf)', async () => {
        const p = fakePortal({ bindOnly: [] });
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        const r = await w.sync(specs);
        expect(r).toMatchObject({ ok: true, granted: [], denied: ['leave-call', 'toggle-camera'] });
        const session = p.calls[2].body[0] as string;
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [session, 'toggle-camera', 1n, {}] });
        expect(fired).toEqual(['toggle-camera']);
    });

    it('a changed map closes the old session and binds in a new one (registers the app id only once)', async () => {
        const p = fakePortal();
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        await w.sync(specs);
        const first = p.calls[2].body[0] as string;
        await w.sync([specs[0]]);
        expect(p.calls.map((c) => c.member)).toEqual(['Register', 'CreateSession', 'BindShortcuts', 'Close', 'CreateSession', 'BindShortcuts']);
        expect(p.calls[3].path).toBe(first);
        // the old session's press is dead; toggle-camera is no longer bound
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [first, 'leave-call', 1n, {}] });
        const second = p.calls[5].body[0] as string;
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [second, 'toggle-camera', 1n, {}] });
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [second, 'leave-call', 1n, {}] });
        expect(fired).toEqual(['leave-call']);
    });

    it('an empty map closes the session and binds nothing', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        await w.sync(specs);
        expect(await w.sync([])).toEqual({ ok: true, granted: [], denied: [] });
        expect(p.calls.at(-1)?.member).toBe('Close');
    });

    it('a cancelled permission dialog is "declined", and nothing fires afterwards', async () => {
        const p = fakePortal({ bindCode: 1 });
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        expect(await w.sync(specs)).toEqual({ ok: false, reason: 'declined' });
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [p.calls[2].body[0], 'leave-call', 1n, {}] });
        expect(fired).toEqual([]);
    });

    it('a portal that cannot name the app (Register fails) is an error, not a silent success', async () => {
        const p = fakePortal({ registerError: 'App info not found for chat.cipherline.Cipherline' });
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined, PORTAL_APP_ID, () => undefined);
        expect(await w.sync(specs)).toEqual({ ok: false, reason: 'error' });
        expect(p.calls.map((c) => c.member)).toEqual(['Register']);
    });

    it('CreateSession refused is an error', async () => {
        const p = fakePortal({ createCode: 2 });
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined, PORTAL_APP_ID, () => undefined);
        expect(await w.sync(specs)).toEqual({ ok: false, reason: 'error' });
    });

    it('no session bus: unavailable, never throws', async () => {
        const w = new WaylandGlobalShortcuts(() => null, () => undefined);
        expect(await w.sync(specs)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('dispose closes the session', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        await w.sync(specs);
        await w.dispose();
        expect(p.calls.at(-1)?.member).toBe('Close');
    });
});

describe('Wayland: one stable portal set, drawing-request pair bound permanently (no desktop dialog per draw request)', () => {
    // Linux VM matrix 2026-11-09, staging.213: GNOME 50 re-showed "Add Keyboard Shortcuts" over the share on every
    // draw request (Cancel dropped ALL global shortcuts); KDE 6.8 showed "Global Shortcuts Requested: Allow drawing
    // request". Owner 2026-11-10: bind the pair permanently on Wayland.
    const base = { 'CmdOrCtrl+Shift+H': 'leave-call', 'CmdOrCtrl+Shift+M': 'toggle-mute' };
    const full = { ...base, 'CmdOrCtrl+Shift+Y': 'approve-annotation-request', 'CmdOrCtrl+Shift+N': 'decline-annotation-request' };

    it('the pair is an ordinary portal shortcut (described, bound)', () => {
        const { specs, skipped } = buildPortalShortcuts(full);
        expect(skipped).toEqual([]);
        expect(specs.map((x) => x.id)).toEqual(['leave-call', 'toggle-mute', 'approve-annotation-request', 'decline-annotation-request']);
        expect(specs.find((x) => x.id === 'approve-annotation-request')?.description).toBe('Allow drawing request');
    });

    it('an identical sync is a no-op: no Close / CreateSession / BindShortcuts, same answer', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        const r1 = await w.sync(buildPortalShortcuts(full).specs);
        const n = p.calls.length;
        const r2 = await w.sync(buildPortalShortcuts({ ...full }).specs);
        expect(p.calls.length).toBe(n);
        expect(r2).toEqual(r1);
    });

    it('a press of the pair is delivered (the renderer decides whether a request is waiting)', async () => {
        const p = fakePortal();
        const fired: string[] = [];
        const w = new WaylandGlobalShortcuts(() => p.bus, (id) => fired.push(id));
        await w.sync(buildPortalShortcuts(full).specs);
        const session = p.calls.find((c) => c.member === 'BindShortcuts')!.body[0] as string;
        p.emit({ interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: [session, 'approve-annotation-request', 1n, {}] });
        expect(fired).toEqual(['approve-annotation-request']);
    });

    it('control: a REAL change (the user rebinds a key) still opens a new session', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        await w.sync(buildPortalShortcuts(base).specs);
        await w.sync(buildPortalShortcuts({ 'CmdOrCtrl+Shift+J': 'leave-call', 'CmdOrCtrl+Shift+M': 'toggle-mute' }).specs);
        expect(p.calls.map((c) => c.member)).toEqual(['Register', 'CreateSession', 'BindShortcuts', 'Close', 'CreateSession', 'BindShortcuts']);
    });

    it('a declined dialog is not cached: the next sync asks again', async () => {
        const p = fakePortal({ bindCode: 1 });
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        const specs = buildPortalShortcuts(base).specs;
        expect(await w.sync(specs)).toEqual({ ok: false, reason: 'declined' });
        const n = p.calls.length;
        await w.sync(specs);
        expect(p.calls.length).toBeGreaterThan(n);
    });

    it('main wires it: the Wayland path binds the validated portalMap; the native path keeps the armed map', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const i = main.indexOf("ipcMain.handle('keybinds:sync-global-shortcuts'");
        const body = main.slice(i, i + 2600);
        expect(body).toMatch(/async \(_event, rawMap: unknown, rawPortalMap\?: unknown\)/);
        expect(body).toMatch(/validateGlobalShortcutMap\(rawPortalMap\)/);
        expect(body).toMatch(/syncWaylandGlobalShortcuts\(portalMap\.map, portalMap\.rejected\)/);
        expect(body).toMatch(/syncNativeGlobalShortcuts\(map, validated\.rejected\)/);
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain("ipcRenderer.invoke('keybinds:sync-global-shortcuts', map, portalMap)");
    });
});

describe('the key the desktop really bound (KDE keeps the first one it accepted)', () => {
    // Arch KDE Plasma 6.8, 2026-11-10: toggle-camera accepted as Ctrl+Shift+F10, then BindShortcuts asked for
    // Ctrl+Shift+V -> "bound", no dialog, trigger_description "Ctrl+Shift+F10", and Ctrl+Shift+V did nothing.
    it('boundTriggers reads trigger_description per id (non-empty only)', () => {
        expect(boundTriggers([0, { shortcuts: [['toggle-camera', { trigger_description: 'Ctrl+Shift+F10' }], ['leave-call', { trigger_description: '' }]] }]))
            .toEqual({ 'toggle-camera': 'Ctrl+Shift+F10' });
        expect(boundTriggers([1, {}])).toEqual({});
    });

    it('triggerMatches: same key in any modifier order / spelling is a match', () => {
        expect(triggerMatches('CTRL+SHIFT+F10', 'Ctrl+Shift+F10')).toBe(true);
        expect(triggerMatches('CTRL+SHIFT+F10', 'Shift+Ctrl+F10')).toBe(true);
        expect(triggerMatches('CTRL+SHIFT+M', 'Control+Shift+M')).toBe(true);
        expect(triggerMatches('CTRL+SHIFT+F10', 'Ctrl+Shift+F10, Meta+C')).toBe(true);
    });

    it('triggerMatches: a different key is a mismatch', () => {
        expect(triggerMatches('CTRL+SHIFT+V', 'Ctrl+Shift+F10')).toBe(false);
        expect(triggerMatches('CTRL+SHIFT+F10', 'Ctrl+F10')).toBe(false);
    });

    it('triggerMatches: never claims a mismatch it cannot read (translated / symbol descriptions)', () => {
        expect(triggerMatches('CTRL+SHIFT+F10', 'Strg+Umschalt+F10')).toBeNull();
        expect(triggerMatches('CTRL+SHIFT+F10', '⌃⇧F10')).toBeNull();
    });

    it('sync reports the desktop keys and which shortcuts are bound ELSEWHERE than asked', async () => {
        const p = fakePortal({ desktopKey: { 'toggle-camera': 'Ctrl+Shift+F10' } });
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        const r = await w.sync([
            { id: 'leave-call', description: 'Leave call', trigger: 'CTRL+SHIFT+H' },
            { id: 'toggle-camera', description: 'Camera on / off', trigger: 'CTRL+SHIFT+V' },
        ]);
        expect(r).toEqual({ ok: true, granted: ['leave-call', 'toggle-camera'], denied: [],
            triggers: { 'leave-call': 'Ctrl+Shift+H', 'toggle-camera': 'Ctrl+Shift+F10' }, elsewhere: ['toggle-camera'], ignoredChanges: [] });
    });

    it('control: the desktop bound what we asked -> nothing "elsewhere"', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        const r = await w.sync([{ id: 'toggle-camera', description: 'Camera on / off', trigger: 'CTRL+SHIFT+F10' }]);
        expect(r).toMatchObject({ ok: true, elsewhere: [] });
    });

    it('configure() opens the desktop settings for the open session; false with no session', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        expect(await w.configure()).toBe(false);
        await w.sync([{ id: 'toggle-camera', description: 'Camera on / off', trigger: 'CTRL+SHIFT+F10' }]);
        expect(await w.configure()).toBe(true);
        const call = p.calls.find((c) => c.member === 'ConfigureShortcuts')!;
        expect(call.body[0]).toBe(p.calls.find((c) => c.member === 'BindShortcuts')!.body[0]);
    });

    it('main exposes it to the renderer behind the trusted-sender check', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const i = main.indexOf("ipcMain.handle('keybinds:configure-desktop-shortcuts'");
        expect(i).toBeGreaterThan(-1);
        expect(main.slice(i, i + 300)).toMatch(/if \(!isTrustedSender\(event\)\) return false;\s*return \(await waylandShortcuts\?\.configure\(\)\) \?\? false;/);
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain("configureDesktopShortcuts: (): Promise<boolean> => ipcRenderer.invoke('keybinds:configure-desktop-shortcuts')");
    });
});

describe('a key the user changed that the desktop ignores (no prompt, old key stays)', () => {
    const cam = (trigger: string) => [{ id: 'toggle-camera', description: 'Camera on / off', trigger }];

    it('ignoredKeyChanges: only a changed trigger the desktop bound elsewhere counts', () => {
        const prev = new Map([['toggle-camera', 'CTRL+SHIFT+F10']]);
        expect(ignoredKeyChanges(prev, cam('CTRL+SHIFT+V'), ['toggle-camera'])).toEqual(['toggle-camera']);
        // control: the desktop adopted the new key
        expect(ignoredKeyChanges(prev, cam('CTRL+SHIFT+V'), [])).toEqual([]);
        // control: unchanged key, desktop still elsewhere (the standing notice, not a new prompt)
        expect(ignoredKeyChanges(prev, cam('CTRL+SHIFT+F10'), ['toggle-camera'])).toEqual([]);
        // startup: nothing asked before
        expect(ignoredKeyChanges(new Map(), cam('CTRL+SHIFT+V'), ['toggle-camera'])).toEqual([]);
    });

    it('startup bind never reports a change; a later change the desktop keeps ignoring is reported once', async () => {
        const p = fakePortal({ desktopKey: { 'toggle-camera': 'Ctrl+Shift+F10' } });
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        const first = await w.sync(cam('CTRL+SHIFT+F10'));
        expect(first).toMatchObject({ ok: true, ignoredChanges: [] });
        const changed = await w.sync(cam('CTRL+SHIFT+V'));
        expect(changed).toMatchObject({ ok: true, elsewhere: ['toggle-camera'], ignoredChanges: ['toggle-camera'] });
        // BindShortcuts is asked again for the changed key (a fresh session each time)
        expect(p.calls.filter((c) => c.member === 'BindShortcuts')).toHaveLength(2);
        // identical re-sync (cached) must not re-trigger
        expect(await w.sync(cam('CTRL+SHIFT+V'))).toMatchObject({ ok: true, ignoredChanges: [] });
    });

    it('a desktop that adopts the new key reports no ignored change', async () => {
        const p = fakePortal();
        const w = new WaylandGlobalShortcuts(() => p.bus, () => undefined);
        await w.sync(cam('CTRL+SHIFT+F10'));
        expect(await w.sync(cam('CTRL+SHIFT+V'))).toMatchObject({ ok: true, ignoredChanges: [] });
    });

    it('main opens the desktop shortcut settings on an ignored change, only from the sync path', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toMatch(/setup\.ok && \(setup\.ignoredChanges\?\.length \?\? 0\) > 0\) \{\s*void waylandShortcuts\.configure\(\)/);
    });
});
