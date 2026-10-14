import { describe, it, expect } from 'vitest';
import { describeUpdateTile, formatRetryIn } from './updateTile';

/**
 * The owner's rule, in the one place the user clicks: on Windows and macOS no
 * update phase may send the user to a browser. `open-download` is reachable
 * ONLY from `manual`, which main produces on Linux only
 * (electron/updater-state.ts, pinned by updaterState.test.ts).
 */

const NOW = 1_800_000_000_000;
const V = '1.0.22';

const ALL: UpdateStateShape[] = [
    { phase: 'idle' },
    { phase: 'available', version: V },
    { phase: 'downloading', version: V, percent: 37.6 },
    { phase: 'retrying', version: V, attempt: 2, maxAttempts: 3, retryAt: NOW + 52_000 },
    { phase: 'failed', version: V, stage: 'download' },
    { phase: 'failed', version: V, stage: 'verify' },
    { phase: 'failed', version: V, stage: 'install' },
    { phase: 'ready', version: V },
    { phase: 'manual', version: V, downloadUrl: `https://updates.cipherline.chat/Cipherline-${V}.AppImage` },
];

describe('describeUpdateTile', () => {
    it('only the Linux-only manual phase has a browser action', () => {
        for (const s of ALL) {
            const t = describeUpdateTile(s, NOW);
            if (s.phase === 'manual') expect(t.action).toBe('open-download');
            else expect(t.action).not.toBe('open-download');
        }
    });

    it('idle shows nothing', () => {
        expect(describeUpdateTile({ phase: 'idle' }, NOW).visible).toBe(false);
    });

    it('downloading is an inert progress ring', () => {
        expect(describeUpdateTile({ phase: 'available', version: V }, NOW)).toMatchObject({ visible: true, action: null, percent: 0, tone: 'busy' });
        expect(describeUpdateTile({ phase: 'downloading', version: V, percent: 37.6 }, NOW))
            .toMatchObject({ visible: true, action: null, percent: 37.6, label: 'Downloading update… 38%' });
    });

    it('a Retry after a rejected manifest (version not known yet) reads "Checking", never "v"', () => {
        expect(describeUpdateTile({ phase: 'available', version: '' }, NOW).label).toBe('Checking for update…');
        expect(describeUpdateTile({ phase: 'available', version: V }, NOW).label).toBe(`Downloading update v${V}…`);
        expect(describeUpdateTile({ phase: 'failed', version: '', stage: 'verify' }, NOW))
            .toMatchObject({ visible: true, action: 'retry', label: "Update couldn't be verified — click to try again" });
    });

    it('retrying stays in-app: "Update downloading… retrying in …" and a retry-now action', () => {
        const t = describeUpdateTile(ALL[3], NOW);
        expect(t).toMatchObject({ visible: true, action: 'retry', tone: 'warn' });
        expect(t.label).toBe('Update downloading… retrying in 52s — click to retry now');
        // Countdown reaching zero reads "now", never "in 0s" or a negative.
        expect(describeUpdateTile(ALL[3], NOW + 60_000).label).toContain('retrying now');
    });

    it('every failure offers an in-app Retry with wording per stage', () => {
        expect(describeUpdateTile(ALL[4], NOW)).toMatchObject({ action: 'retry', tone: 'error', label: "Update couldn't finish downloading — click to try again" });
        expect(describeUpdateTile(ALL[5], NOW)).toMatchObject({ action: 'retry', tone: 'error', label: "Update couldn't be verified — click to try again" });
        expect(describeUpdateTile(ALL[6], NOW)).toMatchObject({ action: 'retry', tone: 'error', label: "Update couldn't be installed — click to try again" });
    });

    it('ready installs', () => {
        expect(describeUpdateTile({ phase: 'ready', version: V }, NOW)).toMatchObject({ action: 'install', tone: 'ready' });
    });

    it('an unknown phase from a newer main process renders nothing', () => {
        expect(describeUpdateTile({ phase: 'brand-new' } as unknown as UpdateStateShape, NOW)).toMatchObject({ visible: false, action: null });
    });
});

describe('formatRetryIn', () => {
    it('rounds up and never says 0s', () => {
        expect(formatRetryIn(0)).toBe('1s');
        expect(formatRetryIn(9_001)).toBe('10s');
        expect(formatRetryIn(60_000)).toBe('1m');
        expect(formatRetryIn(299_500)).toBe('5m');
        expect(formatRetryIn(80_000)).toBe('1m 20s');
    });
});
