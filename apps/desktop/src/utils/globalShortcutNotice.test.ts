import { describe, it, expect } from 'vitest';
import {
    globalShortcutNotice, readGlobalShortcutStatus, globalShortcutCoverage, portalBindingNotice,
    comboToHyprlandKey, hyprlandBindLines, isHyprland, type GlobalShortcutStatus,
} from './globalShortcutNotice';
import { ACTIONS, mergeKeybinds } from '../hooks/useKeybinds';

describe('globalShortcutNotice (the Settings → Keybinds line)', () => {
    it('Wayland without the portal says so, names the desktop, and says what still works', () => {
        const t = globalShortcutNotice({ mode: 'unavailable', reason: 'wayland-no-portal', desktop: 'GNOME' });
        expect(t).toContain("Global shortcuts aren't available on this desktop; they work while Cipherline is focused.");
        expect(t).toContain('GNOME on Wayland');
    });
    it('each failure reason has its own explanation', () => {
        const base = { mode: 'unavailable' as const, desktop: '' };
        expect(globalShortcutNotice({ ...base, reason: 'wayland-portal-unanswered' })).toContain('did not answer');
        expect(globalShortcutNotice({ ...base, reason: 'wayland-portal-declined' })).toContain('not granted');
        expect(globalShortcutNotice({ ...base, reason: 'wayland-portal-error' })).toContain('refused');
        expect(globalShortcutNotice({ ...base, reason: 'something-new' })).toContain('does not offer');
    });
    it('negative controls: nothing is shown when shortcuts work, or when main has not answered', () => {
        expect(globalShortcutNotice({ mode: 'native', reason: 'x11', desktop: 'KDE' })).toBeNull();
        expect(globalShortcutNotice({ mode: 'native', reason: 'native-os', desktop: '' })).toBeNull();
        expect(globalShortcutNotice({ mode: 'portal', reason: 'wayland-portal', desktop: 'KDE' })).toBeNull();
        expect(globalShortcutNotice(null)).toBeNull();
        expect(globalShortcutNotice(undefined)).toBeNull();
    });
});

describe('readGlobalShortcutStatus (the IPC result is data, not trusted)', () => {
    it('reads a well-formed status', () => {
        expect(readGlobalShortcutStatus({ mode: 'unavailable', reason: 'wayland-no-portal', desktop: 'KDE' })).toEqual({ mode: 'unavailable', reason: 'wayland-no-portal', desktop: 'KDE' });
    });
    it('older main (no status) and malformed values are "unknown"', () => {
        expect(readGlobalShortcutStatus(undefined)).toBeNull();
        expect(readGlobalShortcutStatus('unavailable')).toBeNull();
        expect(readGlobalShortcutStatus({ mode: 'bogus' })).toBeNull();
        expect(readGlobalShortcutStatus({ mode: 'native' })).toEqual({ mode: 'native', reason: '', desktop: '' });
    });
    it('bounds the strings it keeps', () => {
        const s = readGlobalShortcutStatus({ mode: 'unavailable', reason: 'x'.repeat(500), desktop: 'y'.repeat(500) });
        expect(s?.reason.length).toBe(40);
        expect(s?.desktop.length).toBe(24);
    });
});

const hypr = (bound: string[], notBound: string[]): GlobalShortcutStatus => ({
    mode: 'portal', reason: 'wayland-portal', desktop: 'Hyprland', appId: 'chat.cipherline.Cipherline', portal: { bound, notBound },
});
const label = (id: string) => ACTIONS.find((a) => a.id === id)?.label ?? id;

