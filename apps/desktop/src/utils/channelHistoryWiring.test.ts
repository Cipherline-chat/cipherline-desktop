import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_PAGE_SIZE } from './channelHistoryCoverage';

/**
 * Wiring guards for channel history paging. Dashboard and ChatPane are far too
 * large to mount here (the desktop suite runs in node), so — like
 * retentionWiring.test.ts — these pin the call sites themselves. The
 * behaviour behind them is tested through the real crypto in
 * channelHistoryPaging.test.ts and the pure modules' own suites.
 */

const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
const pane = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');

const body = (src: string, start: string, end: string) => {
    const at = src.indexOf(start);
    expect(at, start).toBeGreaterThan(0);
    return src.slice(at, src.indexOf(end, at + start.length));
};

describe('channel history paging — Dashboard', () => {
    it('one page is 100 rows (the API maximum)', () => {
        expect(HISTORY_PAGE_SIZE).toBe(100);
    });

    it('opening a channel reads ONE newest page — no cursor, limit 100', () => {
        const refresh = body(dash, 'const refreshChannelHistory = useCallback', 'useEffect(() => { refreshChannelHistoryRef.current');
        expect(refresh).toContain("getChannelRows(channelId, { limit: HISTORY_PAGE_SIZE })");
        expect(refresh).not.toMatch(/before_id|after_id|around/);
        // no loop: exactly one history request in the open path
        expect(refresh.split('getChannelRows(').length - 1).toBe(1);
    });

    it('history is read only for the channel being looked at (open, reconnect P0, key arrival) — never per server', () => {
        const calls = [...dash.matchAll(/refreshChannelHistory(?:Ref\.current)?\(/g)].map(m => {
            const line = dash.slice(dash.lastIndexOf('\n', m.index) + 1, dash.indexOf('\n', m.index));
            return line.trim();
        });
        expect(calls).toEqual([
            'q.add(() => refreshChannelHistoryRef.current(sid, cid), P_VISIBLE);',   // reconnect: the open channel only
            'void refreshChannelHistoryRef.current(channel.server_id, channel.channel_id);', // entry key pull: open channel only
            'await refreshChannelHistory(channel.server_id, channel.channel_id);',   // handleSelectChannel
            "await refreshChannelHistory(serverOf.get(channel_id) ?? '', channel_id);", // envelopes-ready: active channel only
        ]);
        // the envelopes-ready re-read stays gated on the active channel
        const ready = dash.slice(dash.indexOf("await refreshChannelHistory(serverOf.get(channel_id) ?? '', channel_id);") - 1500,
            dash.indexOf("await refreshChannelHistory(serverOf.get(channel_id) ?? '', channel_id);"));
        expect(ready).toContain('if (activeChannelRef.current?.channel_id !== channel_id) continue;');
        // so does the re-read after keys already waiting install at channel entry
        const entry = dash.slice(dash.indexOf('void refreshChannelHistoryRef.current(channel.server_id, channel.channel_id);') - 400,
            dash.indexOf('void refreshChannelHistoryRef.current(channel.server_id, channel.channel_id);'));
        expect(entry).toContain('if (activeChannelRef.current?.channel_id === channel.channel_id');
    });

    it('every channel-history GET is bounded to 100 rows', () => {
        const gets = [...dash.matchAll(/axios\.get\(`\$\{API_BASE\}\/channels\/\$\{channelId\}\/messages`/g)];
        // getChannelRows + the mention reconcile (min(unread, 100))
        expect(gets).toHaveLength(2);
        expect(dash).toContain('params: { limit: Math.min(unreadCount, 100) }');
    });

    it('gap fills use the keyset cursors (before_id / after_id), each sending the ISO fallback too', () => {
        const fill = body(dash, 'const fillChannelHistoryGap = useCallback', 'const loadChannelMessageContext = useCallback');
        expect(fill).toContain('before_id: cursor.id, before: new Date(cursor.ts).toISOString()');
        expect(fill).toContain('after_id: cursor.id, after: new Date(cursor.ts).toISOString()');
        // an after_id fill is never trusted against an API that would ignore it
        expect(fill.indexOf('probeHistoryModes(')).toBeLessThan(fill.indexOf('after_id'));
    });

    it('server-saved / pinned rows are loaded by id for the open channel, each id once per session', () => {
        const effect = body(dash, 'const savedLoadAttemptedRef = useRef', 'const coverageConnRef = useRef(0);');
        expect(effect).toContain('loadChannelMessagesById(sid, cid, missing)');
        expect(effect).toContain('attempted.add(id)');
        expect(effect).toContain('[openTextChannel, openChannelSavedIds, token, userId, loadChannelMessagesById]');
    });

    it('a key arriving re-tries the open channel\'s placeholders by id, in its OWN effect', () => {
        const eff = body(dash, '// A key landed for the channel on screen', '// Server-saved and pinned messages are always loaded');
        expect(eff).toContain('healChannelPlaceholders(open.server_id, open.channel_id)');
        expect(eff).toContain('[channelKeyEnvelopesReadyEvents, healChannelPlaceholders]');
    });

    it('live edits/deletes/reactions for unloaded messages are parked, not dropped', () => {
        const live = body(dash, 'const handleChannelMessage = useCallback', 'setChannelMessages(prev => {');
        expect(live).toContain('findOrphanActions(channelMessagesRef.current[evt.channel_id] ?? []');
        expect(live).toContain('channelOrphansRef.current = {');
    });

    it('a reconnect demotes "reaches the live top" so missed messages surface as a gap', () => {
        const eff = body(dash, 'const coverageConnRef = useRef(0);', 'const openChannelId = activeChannel?.channel_id;');
        expect(eff).toContain('demoteLiveTop(');
        expect(eff).toContain('[wsConnectCount]');
    });

    it('ChatPane gets the gaps + fill/jump handlers (the old one-shot "older" props are gone)', () => {
        expect(dash).toContain('historyGaps={openChannelGaps}');
        expect(dash).toContain('onFillHistoryGap={fillChannelHistoryGap}');
        expect(dash).toContain('onLoadMessageContext={loadChannelMessageContext}');
        expect(dash).not.toContain('onLoadOlderFromServer');
        expect(dash).not.toContain('channelHistoryExhausted={');
    });
});

describe('channel history paging — ChatPane', () => {
    it('gap rows are interleaved into the rendered feed', () => {
        expect(pane).toContain('const rowEls = displayMessages.map((msg, index) => {');
        expect(pane).toContain('return withHistoryGaps(rowEls, displayMessages);');
    });

    it('scrolling to the top fills the older-history gap once the local window is exhausted', () => {
        const scroll = body(pane, 'onScroll={() => {', 'className="flex-1 overflow-y-auto');
        expect(scroll).toMatch(/if \(pagination\.hasMore\) \{[\s\S]*pagination\.loadMore\(\);[\s\S]*\} else if \(topGap\) \{[\s\S]*fillGap\(topGap, 'auto'\)/);
    });

    it('a gap fill holds the reader\'s row still (anchor captured before, corrected on commit)', () => {
        const fill = body(pane, 'const fillGap = useCallback', 'useEffect(() => {');
        expect(fill.indexOf('captureFillAnchor()')).toBeLessThan(fill.indexOf('await onFillHistoryGap('));
        const effect = body(pane, '// ── Hold the reader\'s row still while a history gap fills', '}, [messages, pagination.displayed]);');
        expect(effect).toContain('correctedScrollTop(');
    });

    it('jump-to-message asks for the page around an unloaded message, then completes the jump', () => {
        const jump = body(pane, 'const jumpToMessage = useCallback', '// Keep the jumpToMessage function accessible');
        expect(jump).toContain('onLoadMessageContext(channelId, resolvedId)');
        expect(pane).toContain('// The page around a jumped-to message has landed: finish the jump.');
    });

    it('a failing gap is not auto-retried in a loop', () => {
        const fill = body(pane, 'const fillGap = useCallback', 'useEffect(() => {');
        expect(fill).toContain("if (how === 'auto' && stalledGapKeys.has(gap.key)) return;");
    });
});

describe('honest placeholders, tombstones, stale-epoch sends (owner report 2026-10-09)', () => {
    it('neither decrypt path hard-codes "key_missing" any more — both classify the failure', () => {
        expect(dash).not.toMatch(/reason: 'key_missing'/);
        const hist = body(dash, 'const decryptChannelRow = useCallback', 'const decryptChannelRows = useCallback');
        expect(hist).toContain('classifyChannelDecryptFailure(err, channelFailureContext(channelId, m.epoch))');
        const live = body(dash, 'const handleChannelMessage = useCallback', '}, [userId, notify, channelFailureContext]);');
        expect(live).toContain('classifyChannelDecryptFailure(err, channelFailureContext(evt.channel_id, evt.epoch))');
        // only a genuinely missing key files a request from the live path
        expect(live).toMatch(/if \(reason === 'key_missing'\) \{\s*undecryptableChannelsRef\.current\.add\(evt\.channel_id\);\s*void channelKeyOpsRef\.current\.maybeFileKeyRequest/);
    });

    it('every history read drops tombstones before decrypting and removes them from the thread', () => {
        const ingest = body(dash, 'const ingestChannelRows = useCallback', 'const loadChannelMessagesById = useCallback');
        expect(ingest.indexOf('raw.filter(isChannelTombstone)')).toBeLessThan(ingest.indexOf('splitReusableChannelRows('));
        expect(ingest).toContain('folded.filter(m => !tombstoned.has(m.id))');
    });

    it('edits use editedContent on every path (a pill target becomes the edited text)', () => {
        expect(dash.split('editedContent(thread[idx].content, content.text)').length - 1).toBe(2);
        expect(dash).not.toContain('content: { ...thread[idx].content, text: content.text }');
    });

    it('re-tries skip withheld-by-permission rows; saved-row key requests only for missing keys', () => {
        expect(dash).toContain('.filter((m: StoredChannelMsg) => placeholderRetryable(m) && !purged.has(m.id)');
        expect(dash).toContain('undecryptable += kept.filter(placeholderWantsKey).length;');
    });

    it('ChatPane: the pill text comes from the reason; a 409 STALE_EPOCH starts the key fetch on every channel send path', () => {
        expect(pane).toContain('<span>{placeholderLabel(placeholderReason(msg))}</span>');
        expect(pane).not.toContain("<span>Couldn't decrypt — waiting on this channel's key</span>");
        expect(pane.split('isStaleEpochError(err)').length - 1).toBe(3); // delivery queue, composer send, dispatchAction
    });
});
