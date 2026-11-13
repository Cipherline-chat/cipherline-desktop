import { describe, it, expect } from 'vitest';
import { fullscreenClassInFront, starveNotice } from './shareStarveNotice';
import { unavailableForegroundDiag, type ForegroundDiag } from './foregroundInfo';

const fg = (o: Partial<ForegroundDiag> = {}): ForegroundDiag => ({ state: 'QUNS_ACCEPTS_NOTIFICATIONS', exe: 'x.exe', covers: false, isCipherline: false, onSharedScreen: true, ...o });

describe('fullscreenClassInFront', () => {
    it('report 566966f4: obs64 under QUNS_BUSY that does not cover the monitor counts (the old gate said no)', () => {
        expect(fullscreenClassInFront(fg({ state: 'QUNS_BUSY', exe: 'obs64.exe', covers: false }))).toBe(true);
    });
    it('report 4667c6fa: a game under QUNS_RUNNING_D3D_FULL_SCREEN covering the screen counts', () => {
        expect(fullscreenClassInFront(fg({ state: 'QUNS_RUNNING_D3D_FULL_SCREEN', covers: true }))).toBe(true);
    });
    it('a covering window counts whatever the state', () => {
        expect(fullscreenClassInFront(fg({ covers: true }))).toBe(true);
    });
    it('an ordinary window in front (Code.exe at a full 90 fps in the same report) does not', () => {
        expect(fullscreenClassInFront(fg({ exe: 'Code.exe' }))).toBe(false);
    });
    it('Cipherline itself, no answer, and an OS with no answer never count', () => {
        expect(fullscreenClassInFront(fg({ state: 'QUNS_BUSY', isCipherline: true }))).toBe(false);
        expect(fullscreenClassInFront(null)).toBe(false);
        expect(fullscreenClassInFront(unavailableForegroundDiag())).toBe(false);
    });
});

describe('starveNotice', () => {
    it('says what happened and what viewers see, without naming the program', () => {
        const t = starveNotice(fg({ state: 'QUNS_BUSY', exe: 'obs64.exe' }), false)!;
        expect(t).toMatch(/stopped giving Cipherline new pictures/);
        expect(t).toMatch(/last picture/);
        expect(t).not.toMatch(/obs64/i);
    });
    it('says the stream is being kept running when the keep-alive engaged', () => {
        expect(starveNotice(fg({ state: 'QUNS_BUSY' }), true)).toMatch(/keeps the stream running/);
    });
    it('a still screen (nothing fullscreen in front) is NOT reported as a stall', () => {
        expect(starveNotice(fg(), false)).toBeNull();
        expect(starveNotice(fg(), true)).toBeNull();
        expect(starveNotice(null, true)).toBeNull();
    });
});
