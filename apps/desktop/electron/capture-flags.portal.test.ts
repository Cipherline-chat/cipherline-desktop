import { describe, it, expect } from 'vitest';
import { capturesViaPortal, portalRestoreMode } from './capture-flags';

describe('capturesViaPortal', () => {
    it('is a native Wayland client on Linux', () => {
        expect(capturesViaPortal('linux', { XDG_SESSION_TYPE: 'wayland' }, '')).toBe(true);
        expect(capturesViaPortal('linux', { WAYLAND_DISPLAY: 'wayland-0' }, '')).toBe(true);
        expect(capturesViaPortal('linux', { XDG_SESSION_TYPE: 'x11' }, 'wayland')).toBe(true);
    });
    it('is not X11, XWayland-forced or an unset session', () => {
        expect(capturesViaPortal('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, '')).toBe(false);
        expect(capturesViaPortal('linux', { XDG_SESSION_TYPE: 'wayland' }, 'x11')).toBe(false);
        expect(capturesViaPortal('linux', {}, '')).toBe(false);
    });
    it('is never true off Linux, even with Wayland variables set', () => {
        for (const platform of ['win32', 'darwin']) {
            expect(capturesViaPortal(platform, { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }, 'wayland')).toBe(false);
        }
    });
});

describe('portalRestoreMode', () => {
    it('is listed only where it was measured (GNOME, KDE Plasma), in any of the XDG_CURRENT_DESKTOP spellings', () => {
        for (const d of ['GNOME', 'ubuntu:GNOME', 'GNOME-Classic:GNOME', 'gnome', 'KDE', 'kde', 'plasma:KDE']) {
            expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: d }), d).toBe('listed');
        }
    });
    it('is single on wlroots, X11-less / unknown desktops: unmeasured means the one-capture path', () => {
        for (const d of ['sway:wlroots', 'Hyprland', 'COSMIC', 'X-Cinnamon', 'XFCE', '']) {
            expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: d }), d).toBe('single');
        }
        expect(portalRestoreMode({})).toBe('single');
    });
    it('CIPHERLINE_PORTAL_RESTORE overrides either way', () => {
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'sway', CIPHERLINE_PORTAL_RESTORE: 'on' })).toBe('listed');
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'sway', CIPHERLINE_PORTAL_RESTORE: '1' })).toBe('listed');
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'KDE', CIPHERLINE_PORTAL_RESTORE: 'off' })).toBe('single');
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'GNOME', CIPHERLINE_PORTAL_RESTORE: 'off' })).toBe('single');
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'GNOME', CIPHERLINE_PORTAL_RESTORE: '0' })).toBe('single');
        // anything else is not an override
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'sway', CIPHERLINE_PORTAL_RESTORE: 'maybe' })).toBe('single');
        expect(portalRestoreMode({ XDG_CURRENT_DESKTOP: 'KDE', CIPHERLINE_PORTAL_RESTORE: 'maybe' })).toBe('listed');
    });
});
