import { describe, it, expect, vi } from 'vitest';
import {
    decideFullscreenHint, FullscreenHintGate, shareKindOf,
    FULLSCREEN_HINT_MESSAGE, FULLSCREEN_HINT_ACTION,
} from './shareFullscreenHint';
import { cleanForegroundDiag, fetchForegroundDiag, type ForegroundDiag } from './foregroundInfo';

/** A fullscreen game on the shared monitor: the hint's one positive case. */
const GAME: ForegroundDiag = {
    state: 'QUNS_RUNNING_D3D_FULL_SCREEN', exe: 'game.exe', covers: true, isCipherline: false, onSharedScreen: true,
};
const fg = (over: Partial<ForegroundDiag> = {}): ForegroundDiag => ({ ...GAME, ...over });

describe('decideFullscreenHint', () => {
    it('screen share + a covering foreground game on the shared monitor -> hint, naming the program', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: GAME, alreadyShown: false })).toEqual({ show: true, reason: 'show', exe: 'game.exe' });
    });

    it('a borderless window that merely covers the monitor (no D3D-fullscreen state) is enough', () => {
        const d = decideFullscreenHint({ kind: 'screen', fg: fg({ state: 'QUNS_ACCEPTS_NOTIFICATIONS', covers: true }), alreadyShown: false });
        expect(d.show).toBe(true);
    });

    it('Windows reporting a Direct3D fullscreen app is enough even if the rectangle does not match exactly', () => {
        const d = decideFullscreenHint({ kind: 'screen', fg: fg({ covers: false }), alreadyShown: false });
        expect(d.show).toBe(true);
    });

    it('a WINDOW share -> no hint (it is not affected)', () => {
        expect(decideFullscreenHint({ kind: 'window', fg: GAME, alreadyShown: false })).toMatchObject({ show: false, reason: 'not_screen_share' });
        expect(decideFullscreenHint({ kind: 'unknown', fg: GAME, alreadyShown: false }).show).toBe(false);
    });

    it('Cipherline in front -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: fg({ isCipherline: true, exe: 'Cipherline.exe' }), alreadyShown: false }))
            .toMatchObject({ show: false, reason: 'cipherline_in_front' });
    });

    it('a game on a DIFFERENT monitor, or one we cannot place -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: fg({ onSharedScreen: false }), alreadyShown: false })).toMatchObject({ show: false, reason: 'other_monitor' });
        expect(decideFullscreenHint({ kind: 'screen', fg: fg({ onSharedScreen: null }), alreadyShown: false })).toMatchObject({ show: false, reason: 'other_monitor' });
    });

    it('an ordinary (non-covering) foreground app -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: fg({ state: 'QUNS_ACCEPTS_NOTIFICATIONS', covers: false }), alreadyShown: false }))
            .toMatchObject({ show: false, reason: 'not_covering' });
    });

    it('no answer (browser build, non-Windows, older main) -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: null, alreadyShown: false })).toMatchObject({ show: false, reason: 'no_info' });
    });

    it('an unknown program (nothing to pre-select) or the Windows shell -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: fg({ exe: '' }), alreadyShown: false })).toMatchObject({ show: false, reason: 'unknown_program' });
        for (const exe of ['explorer.exe', 'Explorer.EXE', 'LockApp.exe', 'SearchHost.exe']) {
            expect(decideFullscreenHint({ kind: 'screen', fg: fg({ exe }), alreadyShown: false }).show, exe).toBe(false);
        }
    });

    it('already shown -> no hint', () => {
        expect(decideFullscreenHint({ kind: 'screen', fg: GAME, alreadyShown: true })).toMatchObject({ show: false, reason: 'already_shown' });
    });
});

