import { describe, it, expect } from 'vitest';
import { decideGlobalShortcutMode, statusAfterPortalSetup, sanitizeDesktopName, withPortalResult, type PortalProbeResult } from './global-shortcut-mode';

const WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' };
const X11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };

describe('decideGlobalShortcutMode: which way a global key is delivered on this session', () => {
    it('Windows and macOS are always native, whatever the portal probe says', () => {
        for (const platform of ['win32', 'darwin']) {
            for (const portal of ['present', 'absent', 'unknown'] as PortalProbeResult[]) {
                expect(decideGlobalShortcutMode(platform, {}, '', portal)).toEqual({ mode: 'native', reason: 'native-os' });
            }
        }
    });

    it('Windows / macOS ignore a Wayland-looking environment (it is not theirs to read)', () => {
        expect(decideGlobalShortcutMode('win32', WAYLAND, '', 'absent').mode).toBe('native');
        expect(decideGlobalShortcutMode('darwin', WAYLAND, 'wayland', 'absent').mode).toBe('native');
    });

    it('Linux X11 is native (XGrabKey through globalShortcut), with or without a portal', () => {
        expect(decideGlobalShortcutMode('linux', X11, '', 'absent')).toEqual({ mode: 'native', reason: 'x11' });
        expect(decideGlobalShortcutMode('linux', X11, '', 'present')).toEqual({ mode: 'native', reason: 'x11' });
        expect(decideGlobalShortcutMode('linux', {}, '', 'unknown')).toEqual({ mode: 'native', reason: 'x11' });
    });

    it('a Wayland desktop session forced onto the X11 backend (--ozone-platform=x11) is an X11 client: native', () => {
        expect(decideGlobalShortcutMode('linux', WAYLAND, 'x11', 'absent')).toEqual({ mode: 'native', reason: 'x11' });
    });

    it('Wayland + the GlobalShortcuts portal: portal', () => {
        expect(decideGlobalShortcutMode('linux', WAYLAND, '', 'present')).toEqual({ mode: 'portal', reason: 'wayland-portal' });
        expect(decideGlobalShortcutMode('linux', WAYLAND, 'wayland', 'present').mode).toBe('portal');
        expect(decideGlobalShortcutMode('linux', { XDG_SESSION_TYPE: 'wayland' }, '', 'present').mode).toBe('portal');
    });

    it('Wayland with no portal: unavailable, with the reason', () => {
        expect(decideGlobalShortcutMode('linux', WAYLAND, '', 'absent')).toEqual({ mode: 'unavailable', reason: 'wayland-no-portal' });
    });

    it('Wayland and the portal did not answer in time: unavailable (never assume it works), with its own reason', () => {
        expect(decideGlobalShortcutMode('linux', WAYLAND, '', 'unknown')).toEqual({ mode: 'unavailable', reason: 'wayland-portal-unanswered' });
    });

    it('negative control: a portal present on an X11 session never flips it to the portal path', () => {
        expect(decideGlobalShortcutMode('linux', X11, '', 'present').mode).not.toBe('portal');
    });
});

describe('statusAfterPortalSetup: the decision corrected by what the portal actually did', () => {
    const portal = { mode: 'portal', reason: 'wayland-portal' } as const;
    it('a successful setup keeps the portal status', () => {
        expect(statusAfterPortalSetup(portal, { ok: true })).toEqual(portal);
    });
    it('a cancelled permission dialog becomes unavailable / declined', () => {
        expect(statusAfterPortalSetup(portal, { ok: false, reason: 'declined' })).toEqual({ mode: 'unavailable', reason: 'wayland-portal-declined' });
    });
    it('a portal that errors becomes unavailable / error', () => {
        expect(statusAfterPortalSetup(portal, { ok: false, reason: 'error' })).toEqual({ mode: 'unavailable', reason: 'wayland-portal-error' });
        expect(statusAfterPortalSetup(portal, { ok: false, reason: 'unavailable' }).mode).toBe('unavailable');
    });
    it('negative control: a native session is never downgraded by a portal failure it never used', () => {
        const native = { mode: 'native', reason: 'x11' } as const;
        expect(statusAfterPortalSetup(native, { ok: false, reason: 'error' })).toEqual(native);
    });
});

describe('sanitizeDesktopName', () => {
    it('keeps the first desktop, letters only', () => {
        expect(sanitizeDesktopName('KDE')).toBe('KDE');
        expect(sanitizeDesktopName('ubuntu:GNOME')).toBe('ubuntu');
        expect(sanitizeDesktopName('X-Cinnamon')).toBe('X-Cinnamon');
        expect(sanitizeDesktopName(undefined)).toBe('');
        expect(sanitizeDesktopName('KDE<script>1</script>')).toBe('KDEscriptscript');
        expect(sanitizeDesktopName('a'.repeat(100)).length).toBe(24);
    });
});

describe('withPortalResult: the status carries what the desktop really bound (Hyprland: bound 0, not granted 7)', () => {
    const portalStatus = { mode: 'portal' as const, reason: 'wayland-portal' as const, desktop: 'Hyprland' };
    it('records bound and not-bound action ids and the app id', () => {
        const out = withPortalResult(portalStatus, { ok: true, granted: [], denied: ['toggle-mute', 'leave-call'] }, 'chat.cipherline.Cipherline');
        expect(out.portal).toEqual({ bound: [], notBound: ['toggle-mute', 'leave-call'], desktopKeys: {}, elsewhere: [] });
        expect(out.appId).toBe('chat.cipherline.Cipherline');
        expect(out.mode).toBe('portal');
    });
    it('a partial bind keeps both lists', () => {
        const out = withPortalResult(portalStatus, { ok: true, granted: ['toggle-mute'], denied: ['leave-call'] }, 'x.y');
        expect(out.portal).toEqual({ bound: ['toggle-mute'], notBound: ['leave-call'], desktopKeys: {}, elsewhere: [] });
    });
    it('carries the desktop\'s own key names and the shortcuts it bound to a different key (KDE keeps the first)', () => {
        const out = withPortalResult(portalStatus, { ok: true, granted: ['toggle-camera'], denied: [], triggers: { 'toggle-camera': 'Ctrl+Shift+F10' }, elsewhere: ['toggle-camera'] }, 'x.y');
        expect(out.portal).toEqual({ bound: ['toggle-camera'], notBound: [], desktopKeys: { 'toggle-camera': 'Ctrl+Shift+F10' }, elsewhere: ['toggle-camera'] });
    });
    it('negative controls: a failed setup, or a non-portal status, is returned untouched', () => {
        expect(withPortalResult(portalStatus, { ok: false }, 'x.y')).toBe(portalStatus);
        const native = { mode: 'native' as const, reason: 'x11' as const, desktop: 'KDE' };
        expect(withPortalResult(native, { ok: true, granted: ['a'], denied: [] }, 'x.y')).toBe(native);
    });
});
