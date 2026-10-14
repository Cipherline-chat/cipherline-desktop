import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    cleanForegroundDiag, unavailableForegroundDiag, isForegroundUnavailable, foregroundLogFields,
    FOREGROUND_UNAVAILABLE_STATE, fetchForegroundDiag, type ForegroundDiag,
} from './foregroundInfo';
import { decideFullscreenHint, FullscreenHintGate } from './shareFullscreenHint';
import { logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

/**
 * Linux / macOS have no foreground information (electron/share-platform.ts).
 * main answers { unavailable: true }; the renderer reports fg_state
 * "unavailable" and nothing else, and never offers the Windows-only
 * fullscreen hint.
 */
const GAME: ForegroundDiag = { state: 'QUNS_RUNNING_D3D_FULL_SCREEN', exe: 'game.exe', covers: true, isCipherline: false, onSharedScreen: true };

describe('cleanForegroundDiag - main\'s explicit "unavailable"', () => {
    it('{ unavailable: true } becomes the unavailable marker', () => {
        expect(cleanForegroundDiag({ unavailable: true })).toEqual(unavailableForegroundDiag());
        expect(unavailableForegroundDiag()).toEqual({ state: 'unavailable', exe: '', covers: false, isCipherline: false, onSharedScreen: null });
    });

    it('only an exact true counts - a truthy string is not "unavailable"', () => {
        expect(cleanForegroundDiag({ unavailable: 'true' })!.state).toBe('QUNS_UNKNOWN');
        expect(cleanForegroundDiag({ unavailable: 1 })!.state).toBe('QUNS_UNKNOWN');
    });

    it('a real Windows answer is untouched', () => {
        expect(cleanForegroundDiag({ notificationState: 'QUNS_RUNNING_D3D_FULL_SCREEN', fgExe: 'game.exe', fgCoversMonitor: true, onSharedScreen: true }))
            .toMatchObject({ state: 'QUNS_RUNNING_D3D_FULL_SCREEN', exe: 'game.exe', covers: true });
    });

    it('null / junk is still "no answer"', () => {
        for (const v of [null, undefined, 'x', 3]) expect(cleanForegroundDiag(v)).toBeNull();
    });

    it('isForegroundUnavailable', () => {
        expect(isForegroundUnavailable(unavailableForegroundDiag())).toBe(true);
        expect(isForegroundUnavailable(GAME)).toBe(false);
        expect(isForegroundUnavailable(null)).toBe(false);
    });

    it('fetchForegroundDiag passes the marker through from the bridge', async () => {
        const api = { getShareForegroundInfo: async () => ({ unavailable: true }) };
        expect(await fetchForegroundDiag('screen:0:0', api)).toEqual(unavailableForegroundDiag());
    });
});

describe('foregroundLogFields', () => {
    it('no answer: all blank (the event log drops blanks)', () => {
        expect(foregroundLogFields(null)).toEqual({ fg_state: '', fg_exe: '', fg_cover: '' });
    });

    it('unavailable: fg_state "unavailable" and NOTHING that reads as a measurement (no fg_cover: false)', () => {
        expect(foregroundLogFields(unavailableForegroundDiag())).toEqual({ fg_state: FOREGROUND_UNAVAILABLE_STATE, fg_exe: '', fg_cover: '' });
        expect(FOREGROUND_UNAVAILABLE_STATE).toBe('unavailable');
    });

    it('a Windows answer maps one to one', () => {
        expect(foregroundLogFields(GAME)).toEqual({ fg_state: 'QUNS_RUNNING_D3D_FULL_SCREEN', fg_exe: 'game.exe', fg_cover: true });
    });

    it('through the real call event log: share_fps keeps fg_state=unavailable and drops the blanks', () => {
        clearCallEvents();
        logCallEvent('share_fps', { src_fps: 58, enc_fps: 57, sent_fps: 57, enc: 'OpenH264', hw: false, target: 60, focus: true, ...foregroundLogFields(unavailableForegroundDiag()) });
        const ev = getCallEvents().at(-1)!;
        expect(validateCallEvent(ev)).toEqual([]);
        expect(ev.detail).toMatchObject({ fg_state: 'unavailable', enc: 'OpenH264', hw: false });
        expect(ev.detail).not.toHaveProperty('fg_exe');
        expect(ev.detail).not.toHaveProperty('fg_cover');
    });
});

describe('the fullscreen hint off Windows', () => {
    it('never shows when the foreground is unavailable, however the share looks', () => {
        const d = decideFullscreenHint({ kind: 'screen', fg: unavailableForegroundDiag(), alreadyShown: false });
        expect(d).toEqual({ show: false, reason: 'unavailable' });
    });

    it('the gate never fires for an unavailable foreground, sample after sample', () => {
        let shown = 0;
        const gate = new FullscreenHintGate({ onHint: () => { shown++; } });
        for (let i = 0; i < 5; i++) gate.observe(unavailableForegroundDiag(), 'screen');
        expect(shown).toBe(0);
        expect(gate.shown).toBe(false);
    });

    it('with the once-per-account store, an unavailable foreground never marks the hint as seen (nothing was shown)', () => {
        let marked = 0;
        const seen = { ready: () => true, seen: () => false, markSeen: () => { marked++; } };
        const gate = new FullscreenHintGate({ onHint: () => {}, seen });
        for (let i = 0; i < 3; i++) gate.observe(unavailableForegroundDiag(), 'screen');
        expect(marked).toBe(0);
        // ...and a later Windows-style sample on the same account still shows it once.
        expect(gate.observe(GAME, 'screen').show).toBe(true);
        expect(marked).toBe(1);
    });

    it('the Windows hint still fires (nothing regressed)', () => {
        const d = decideFullscreenHint({ kind: 'screen', fg: GAME, alreadyShown: false });
        expect(d).toEqual({ show: true, reason: 'show', exe: 'game.exe' });
    });
});

describe('source pins for the Linux/macOS parity wiring', () => {
    const rd = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');
    const SC = rd('components', 'SidebarConference.tsx');
    const PICKER = rd('components', 'ScreenSharePickerModal.tsx');
    const MAIN = rd('..', 'electron', 'main.ts');

    it('main answers the foreground request off Windows with the explicit marker, BEFORE looking for the addon', () => {
        const i = MAIN.indexOf("ipcMain.handle('share:get-foreground-info'");
        const body = MAIN.slice(i, i + 1400);
        expect(body).toContain("if (process.platform !== 'win32') return foregroundAnswerWithoutAddon(process.platform);");
        expect(body.indexOf('foregroundAnswerWithoutAddon')).toBeLessThan(body.indexOf('getForegroundInfo'));
    });

    it('main reports the capturer ceiling to the picker and in the share diagnostics', () => {
        expect(MAIN).toMatch(/captureFpsCeiling: ceiling,/);
        expect(MAIN).toMatch(/captureFpsCeiling: captureFpsCeiling\(capturer\.backend\),/);
    });

    it('the share asks the capturer for headroom over the ceiling, and records both in share_codec', () => {
        expect(SC).toContain('const captureCeiling = mainDiag?.captureFpsCeiling ?? null;');
        expect(SC).toContain('captureFrameRateFor(options.frameRate, captureCeiling)');
        expect(SC).toContain("backend: mainDiag?.capturer.backend ?? 'unknown', ceiling: captureCeiling ?? 0,");
    });

    it('the picker says so when the capturer, not the monitor, is the limit', () => {
        expect(PICKER).toContain('captureFpsCeiling');
        expect(PICKER).toMatch(/const captureCapped = captureCeiling > 0 && frameRate > captureCeiling/);
        expect(PICKER).toContain('Screen sharing is limited to {captureCeiling} fps here.');
    });
});