describe('FullscreenHintGate: once per share', () => {
    it('fires exactly once however many samples say so, with the program name', () => {
        const onHint = vi.fn();
        const gate = new FullscreenHintGate({ onHint });
        expect(gate.observe(GAME, 'screen').show).toBe(true);
        expect(gate.observe(GAME, 'screen').show).toBe(false);
        expect(gate.observe(fg({ exe: 'other.exe' }), 'screen').show).toBe(false);
        expect(onHint).toHaveBeenCalledTimes(1);
        expect(onHint).toHaveBeenCalledWith('game.exe');
        expect(gate.shown).toBe(true);
    });

    it('stays quiet through non-qualifying samples, then fires on the first qualifying one', () => {
        const onHint = vi.fn();
        const gate = new FullscreenHintGate({ onHint });
        gate.observe(fg({ isCipherline: true }), 'screen');
        gate.observe(null, 'screen');
        gate.observe(GAME, 'window');
        expect(onHint).not.toHaveBeenCalled();
        gate.observe(GAME, 'screen');
        expect(onHint).toHaveBeenCalledTimes(1);
    });

    it('a new gate (a new share) can fire again', () => {
        const onHint = vi.fn();
        new FullscreenHintGate({ onHint }).observe(GAME, 'screen');
        new FullscreenHintGate({ onHint }).observe(GAME, 'screen');
        expect(onHint).toHaveBeenCalledTimes(2);
    });

    it('the copy is the requested sentence', () => {
        expect(FULLSCREEN_HINT_MESSAGE).toBe('For smooth game streaming, share the game window instead.');
        expect(FULLSCREEN_HINT_ACTION.length).toBeGreaterThan(0);
    });
});

describe('shareKindOf', () => {
    it.each([
        ['screen:0:0', 'screen'], ['screen:2:0', 'screen'], ['window:131346:0', 'window'],
        ['', 'unknown'], ['something', 'unknown'], [undefined, 'unknown'], [null, 'unknown'],
    ])('%j -> %s', (id, kind) => expect(shareKindOf(id as string | undefined)).toBe(kind));
});

describe('cleanForegroundDiag (what crossed the bridge)', () => {
    it('maps main\'s answer to the renderer shape', () => {
        expect(cleanForegroundDiag({
            notificationState: 'QUNS_RUNNING_D3D_FULL_SCREEN', fgExe: 'game.exe', fgCoversMonitor: true, fgIsCipherline: false, onSharedScreen: true,
        })).toEqual(GAME);
    });

    it('rejects / neutralises anything off-shape: a title-looking exe, a bad state, non-booleans', () => {
        const d = cleanForegroundDiag({ notificationState: 'drop table', fgExe: 'Secret <doc>.docx - Word', fgCoversMonitor: 1, fgIsCipherline: 'y', onSharedScreen: 'yes' })!;
        expect(d).toEqual({ state: 'QUNS_UNKNOWN', exe: '', covers: false, isCipherline: false, onSharedScreen: null });
    });

    it.each([[null], [undefined], [4], ['x']])('%j -> null', (raw) => expect(cleanForegroundDiag(raw)).toBeNull());

    it('fetchForegroundDiag passes the source id, narrows the answer, and never throws', async () => {
        const getShareForegroundInfo = vi.fn(async (_id?: string) => ({
            notificationState: 'QUNS_BUSY', fgExe: 'a.exe', fgCoversMonitor: false, fgIsCipherline: false, onSharedScreen: false,
        }));
        expect(await fetchForegroundDiag('screen:1:0', { getShareForegroundInfo })).toMatchObject({ state: 'QUNS_BUSY', exe: 'a.exe', onSharedScreen: false });
        expect(getShareForegroundInfo).toHaveBeenCalledWith('screen:1:0');
        expect(await fetchForegroundDiag('screen:1:0', { getShareForegroundInfo: async () => { throw new Error('closed'); } })).toBeNull();
        expect(await fetchForegroundDiag('screen:1:0', {})).toBeNull();
        expect(await fetchForegroundDiag('screen:1:0', undefined)).toBeNull();
    });
});
