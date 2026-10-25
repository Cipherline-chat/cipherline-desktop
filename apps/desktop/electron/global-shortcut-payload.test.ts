import { describe, it, expect } from 'vitest';
import { isSafeGlobalAccelerator, validateGlobalShortcutMap } from './global-shortcut-payload';

describe('global shortcuts must not claim plain typing keys system-wide (E-10)', () => {
    it('refuses bare keys, Shift-only chords and reserved system chords', () => {
        for (const a of ['A', 'M', 'Space', 'Escape', 'Up', '1', ',', 'Shift+A', 'Shift+Space',
            'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+Z', 'CmdOrCtrl+A', 'Alt+Tab', 'Alt+F4', 'CmdOrCtrl+Shift+Z']) {
            expect(isSafeGlobalAccelerator(a), a).toBe(false);
        }
    });

    it('a hostile map of bare keys registers nothing and reports every entry as failed', () => {
        const v = validateGlobalShortcutMap({ A: 'toggle-mute', Space: 'toggle-deafen', 'CmdOrCtrl+C': 'leave-call' });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.map).toEqual({});
        expect(v.rejected.sort()).toEqual(['leave-call', 'toggle-deafen', 'toggle-mute']);
    });

    it('positive control: the shipped defaults and ordinary custom chords still register', () => {
        for (const a of ['CmdOrCtrl+Shift+M', 'CmdOrCtrl+Shift+D', 'CmdOrCtrl+Shift+V', 'CmdOrCtrl+Shift+F9', 'CmdOrCtrl+Shift+H',
            'CmdOrCtrl+Shift+Q', 'CmdOrCtrl+Shift+L', 'CmdOrCtrl+Shift+Y', 'Alt+M', 'CmdOrCtrl+Alt+Up', 'F8', 'Shift+F13', 'Alt+F5']) {
            expect(isSafeGlobalAccelerator(a), a).toBe(true);
        }
        const v = validateGlobalShortcutMap({ 'CmdOrCtrl+Shift+M': 'toggle-mute', F9: 'toggle-deafen' });
        expect(v.ok && v.map).toEqual({ 'CmdOrCtrl+Shift+M': 'toggle-mute', F9: 'toggle-deafen' });
    });

    it('never claims Save As (Ctrl+Shift+S) system-wide', () => {
        expect(isSafeGlobalAccelerator('CmdOrCtrl+Shift+S')).toBe(false);
    });
});
