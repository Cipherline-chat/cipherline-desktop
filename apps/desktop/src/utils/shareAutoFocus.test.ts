import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldAutoFocusWatchedShare } from './shareAutoFocus';

describe('shouldAutoFocusWatchedShare', () => {
    it('the Surround share from report f38097d5 (3840x720) opens on the stage', () => {
        expect(shouldAutoFocusWatchedShare({ width: 3840, height: 720, hasFocus: false })).toBe(true);
    });
    it('ordinary shapes, including 21:9 cinema (2.37), keep today\'s behaviour', () => {
        expect(shouldAutoFocusWatchedShare({ width: 1920, height: 1080, hasFocus: false })).toBe(false);
        expect(shouldAutoFocusWatchedShare({ width: 3440, height: 1440, hasFocus: false })).toBe(false);
        expect(shouldAutoFocusWatchedShare({ width: 1080, height: 1920, hasFocus: false })).toBe(false);
    });
    it('never overrides something the viewer already focused', () => {
        expect(shouldAutoFocusWatchedShare({ width: 3840, height: 720, hasFocus: true })).toBe(false);
    });
    it('unknown or zero dimensions never focus', () => {
        expect(shouldAutoFocusWatchedShare({ width: undefined, height: undefined, hasFocus: false })).toBe(false);
        expect(shouldAutoFocusWatchedShare({ width: 3840, height: 0, hasFocus: false })).toBe(false);
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('the Watch click asks the rule, and the focus is applied in the same effect that mirrors the watch set', () => {
        expect(src).toMatch(/shouldAutoFocusWatchedShare\(/);
        expect(src).toMatch(/pendingAutoFocusRef/);
        // Same effect as the mirror: the banner's "unwatched share" backstop must see both at once.
        expect(src).toMatch(/setWatchedScreenShareIdsCtx\?\.\(subscribedScreenshares\);[\s\S]{0,400}setFocusedStreamCtx\?\.\(/);
    });
});
