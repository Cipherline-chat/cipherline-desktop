import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring for the key-wait layer (no render harness exists for
 * the 14k-line Dashboard / 8k-line ChatPane — same approach as
 * channelHistoryWiring.test.ts). The stages are only honest if the three
 * signals are noted where the real events happen, and the layer only
 * replaces pills if ChatPane really withholds the list while it is up.
 */
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const pane = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const between = (src: string, a: string, b: string) => {
    const i = src.indexOf(a);
    expect(i, a).toBeGreaterThan(-1);
    const j = src.indexOf(b, i);
    expect(j, b).toBeGreaterThan(i);
    return src.slice(i, j);
};

describe('Dashboard notes the real events', () => {
    it('request acknowledged: only after the key-request POST resolved', () => {
        const fn = between(dash, 'const fileKeyRequest = useCallback', 'const maybeFileKeyRequest = useCallback');
        const post = fn.indexOf('/key-request`');
        const note = fn.indexOf('noteKeyRequestAcked(channelId)');
        const fail = fn.indexOf('} catch (e) {');
        expect(post).toBeGreaterThan(-1);
        expect(note).toBeGreaterThan(post);
        expect(note).toBeLessThan(fail);
    });
    it('key received: only after setChannelKey stored it (not on a conflict)', () => {
        const fn = between(dash, 'const pullChannelKeysOnce = useCallback', 'const pullChannelKeys = useCallback');
        const note = fn.indexOf('noteChannelKeyReceived(env.channel_id)');
        expect(note).toBeGreaterThan(fn.indexOf("if (stored === 'conflict') {\n                            // Either the server"));
        expect(fn.slice(note - 200, note)).toContain('Received epoch');
    });
    it('page decrypt: begun around decryptChannelRows in ingestChannelRows, ended in finally after the fold', () => {
        const fn = between(dash, 'const ingestChannelRows = useCallback', 'const loadChannelMessagesById = useCallback');
        const begin = fn.indexOf('beginChannelPageDecrypt(channelId)');
        const decrypt = fn.indexOf('await decryptChannelRows(channelId, toDecrypt)');
        const fold = fn.indexOf('setChannelMessages(prev =>');
        const end = fn.indexOf('} finally {\n            endPageDecrypt?.();');
        expect(begin).toBeGreaterThan(-1);
        expect(begin).toBeLessThan(decrypt);
        expect(fold).toBeGreaterThan(decrypt);
        expect(end).toBeGreaterThan(fold);
    });
    it('keys already waiting at channel entry re-read the open channel', () => {
        const fn = between(dash, 'const ensureChannelKeyBootstrap = useCallback', 'const handleSelectChannel = useCallback');
        expect(fn).toMatch(/activeChannelRef\.current\?\.channel_id === channel\.channel_id\s*&& \(channelMessagesRef\.current\[channel\.channel_id\] \?\? \[\]\)\.some\(isUndecryptablePlaceholder\)\)\s*\{\s*void refreshChannelHistoryRef\.current\(channel\.server_id, channel\.channel_id\);/);
    });
});

describe('ChatPane replaces the list, keeps header and composer', () => {
    it('the hook is fed the channel thread, server channels only', () => {
        expect(pane).toMatch(/useChannelKeyWait\(\{\s*enabled: isServerChannel,\s*channelId: activeChannel\?\.channel_id \?\? null,\s*messages,\s*\}\)/);
    });
    it('while held, no row, no "load earlier", no history-start line renders', () => {
        expect(pane).toContain('{keyWait.holdList ? null : messages.length === 0 ? (');
        expect(pane).toContain('{pagination.hasMore && !chatSearch.trim() && !keyWait.holdList && (');
        expect(pane).toMatch(/historyStart && !pagination\.hasMore && !chatSearch\.trim\(\) && messages\.length > 0 && !keyWait\.holdList/);
    });
    it('the list fades in during the handoff and snaps to the bottom when the hold lifts', () => {
        expect(pane).toContain("keyWait.handoff ? 'flex flex-col mt-auto ckw-list-in' : 'flex flex-col mt-auto'");
        expect(pane).toContain('const isLoading = chatLoading || membersFetching || messagesFetching || keyWait.holdList;');
    });
    it('the layer sits over the feed only, clear of the floating composer', () => {
        const feed = pane.indexOf('ref={feedRef}');
        const wrap = pane.lastIndexOf('<div className="relative flex-1 min-h-0 flex flex-col min-w-0">', feed);
        expect(wrap).toBeGreaterThan(-1);
        expect(feed - wrap).toBeLessThan(140);
        const layer = pane.indexOf('<ChannelKeyWait', feed);
        expect(pane.slice(layer, layer + 300)).toContain('bottomInset={composerH + 16}');
        // and the composer keeps its own existing "no key" gate (no duplicate)
        expect(pane).toContain("'Waiting for channel keys — they arrive automatically…'");
    });
});
