import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dashboard side of instant send (ChatPane side: ChatPane.sendRelease.test.ts;
 * marker logic: utils/pendingSend.test.ts). Each check names the way the
 * feature would silently break.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

describe('Dashboard wiring for instant send', () => {
    it('a send interrupted by quitting comes back as failed, not as a forever-"sending" message', () => {
        expect(src).toContain("setMessagesState(settleInterruptedSends(await trackActivity('startup:history-load', () => messageStore.loadAll('dm', userId))));");
        expect(src).toContain("setChannelMessages(settleInterruptedSends(await trackActivity('startup:history-load', () => messageStore.loadAll('channel', userId))));");
    });

    it('the live server echo of our own channel message adopts the local row (no duplicate, real id for pins/reactions)', () => {
        const adopt = src.indexOf('const adopted = adoptServerCopy(thread, msg);');
        const dedupe = src.indexOf('const alreadyPresent =', adopt);
        expect(adopt).toBeGreaterThan(-1);
        expect(dedupe).toBeGreaterThan(adopt); // must run BEFORE the client_msg_id dedupe swallows the echo
    });

    it('both ChatPanes (DM/group and channel) can mark a message delivered / failed', () => {
        const uses = src.match(/onPatchSentMessage=\{handlePatchSentMessage\}/g) ?? [];
        expect(uses.length).toBe(2);
        expect(src).toMatch(/const handlePatchSentMessage = useCallback\(\(kind: 'dm' \| 'channel'[\s\S]{0,600}applySendPatch\(thread, clientMsgId, patch\)/);
    });
});

describe('Dashboard wiring for one order everywhere (utils/messageOrder.ts)', () => {
    it("a confirmed channel row that took the server's time is re-sorted into place", () => {
        expect(src).toMatch(/if \(kind === 'channel' && patch\.timestamp && next !== thread\) next = sortChannelThread\(next\);/);
    });

    it('the live echo that adopts our channel row re-sorts too (it carries created_at)', () => {
        expect(src).toContain('if (adopted) return { ...prev, [evt.channel_id]: sortChannelThread(adopted) };');
    });

    it('an awaited DM send that already carries server_ts is placed by server order, not appended', () => {
        const opt = src.slice(src.indexOf('const handleOptimisticMessage = React.useCallback'));
        expect(opt.slice(0, 6000)).toContain('currentThread.splice(serverOrderIndex(currentThread, m), 0, m);');
    });
});

describe('history fetch', () => {
    it('foldChannelHistory adopts the server copy of a still-pending row before inserting', () => {
        const merge = readFileSync(join(__dirname, '..', 'utils', 'channelHistoryMerge.ts'), 'utf8');
        const adopt = merge.indexOf('const adopted = adoptServerCopy(folded, m);');
        const insert = merge.indexOf('folded.push(m);', adopt);
        expect(adopt).toBeGreaterThan(-1);
        expect(insert).toBeGreaterThan(adopt);
    });
});