describe('portalBindingNotice: the portal answered, but did it assign keys?', () => {
    it('Hyprland with nothing bound says so plainly and asks for hyprland.conf lines', () => {
        const n = portalBindingNotice(hypr([], ['toggle-mute', 'leave-call']), label);
        expect(n?.title).toBe('System-wide shortcuts are not set up');
        expect(n?.text).toContain('Hyprland on Wayland accepted');
        expect(n?.text).toContain('assigned no keys');
        expect(n?.text).toContain('only work while Cipherline is focused');
        expect(n?.hyprland).toBe(true);
        expect(n?.hyprlandIds).toEqual(['toggle-mute', 'leave-call']);
    });
    it('a partial bind names both groups', () => {
        const n = portalBindingNotice({ ...hypr(['toggle-mute'], ['leave-call']), desktop: 'GNOME' }, label);
        expect(n?.title).toBe('Some shortcuts are not system-wide');
        expect(n?.text).toContain('assigned keys for Mute / Unmute');
        expect(n?.text).toContain('Leave Call only works while Cipherline is focused');
        expect(n?.hyprland).toBe(false);
    });
    it('negative controls: everything bound, no portal result, native and unavailable sessions say nothing here', () => {
        expect(portalBindingNotice(hypr(['toggle-mute'], []), label)).toBeNull();
        expect(portalBindingNotice({ mode: 'portal', reason: 'wayland-portal', desktop: 'KDE' }, label)).toBeNull();
        expect(portalBindingNotice({ mode: 'native', reason: 'x11', desktop: 'KDE' }, label)).toBeNull();
        expect(portalBindingNotice({ mode: 'unavailable', reason: 'wayland-no-portal', desktop: 'KDE' }, label)).toBeNull();
        expect(portalBindingNotice(null, label)).toBeNull();
    });
});

describe('globalShortcutCoverage drives the "Work even when Cipherline is in the background" hint', () => {
    it('none / some / all / unknown', () => {
        expect(globalShortcutCoverage(hypr([], ['a-b']))).toBe('none');
        expect(globalShortcutCoverage(hypr(['x'], ['a-b']))).toBe('some');
        expect(globalShortcutCoverage(hypr(['x'], []))).toBe('all');
        expect(globalShortcutCoverage({ mode: 'unavailable', reason: 'wayland-no-portal', desktop: '' })).toBe('none');
        expect(globalShortcutCoverage({ mode: 'native', reason: 'x11', desktop: '' })).toBe('all');
        expect(globalShortcutCoverage({ mode: 'portal', reason: 'wayland-portal', desktop: '' })).toBe('unknown');
        expect(globalShortcutCoverage(null)).toBe('unknown');
    });
});

describe('readGlobalShortcutStatus: the portal result is data, not trusted', () => {
    it('reads portal ids and the app id', () => {
        const s = readGlobalShortcutStatus({ mode: 'portal', reason: 'wayland-portal', desktop: 'Hyprland', appId: 'chat.cipherline.Cipherline', portal: { bound: [], notBound: ['toggle-mute'] } });
        expect(s?.portal).toEqual({ bound: [], notBound: ['toggle-mute'] });
        expect(s?.appId).toBe('chat.cipherline.Cipherline');
    });
    it('drops a malformed portal block and an app id that could carry config text', () => {
        const s = readGlobalShortcutStatus({ mode: 'portal', reason: '', desktop: '', appId: 'x\nexec = rm -rf', portal: { bound: ['ok'], notBound: ['has space'] } });
        expect(s?.portal).toBeUndefined();
        expect(s?.appId).toBeUndefined();
    });
});

