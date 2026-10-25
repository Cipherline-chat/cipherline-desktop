import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for #channel links. ChatPane / Dashboard have no
 * render harness (see mentionRosterWiring.test.ts), so these pin the
 * registration that makes utils/channelRefs.test.ts and ChannelRefPill.test.ts
 * reachable in the real components.
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const chatPane = read('ChatPane.tsx');
const dashboard = read('Dashboard.tsx');
const channelList = read('server/ServerChannelList.tsx');
const contextPanel = read('server/ServerContextPanel.tsx');
const historyMerge = readFileSync(join(__dirname, '..', 'utils', 'channelHistoryMerge.ts'), 'utf8');

describe('composer: # picker', () => {
    it('detects the trigger only in a server channel', () => {
        expect(chatPane).toContain('const channelTrigger = activeChannel ? detectChannelTrigger(before) : null;');
    });
    it('uses the shared SuggestionMenu with the same keys as @', () => {
        expect(chatPane).toContain('sectionLabel="Channels"');
        expect(chatPane).toContain("insertChannelSuggestion(channelSuggestions[selectedChannelIdx])");
        expect(chatPane).toContain("setSelectedChannelIdx(i => nextSuggestionIndex(i, channelSuggestions.length, 'up'))");
        expect(chatPane).toContain("setSelectedChannelIdx(i => nextSuggestionIndex(i, channelSuggestions.length, 'down'))");
        expect(chatPane).toMatch(/useEscape\(\(\) => \{ setChannelSuggestions\(\[\]\); setChannelQueryRange\(null\); \}, channelSuggestions\.length > 0\)/);
    });
    it('candidates come from the visibility-filtered builder', () => {
        expect(chatPane).toContain('buildChannelCandidates(serverChannels, serverCategories, linkServerId)');
    });
});

describe('send / edit carry channel_refs (server channels only)', () => {
    it('collects refs only in a server channel', () => {
        expect(chatPane).toContain('const channelRefs = activeChannel ? collectChannelRefs(wireText, channelRefMapRef.current) : [];');
    });
    it('channel text message and edit include them', () => {
        expect(chatPane).toContain("...(channelRefs.length > 0 ? { channel_refs: channelRefs } : {}) };");
        expect(chatPane).toContain("dispatchAction({ type: 'edit', target_id: editingId, text: wireText, ...(channelRefs.length > 0 ? { channel_refs: channelRefs } : {}) })");
    });
    it('negative control: the DM content literal does not carry channel_refs', () => {
        const dm = chatPane.split('\n').find(l => l.includes("const content: ClientContent = bareInviteCode"));
        expect(dm).toBeDefined();
        const next = chatPane.slice(chatPane.indexOf(dm!), chatPane.indexOf(dm!) + 400);
        expect(next).not.toContain('channel_refs');
    });
    it('opening an edit seeds the name -> id map from the message', () => {
        expect(chatPane).toContain('channelRefNameMap(msg.content.channel_refs)');
    });
    it('every channel edit-apply site passes the edit\'s refs', () => {
        // The own-send path inline; the live receive path and the history
        // fold both go through applyChannelEditDelete (F3 authorization).
        expect(dashboard.match(/editedContent\(thread\[idx\]\.content, content\.text, content\.channel_refs\)/g)).toHaveLength(1);
        expect(dashboard).toContain('applyChannelEditDelete(thread, liveAction, { moderatorDeleteTargets })');
        expect(dashboard).not.toMatch(/editedContent\([^)]*content\.text\)/);
        expect(historyMerge).toContain('editedContent(next[idx].content, c.text, c.channel_refs)');
    });
});

describe('rendering + navigation', () => {
    it('message text renders ChannelRefPill for validated refs, server channels only', () => {
        expect(chatPane).toContain('isServerChannel && msg.content.channel_refs');
        // one renderer (renderBody) draws the row, the collapsed preview and the reader
        expect(chatPane).toContain('sanitizeChannelRefs(msg.content.channel_refs)');
        expect(chatPane).toContain('spans: findChannelRefSpans(t, channelRefs)');
        expect(chatPane).toContain('<ChannelRefPill key={key} channelRef={ref} visibleChannels={linkChannels} onNavigate={navigateToChannel} />');
    });
    it('rows re-render when the channel list changes (rename shows at once)', () => {
        expect(chatPane).toMatch(/mentionedUserIsKnown, nowTick, linkChannels, hasNavigateToChannel,/);
    });
    it('Dashboard feeds the channel list and the navigate handler', () => {
        expect(dashboard).toContain('serverChannels={serverChannels[activeChannel.server_id]}');
        expect(dashboard).toContain('serverCategories={serverCategories[activeChannel.server_id]}');
        expect(dashboard).toContain('onNavigateToChannel={handleNavigateToChannel}');
        expect(dashboard).toContain('channelNavigationFor(channelId, serverChannels[current.server_id], current.server_id)');
        expect(dashboard).toContain('revealChannelRow(channelId, document)');
    });
    it('sidebar and call-panel rows are reveal targets', () => {
        expect(channelList).toContain('data-channel-id={ch.channel_id}');
        expect(contextPanel).toContain('data-channel-id={huddle.channel_id}');
    });
});
