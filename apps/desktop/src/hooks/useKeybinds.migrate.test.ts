import { describe, it, expect } from 'vitest';
import { migrateKeybinds, mergeKeybinds, migrateCameraKeybind } from './useKeybinds';

describe('keybind migration v1 (Screen Share off Ctrl+Shift+S)', () => {
    it('moves the old default to Ctrl+Shift+F9', () => {
        const out = migrateKeybinds({ 'toggle-screenshare': 'ctrl+shift+s', 'toggle-mute': 'ctrl+shift+m' }, false) as Record<string, string>;
        expect(out['toggle-screenshare']).toBe('ctrl+shift+f9');
        expect(out['toggle-mute']).toBe('ctrl+shift+m');
    });
    it('leaves it unbound rather than colliding with a combo the user already uses', () => {
        const out = migrateKeybinds({ 'toggle-screenshare': 'ctrl+shift+s', 'leave-call': 'ctrl+shift+f9' }, false) as Record<string, string>;
        expect(out['toggle-screenshare']).toBe('');
    });
    it('keeps a custom bind, and runs only once', () => {
        expect((migrateKeybinds({ 'toggle-screenshare': 'ctrl+alt+p' }, false) as Record<string, string>)['toggle-screenshare']).toBe('ctrl+alt+p');
        expect((migrateKeybinds({ 'toggle-screenshare': 'ctrl+shift+s' }, true) as Record<string, string>)['toggle-screenshare']).toBe('ctrl+shift+s');
    });
    it('a fresh install gets Ctrl+Shift+F9', () => {
        expect(mergeKeybinds(undefined)['toggle-screenshare']).toBe('ctrl+shift+f9');
    });
});

describe('migrateCameraKeybind — Ctrl+Shift+V no longer takes "paste as plain text" from every app', () => {
    it('moves the old default to the new one', () => {
        const out = migrateCameraKeybind({ 'toggle-camera': 'ctrl+shift+v', 'toggle-mute': 'ctrl+shift+m' }, false) as Record<string, string>;
        expect(out['toggle-camera']).toBe('ctrl+shift+f10');
        expect(out['toggle-mute']).toBe('ctrl+shift+m');
    });
    it('unbinds instead of colliding when the new default is already used', () => {
        const out = migrateCameraKeybind({ 'toggle-camera': 'ctrl+shift+v', 'leave-call': 'ctrl+shift+f10' }, false) as Record<string, string>;
        expect(out['toggle-camera']).not.toBe('ctrl+shift+f10');
        expect(out['leave-call']).toBe('ctrl+shift+f10');
    });
    it('negative controls: a custom bind, an already-migrated account and the screen-share rule are untouched', () => {
        expect((migrateCameraKeybind({ 'toggle-camera': 'ctrl+alt+c' }, false) as Record<string, string>)['toggle-camera']).toBe('ctrl+alt+c');
        expect((migrateCameraKeybind({ 'toggle-camera': 'ctrl+shift+v' }, true) as Record<string, string>)['toggle-camera']).toBe('ctrl+shift+v');
        expect((migrateCameraKeybind({ 'toggle-screenshare': 'ctrl+shift+s' }, false) as Record<string, string>)['toggle-screenshare']).toBe('ctrl+shift+s');
    });
    it('a new install gets the new default', () => {
        expect(mergeKeybinds({})['toggle-camera']).toBe('ctrl+shift+f10');
    });
});
