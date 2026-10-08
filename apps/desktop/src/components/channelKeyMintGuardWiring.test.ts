import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard: every Dashboard path that mints a channel Sender Key and then
 * records the epoch server-side must first ask mayMintChannelKey (the client
 * mirror of the server's SEND_MESSAGES / CONNECT write gate). Without it a
 * read-only member installs a key locally, gets a 403 on the epoch record, and
 * holds an epoch the server never heard of.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function body(startMarker: string, endMarker: string): string {
    const a = src.indexOf(startMarker);
    expect(a).toBeGreaterThan(-1);
    const b = src.indexOf(endMarker, a);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
}

describe('channel-key mint paths are permission-guarded', () => {
    it.each([
        ['bootstrapAndDistributeChannelKey', 'const bootstrapAndDistributeChannelKey = useCallback', 'rotateChannelKey(channelId);'],
        ['attemptFallbackRotation', 'const attemptFallbackRotation = useCallback', 'rotateChannelKey(channelId, serverLatest + 1)'],
        ['rotateCallsChannelKey', 'const rotateCallsChannelKey = useCallback', 'rotateChannelKey(channelId, target)'],
    ])('%s checks mayMintChannelKey before it mints', (_n, start, mint) => {
        const fn = body(start, mint);
        expect(fn).toContain('mayMintChannelKey(serverId, channelId)');
    });

    it('the sweep does not self-heal-mint a never-minted channel the member cannot mint', () => {
        const sweep = body('const activeUnminted =', 'setAwaitingChannelKeys(prev => {');
        expect(sweep).toContain('mayMintChannelKey(serverId, active.channel_id)');
    });
});

describe('ChatPane puts the permission reason ahead of the key wait', () => {
    const chat = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
    it('key-wait only applies to members who can send', () => {
        expect(chat).toMatch(/const keyMissing\s*=\s*isServerChannel && channelKeyMissing\s*&&\s*\(channelPermissions === undefined\s*\|\|\s*!!\(channelPermissions & Permissions\.SEND_MESSAGES\)\);/);
    });
});

describe('the composer gate means "no key at all", consistently', () => {
    const sweep = body('const requestMissingChannelKeys = useCallback', 'const refreshProtectedEpochs = useCallback');

    it('the sweep gates only channels with no key; older-epoch channels are tracked, not gated', () => {
        expect(sweep).toContain('splitMissingKeyChannels(channels, localLatest)');
        expect(sweep).toContain('if (noKeySet.has(c.channel_id) || c.channel_id === activeUnminted) next[c.channel_id] = true;');
        expect(sweep).not.toMatch(/missingSet\.has\(c\.channel_id\)/);
        expect(sweep).toContain('markStaleLatest(c.channel_id, staleSet.has(c.channel_id))');
    });

    it('the repair sweep only gates when it has emptied the channel', () => {
        expect(sweep).toContain('if (heldEpochs.length === 0) setAwaitingChannelKeys(prev => ({ ...prev, [c.channel_id]: true }));');
        expect(sweep).toContain('else markStaleLatest(c.channel_id, true);');
    });

    it('the retry timer reads the gate through a ref, and never drives stale-epoch channels (the 2026-10-07 request storm)', () => {
        const timer = body('const FALLBACK_ROTATION_AFTER_MS', 'One outstanding jittered serve timer');
        expect(timer).toContain('awaitingChannelKeysRef.current');
        expect(timer).not.toMatch(/\}, \[[^\]]*awaitingChannelKeys[,\]]/);
        // stale channels must not be in the periodic sweep set, nor re-keyed on a timer
        expect(timer).toContain('const affectedChannelIds = new Set([...gatedChannelIds, ...undecryptableChannelsRef.current]);');
        expect(timer).not.toContain('staleLatestSinceRef');
        // fallback rotation remains for genuinely keyless (gated) channels only
        expect(timer).toContain('for (const cid of gatedChannelIds) {');
        expect(timer).toContain('void attemptFallbackRotation(sid, cid);');
    });
});
