import { describe, it, expect } from 'vitest';
import { chooseQuickShareSource, pickGameWindow, type QuickShareSource } from './quickShareTarget';

const SCREEN1: QuickShareSource = { id: 'screen:0:0', name: 'Screen 1' };
const SCREEN2: QuickShareSource = { id: 'screen:1:0', name: 'Screen 2' };
const GAME: QuickShareSource = { id: 'window:100:0', name: 'Elden Ring' };
const EDITOR: QuickShareSource = { id: 'window:200:0', name: 'Some Editor' };
const ALL = [GAME, EDITOR, SCREEN1, SCREEN2];

describe('chooseQuickShareSource - owner order: game window, then focused window, then primary screen', () => {
    it('a game is detected and its window is listed -> the game wins, whatever was focused', () => {
        expect(chooseQuickShareSource({ gameName: 'Elden Ring', sources: ALL, foregroundSourceId: EDITOR.id }))
            .toEqual({ id: GAME.id, why: 'game' });
        expect(chooseQuickShareSource({ gameName: 'Elden Ring', sources: ALL, foregroundSourceId: null }))
            .toEqual({ id: GAME.id, why: 'game' });
    });
    it('a game is detected but its window is not listed -> the focused window', () => {
        expect(chooseQuickShareSource({ gameName: 'Hades', sources: ALL, foregroundSourceId: EDITOR.id }))
            .toEqual({ id: EDITOR.id, why: 'foreground' });
    });
    it('no game, another app focused -> the focused window', () => {
        expect(chooseQuickShareSource({ gameName: null, sources: [], foregroundSourceId: EDITOR.id }))
            .toEqual({ id: EDITOR.id, why: 'foreground' });
        expect(chooseQuickShareSource({ gameName: undefined, sources: [SCREEN1], foregroundSourceId: EDITOR.id }))
            .toEqual({ id: EDITOR.id, why: 'foreground' });
    });
    it('no game and nothing usable in front (main said null: Cipherline / desktop / unknown / old addon) -> primary screen', () => {
        expect(chooseQuickShareSource({ gameName: null, sources: [SCREEN1, SCREEN2], foregroundSourceId: null }))
            .toEqual({ id: SCREEN1.id, why: 'screen' });
        expect(chooseQuickShareSource({ gameName: 'Hades', sources: ALL, foregroundSourceId: undefined }))
            .toEqual({ id: SCREEN1.id, why: 'screen' });
    });
    it('a foreground that is not a window id is never used', () => {
        expect(chooseQuickShareSource({ gameName: null, sources: [SCREEN1], foregroundSourceId: 'screen:0:0' }))
            .toEqual({ id: SCREEN1.id, why: 'screen' });
        expect(chooseQuickShareSource({ gameName: null, sources: [SCREEN1], foregroundSourceId: '' }))
            .toEqual({ id: SCREEN1.id, why: 'screen' });
    });
    it('last resorts: the first source of any kind, else nothing (the caller opens the picker)', () => {
        expect(chooseQuickShareSource({ gameName: null, sources: [EDITOR], foregroundSourceId: null }))
            .toEqual({ id: EDITOR.id, why: 'first' });
        expect(chooseQuickShareSource({ gameName: null, sources: [], foregroundSourceId: null })).toBeNull();
    });
});

describe('pickGameWindow (the pre-existing game match, unchanged)', () => {
    it('case-insensitive substring in either direction, windows only', () => {
        expect(pickGameWindow([GAME], 'ELDEN')?.id).toBe(GAME.id);
        expect(pickGameWindow([GAME], 'Elden Ring: Shadow of the Erdtree')?.id).toBe(GAME.id);
        expect(pickGameWindow([{ id: 'screen:0:0', name: 'Elden Ring' }], 'Elden Ring')).toBeNull();
    });
    it('no game name, or a window with an empty title, never matches', () => {
        expect(pickGameWindow([GAME], null)).toBeNull();
        expect(pickGameWindow([GAME], '')).toBeNull();
        expect(pickGameWindow([{ id: 'window:5:0', name: '' }], 'Elden Ring')).toBeNull();
    });
    it('the first matching window wins', () => {
        const second = { id: 'window:300:0', name: 'Elden Ring launcher' };
        expect(pickGameWindow([second, GAME], 'Elden Ring')?.id).toBe(second.id);
    });
});
