import { describe, it, expect } from 'vitest';
import {
    parseVideoEncodeDriverStatus, parseVideoEncodeDriverInstallResult, shouldShowVideoEncodeDriverCard, videoEncodeDriverOutcomeText, videoEncodeDriverTitle,
} from './videoEncodeDriver';

const inst = { state: 'install', vendor: 'intel', pkg: 'p', command: 'c', repoHint: 'multiverse', canInstall: true } as const;

describe('videoEncodeDriver renderer narrowing', () => {
    it('garbage degrades to nothing to show', () => {
        for (const v of [null, undefined, 3, 'x', {}, { state: 'bogus' }]) expect(parseVideoEncodeDriverStatus(v).state).toBe('none');
        expect(parseVideoEncodeDriverInstallResult(undefined)).toMatchObject({ outcome: 'failed' });
    });
    it('a valid status survives', () => expect(parseVideoEncodeDriverStatus(inst)).toEqual(inst));
    it('the one-time card: a dismissal sticks, a post-install restart prompt does not', () => {
        expect(shouldShowVideoEncodeDriverCard(inst, false)).toBe(true);
        expect(shouldShowVideoEncodeDriverCard(inst, true)).toBe(false);
        expect(shouldShowVideoEncodeDriverCard({ ...inst, state: 'restart' }, true)).toBe(true);
        expect(shouldShowVideoEncodeDriverCard({ ...inst, state: 'none' }, false)).toBe(false);
    });
    it('copy: per-vendor title, restart after install, repo hint and command when PackageKit cannot', () => {
        expect(videoEncodeDriverTitle(inst)).toContain('Intel video encoder driver');
        expect(videoEncodeDriverTitle({ ...inst, vendor: 'amd' })).toContain('AMD');
        expect(videoEncodeDriverTitle({ ...inst, state: 'restart' })).toContain('Restart Cipherline');
        expect(videoEncodeDriverOutcomeText('installed', inst)).toContain('Restart Cipherline');
        expect(videoEncodeDriverOutcomeText('not_found', inst)).toContain('multiverse');
        expect(videoEncodeDriverOutcomeText('unavailable', inst)).toContain('command');
    });
});
