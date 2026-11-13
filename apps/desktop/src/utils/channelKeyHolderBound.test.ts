import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { epochPastHolderBound, HOLDER_RETAIN_NEWEST_COUNT } from './channelKeyDistribution';

/**
 * What a holder actually keeps (electron/channel-keys.ts pruneOldKeys): the
 * highest epoch, the newest RETAIN_NEWEST_COUNT, every pinned epoch - and
 * anything younger than 30 days. Only an epoch outside ALL of those is gone
 * from every device. (Prod 2026-11-04: ten devices repeatedly asked for epoch 10
 * of a channel at epoch 23 - inside the newest 50, so NOT pruned by age: nobody
 * holds it, which is a different problem from "too old".)
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe('epochPastHolderBound', () => {
    it('old, outside the newest 50, unpinned: past what any device keeps', () => {
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: NOW - 40 * DAY, nowMs: NOW })).toBe(true);
    });
    it('inside the newest 50 it is kept whatever its age (the prod case: epoch 10 of 23)', () => {
        expect(epochPastHolderBound({ epoch: 10, latestEpoch: 23, createdAtMs: NOW - 60 * DAY, nowMs: NOW })).toBe(false);
        // boundary: latest - 50 is the oldest NOT kept
        expect(epochPastHolderBound({ epoch: 30, latestEpoch: 80, createdAtMs: NOW - 60 * DAY, nowMs: NOW })).toBe(true);
        expect(epochPastHolderBound({ epoch: 31, latestEpoch: 80, createdAtMs: NOW - 60 * DAY, nowMs: NOW })).toBe(false);
    });
    it('younger than 30 days is never past the bound; the boundary day is not', () => {
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: NOW - 29 * DAY, nowMs: NOW })).toBe(false);
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: NOW - 30 * DAY + 1, nowMs: NOW })).toBe(false);
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: NOW - 30 * DAY, nowMs: NOW })).toBe(true);
    });
    it('a pinned epoch is kept however old (setProtectedEpochs)', () => {
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: NOW - 90 * DAY, pinned: true, nowMs: NOW })).toBe(false);
    });
    it('unknown age: ask as before', () => {
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: undefined, nowMs: NOW })).toBe(false);
        expect(epochPastHolderBound({ epoch: 3, latestEpoch: 80, createdAtMs: Number.NaN, nowMs: NOW })).toBe(false);
    });
});

describe('the client mirrors the holder\'s retention constants', () => {
    // Importing electron/ from src/ nests the build output (electron_rootdir_trap), so the
    // constants are mirrored and pinned here by reading the source instead.
    const electron = readFileSync(join(__dirname, '../../electron/channel-keys.ts'), 'utf8');
    it('RETAIN_NEWEST_COUNT matches', () => {
        expect(electron).toMatch(new RegExp(`const RETAIN_NEWEST_COUNT = ${HOLDER_RETAIN_NEWEST_COUNT};`));
    });
    it('the prune age is 30 days', () => {
        expect(electron).toMatch(/const PRUNE_AFTER_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
        expect(readFileSync(join(__dirname, 'channelKeyDistribution.ts'), 'utf8'))
            .toMatch(/const EPOCH_PRUNE_HORIZON_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
    });
});

describe('Dashboard applies the bound to row-driven asks (the one path with no age filter)', () => {
    const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
    it('askForRowEpochs drops past-bound epochs before asking', () => {
        const m = /const askForRowEpochs = useCallback[\s\S]*?const missing = requestEpochList\(([^;]*)\);/.exec(dash);
        expect(m, 'askForRowEpochs not found').not.toBeNull();
        expect(m![1]).toContain('!pastBound(e)');
        expect(dash).toContain('epochPastHolderBound({');
    });
    it('the registry and pin refs are fed from the repair sweep and refreshProtectedEpochs', () => {
        expect(dash).toContain('epochRegistryRef.current.set(c.channel_id');
        expect(dash).toContain('pinnedEpochsRef.current.set(channelId');
    });
});
