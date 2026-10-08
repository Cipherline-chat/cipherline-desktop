import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dashboard wiring for Unpin / Remove from server (owner report 2026-10-08:
 * "you cannot un-server-save a message", "same with unpinning"). The logic is
 * tested in utils/channelSaveActions.test.ts and utils/pinSync*.test.ts; this
 * pins down that Dashboard actually goes through it. Each check names how the
 * fix would silently come undone.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

describe('Dashboard wiring for unpin / unsave', () => {
    it('channel Unpin and Remove from server go through channelSaveActions (a 404 keeps the removal)', () => {
        expect(src).toContain('await unpinChannelMessage(channelSaveActionDeps(token), channelId, msgId);');
        expect(src).toContain('await unsaveChannelMessage(channelSaveActionDeps(token), channelId, msgId);');
        // No second, hand-rolled DELETE that could keep the old rollback-on-404.
        expect(src).not.toMatch(/axios\.delete\(`\$\{API_BASE\}\/channels\/\$\{channelId\}\/(pins|saves)\//);
    });

    it('the channel ChatPane is wired to those handlers', () => {
        expect(src).toContain('onUnpinMessage={(msgId) => handleServerUnpinChannel(activeChannel.channel_id, msgId)}');
        expect(src).toContain('onServerUnsaveMessage={(msgId) => handleServerUnsaveChannel(activeChannel.channel_id, msgId)}');
    });

    it('no pin-ledger state updater mutates its ledger ref inline (StrictMode replays it and drops the op)', () => {
        // The broken shape: `ledger: <x>LedgerRef.current }` read inside a
        // setState updater followed by `<x>LedgerRef.current = <next>.ledger`.
        expect(src).not.toMatch(/LedgerRef\.current = (next|nextState|m)\.ledger;/);
        // All four writers use the replay-safe updater instead.
        expect(src.match(/replaySafePinUpdater\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    });
});