describe('Hyprland bind lines: bind = MODS, KEY, global, <appid>:<shortcut-id>', () => {
    it('converts our combos', () => {
        expect(comboToHyprlandKey('ctrl+shift+m')).toEqual({ mods: 'CTRL SHIFT', key: 'M' });
        expect(comboToHyprlandKey('f9')).toEqual({ mods: '', key: 'F9' });
        expect(comboToHyprlandKey('ctrl+alt+,')).toEqual({ mods: 'CTRL ALT', key: 'comma' });
        expect(comboToHyprlandKey('ctrl+space')).toEqual({ mods: 'CTRL', key: 'space' });
        expect(comboToHyprlandKey('ctrl+arrowup')).toEqual({ mods: 'CTRL', key: 'Up' });
    });
    it('negative controls: keys outside the portal vocabulary produce no line', () => {
        expect(comboToHyprlandKey('ctrl+enter')).toBeNull();
        expect(comboToHyprlandKey('meta+m')).toBeNull();
        expect(hyprlandBindLines([{ id: 'x', combo: 'ctrl+enter' }], 'a.b')).toEqual([]);
    });
    it('builds one line per shortcut with the registered app id', () => {
        expect(hyprlandBindLines([
            { id: 'toggle-mute', combo: 'ctrl+shift+m' },
            { id: 'leave-call', combo: 'ctrl+shift+l' },
        ], 'chat.cipherline.Cipherline')).toEqual([
            'bind = CTRL SHIFT, M, global, chat.cipherline.Cipherline:toggle-mute',
            'bind = CTRL SHIFT, L, global, chat.cipherline.Cipherline:leave-call',
        ]);
    });
    it('every default global shortcut yields a line (the defaults are all expressible), and isHyprland is exact', () => {
        const defaults = mergeKeybinds(null);
        const globals = ACTIONS.filter((a) => a.global && defaults[a.id]);
        expect(globals.length).toBeGreaterThan(0);
        for (const a of globals) {
            expect(comboToHyprlandKey(defaults[a.id] as string), `${a.id} (${defaults[a.id]})`).not.toBeNull();
        }
        expect(isHyprland('Hyprland')).toBe(true);
        expect(isHyprland('GNOME')).toBe(false);
    });
});

describe('the desktop kept a different key (KDE keeps the first key it accepted for a shortcut)', () => {
    const kde = (portal: GlobalShortcutStatus['portal']): GlobalShortcutStatus => ({ mode: 'portal', reason: 'wayland-portal', desktop: 'KDE', portal });
    const labelOf = (id: string) => ACTIONS.find((a) => a.id === id)?.label ?? id;

    it('reads desktopKeys and elsewhere from the IPC result, dropping anything malformed', () => {
        const s = readGlobalShortcutStatus({ mode: 'portal', reason: 'wayland-portal', desktop: 'KDE',
            portal: { bound: ['toggle-camera'], notBound: [], elsewhere: ['toggle-camera'], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+F10', 'bad id!': 'x', 'leave-call': 7, 'toggle-mute': 'x'.repeat(80) } } });
        expect(s?.portal).toEqual({ bound: ['toggle-camera'], notBound: [], elsewhere: ['toggle-camera'], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+F10' } });
    });

    it('every key bound, but the camera on another one: names the live key and where to change it', () => {
        const n = portalBindingNotice(kde({ bound: ['toggle-camera', 'toggle-mute'], notBound: [], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+F10', 'toggle-mute': 'Ctrl+Shift+M' }, elsewhere: ['toggle-camera'] }), labelOf);
        expect(n?.title).toBe('One shortcut uses a different key system-wide');
        expect(n?.text).toContain('KDE on Wayland kept the key it was first given for Camera On / Off (Ctrl+Shift+F10)');
        expect(n?.text).toContain("Change it in your desktop's shortcut settings");
        expect(n?.elsewhere).toEqual(['toggle-camera']);
    });

    it('a shortcut the desktop has no key for points at the desktop settings (a Cancel / cleared key is remembered)', () => {
        const n = portalBindingNotice(kde({ bound: ['toggle-mute'], notBound: ['toggle-camera'] }), labelOf);
        expect(n?.text).toContain('Camera On / Off only works while Cipherline is focused');
        expect(n?.text).toContain("Set it in your desktop's shortcut settings");
    });

    it('controls: matching keys say nothing; Hyprland keeps its own wording', () => {
        expect(portalBindingNotice(kde({ bound: ['toggle-camera'], notBound: [], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+F10' }, elsewhere: [] }), labelOf)).toBeNull();
        const h = portalBindingNotice({ mode: 'portal', reason: 'wayland-portal', desktop: 'Hyprland', portal: { bound: ['toggle-mute'], notBound: ['toggle-camera'] } }, labelOf);
        expect(h?.text).not.toContain('desktop settings');
    });
});
