import { describe, it, expect } from 'vitest';
import { migrateKeybinds, mergeKeybinds } from './useKeybinds';

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
