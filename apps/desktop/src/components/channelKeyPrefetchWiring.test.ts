import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard for proactive channel-key acquisition (owner report, stable
 * 1.0.22: "some chats' channel keys don't load until I go into the chat, and
 * then I have to wait").
 *
 * The decisions are unit-tested in utils/channelKeyPrefetch.test.ts (plan,
 * dedupe, re-ask back-off, pacing under the 60/min bucket, 429 put-back). What
 * only a source check can pin is that Dashboard USES each piece, on every
 * trigger, for every server, with nothing about the open server / focused
 * window / selected channel in the path. Each assertion names what the
 * pre-change code did that fails it.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function body(startMarker: string, endMarker: string): string {
    const a = src.indexOf(startMarker);
    expect(a, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
    const b = src.indexOf(endMarker, a + startMarker.length);
    expect(b, `end marker not found after ${startMarker}: ${endMarker}`).toBeGreaterThan(a);
    return src.slice(a, b);
}

const sweep = () => body('const requestMissingChannelKeys = useCallback', 'const refreshProtectedEpochs = useCallback');
// The ask path (per-server batch, 2026-10-21): prepareKeyAsk (cool-off, 429 gate,
// dedup stamp) -> POST (askOne = one channel; askMany = one server, 404/405 falls
// back to askOne via the queue) -> finishKeyAsk (the answer applied per channel).
const prepareAsk = () => body('const prepareKeyAsk = useCallback', 'const finishKeyAsk = useCallback');
const finishAsk = () => body('const finishKeyAsk = useCallback', 'const fileKeyRequest = useCallback');
const askOne = () => body('const fileKeyRequest = useCallback', 'const fileKeyRequests = useCallback');
const askMany = () => body('const fileKeyRequests = useCallback', 'const fileKeyRequestsRef = useRef(');
const tick = () => body('// Safety net behind the event triggers', '// One re-check of a server with channels');

describe('the sweep asks through the planner and the paced queue, not an inline loop', () => {
    it('plans from the freshly fetched VIEW-filtered channel list and enqueues the asks', () => {
        const fn = sweep();
        expect(fn).toContain("const res = await axios.get(apiUrl`/servers/${serverId}/channels`");
        expect(fn).toContain('const plan = planKeyPrefetch({');
        expect(fn).toContain('channels,');
        expect(fn).toContain('held: localLatest,');
        expect(fn).toContain("mode: opts?.background ? 'tick' : 'event',");
        expect(fn).toContain('keyAskQueue.enqueue({ serverId, channelId: a.channelId, priority: a.keyless ? \'keyless\' : \'stale\', targetEpoch: a.targetEpoch, ...(a.epochs ? { epochs: a.epochs } : {}) });');
        expect(fn).toContain('for (const cid of plan.satisfied) keyPrefetchLedger.delete(cid);');
    });

    it('control (1.0.22): no inline "await fileKeyRequest" + 150 ms sleep loop, which fired 400 requests/min at a 60/min bucket', () => {
        const fn = sweep();
        expect(fn).not.toMatch(/await fileKeyRequest\(serverId, cid\)/);
        expect(fn).not.toMatch(/setTimeout\(r, 150\)/);
        expect(fn).not.toContain('computeMissingKeyChannels(channels, localLatest)');
    });

    it('the history-gap ask goes through the same queue (so it is paced and put back too), and still on its back-off', () => {
        const fn = sweep();
        expect(fn).toContain('const gap = decideGapReask(missingEpochs, gapAskRef.current.get(c.channel_id), Date.now());');
        expect(fn).toContain("keyAskQueue.enqueue({ serverId, channelId: c.channel_id, priority: 'gap', epochs: [...missingEpochs] });");
        expect(fn).not.toMatch(/await fileKeyRequest\(serverId, c\.channel_id\)/);
    });

    it('does not wait for the drain: the next server\'s sweep must not sit behind this server\'s asks', () => {
        const fn = sweep();
        expect(fn).not.toMatch(/await keyAskQueue\./);
    });
});

describe('fileKeyRequest: one shared view of the bucket, and a refused ask is not a forgotten ask', () => {
    it('records every POST in the account-wide limiter (all paths share it) and the ask in the ledger once accepted', () => {
        // Single and batch each record the POST, then mark it accepted only after it resolved.
        for (const [name, fn, post] of [['single', askOne(), '/key-request`'], ['batch', askMany(), '/key-requests`']] as const) {
            const at = fn.indexOf(post);
            expect(at, name).toBeGreaterThan(-1);
            expect(fn.indexOf('keyAskLimiter.record();'), name).toBeGreaterThan(-1);
            expect(fn.indexOf('keyAskLimiter.record();'), name).toBeLessThan(at);
            expect(fn.indexOf('keyAskLimiter.onAccepted();'), name).toBeGreaterThan(at);
            // an accepted answer is what reaches the ledger (finishKeyAsk's ok branch)
            expect(fn.indexOf('{ ok: true, latestEpoch'), name).toBeGreaterThan(fn.indexOf('keyAskLimiter.onAccepted();'));
        }
        const fin = finishAsk();
        const okBranch = fin.slice(fin.indexOf('if (answer.ok) {'), fin.indexOf('} else {'));
        expect(okBranch).toContain('keyPrefetchLedger.noteSent(channelId');
        expect(fin.indexOf('keyPrefetchLedger.noteSent(channelId')).toBeLessThan(fin.indexOf('} else {'));
    });

    it('a 429 un-stamps the dedup, and queues the ask behind the back-off (1.0.22 stamped it and dropped it)', () => {
        const fin = finishAsk();
        const err = fin.slice(fin.indexOf("recordDelivery('channel_key_request'"));
        expect(err).toContain("if (classifyHandshakeError(answer.error) === 'throttled') {");
        expect(err).toContain('keyRequestDedupRef.current.delete(channelId);');
        expect(err).toContain("keyAskQueue.enqueue({ serverId, channelId, priority: 'forced', ...(ask.askEpochs ? { epochs: ask.askEpochs } : {}) });");
        // The account-wide back-off itself starts in the POST path's catch, BEFORE the answer is applied.
        for (const fn of [askOne(), askMany()]) {
            const c = fn.slice(fn.lastIndexOf('} catch (e) {'));
            expect(c.indexOf('noteKeyRequestError(keyAskLimiter, e);')).toBeGreaterThan(-1);
            expect(c.indexOf('noteKeyRequestError(keyAskLimiter, e);')).toBeLessThan(c.indexOf('finishKeyAsk('));
        }
    });

    it('while the account is in a 429 back-off it does not POST into it - it queues the ask forced', () => {
        const fn = prepareAsk();
        const blocked = fn.slice(fn.indexOf('if (keyAskLimiter.isBlocked()) {'));
        expect(blocked.slice(0, 300)).toContain("keyAskQueue.enqueue({ serverId, channelId, priority: 'forced', ...(askEpochs ? { epochs: askEpochs } : {}) });");
        expect(blocked.slice(0, 300)).toContain("return { skip: 'throttled' };");
        // …before it stamps the dedup (a POST that is not going to happen)
        expect(fn.indexOf('if (keyAskLimiter.isBlocked()) {')).toBeLessThan(fn.indexOf('keyRequestDedupRef.current.set(channelId, Date.now());'));
        // …and a skipped ask never reaches the limiter's record(): both paths
        // return/skip on `skip` before recording a POST.
        const one = askOne();
        expect(one.indexOf("if ('skip' in ask) return ask.skip;")).toBeGreaterThan(-1);
        expect(one.indexOf("if ('skip' in ask) return ask.skip;")).toBeLessThan(one.indexOf('keyAskLimiter.record();'));
        const many = askMany();
        expect(many.indexOf("'skip' in p ? [] :")).toBeGreaterThan(-1);
        expect(many.indexOf("'skip' in p ? [] :")).toBeLessThan(many.indexOf('keyAskLimiter.record();'));
        expect(many.indexOf('if (!live.length) return outcomes;')).toBeLessThan(many.indexOf('keyAskLimiter.record();'));
    });

    it('a genuine re-ask after an undecryptable envelope is still its own path: maybeFileKeyRequest, never the planner\'s ledger', () => {
        const pull = body('const pullChannelKeysOnce = useCallback', '// ── Channel key backfill protocol');
        expect(pull).toContain('void channelKeyOpsRef.current.maybeFileKeyRequest(serverId, env.channel_id, [env.epoch]);');
        const maybe = body('const maybeFileKeyRequest = useCallback', 'const requestMissingChannelKeys = useCallback');
        expect(maybe).toContain('await fileKeyRequest(serverId, channelId, epochs);');
        expect(maybe).not.toContain('keyPrefetchLedger');
    });
});

describe('the queue\'s effects', () => {
    it('re-checks just before sending (refineQueuedAsk on what is held NOW), and never for a server the member has left', () => {
        const fn = body('keyAskWantedRef.current = async (ask) => {', 'return r.send;');
        expect(fn).toContain('serversRef.current.some(s => s.server_id === ask.serverId)');
        expect(fn).toContain('heldEpochs = await window.electronAPI!.listChannelEpochs(ask.channelId)');
        expect(fn).toContain('const r = refineQueuedAsk(ask, {');
        expect(fn).toContain('knownGap: gapAskRef.current.get(ask.channelId)?.epochs,');
        expect(fn).toContain('lastAskedAt: keyRequestDedupRef.current.get(ask.channelId),');
        // what it sends is what is still missing
        expect(fn).toContain('if (r.send && r.epochs) ask.epochs = r.epochs;');
    });

    it('sends through fileKeyRequest (the one place that records into the limiter)', () => {
        expect(src).toContain('keyAskSendRef.current = (ask) => channelKeyOpsRef.current.fileKeyRequest(ask.serverId, ask.channelId, ask.epochs);');
    });

    it('is dropped on sign-out / account switch like every other piece of key-wait state', () => {
        expect(src).toMatch(/keyAskQueue\.clear\(\); keyPrefetchLedger\.clear\(\); \}, \[userId,/);
    });
});

describe('triggers: every server, whatever is open', () => {
    it('the connect sweep covers every joined server (unchanged), through the planner', () => {
        const fn = body('// Connect-time sweep over every server', '// RC-10 / Phase 6: refresh which epochs');
        expect(fn).toContain('for (const srv of list) await requestMissingChannelKeys(srv.server_id);');
        expect(fn).toContain('const list = [...servers];');
    });

    it('a permission change re-plans the server (a VIEW grant makes channels plannable at once)', () => {
        const fn = body('Handle server:permissions_changed', '}, [permissionsChangedEvent]);');
        expect(fn).toContain('void requestMissingChannelKeys(server_id);');
    });

    it('a channel created / moved / deleted re-plans the server (a new channel is keyed by the creator; we ask for it)', () => {
        const fn = body('A channel was created/updated/deleted somewhere', '}, [channelsChangedEvent]);');
        expect(fn).toContain('void requestMissingChannelKeys(server_id);');
    });

    it('joining a server by invite re-plans it now and again after the join distribution had time to land', () => {
        const fn = body('Pull any channel keys that existing members have already', 'Modal calls its own onClose() after this resolves');
        expect(fn).toContain('void requestMissingChannelKeys(result.server_id);');
        expect(fn).toContain('setTimeout(() => void requestMissingChannelKeys(result.server_id), 3000);');
    });

    it('opening a server from the rail re-plans it too (the open server is never the ONLY one covered)', () => {
        const fn = body('const openRailServer = (srv: ServerInfo) => {', 'closeRailFolder();');
        expect(fn).toContain('void requestMissingChannelKeys(srv.server_id);');
    });

    it('a periodic tick re-plans EVERY joined server in the background, independent of focus, visibility, the open server or channel', () => {
        const fn = tick();
        expect(fn).toContain('for (const srv of serversRef.current) await requestMissingRef.current(srv.server_id, { background: true });');
        expect(fn).toContain('}, PREFETCH_TICK_MS);');
        expect(fn).not.toContain('activeServerView');
        expect(fn).not.toContain('activeChannel');
        expect(fn).not.toContain('visibilityState');
        expect(fn).not.toContain('hasFocus');
    });

    it('the tick reads the sweep through a ref, so a re-created callback does not reset its clock', () => {
        const fn = tick();
        expect(fn).toMatch(/\}, \[token, deviceId\]\);/);
        expect(src).toContain('useEffect(() => { requestMissingRef.current = requestMissingChannelKeys; });');
    });
});

describe('holder side: any online device answers, whatever it has open (idle, hidden, another server, Home)', () => {
    const ui = ['serverChannels', 'serverChannelsRef', 'activeServerView', 'activeChannel', 'hasFocus', 'visibilityState', 'loadedServers'];

    it('the serve pass, its effects and the distribution read no UI state', () => {
        for (const fn of [
            body('const serveKeyRequests = useCallback', 'const serveKeyRequestsRef = useRef('),
            body('const distributeChannelKeys = useCallback', 'const mayMintChannelKey = useCallback'),
        ]) {
            for (const word of ui) expect(fn, word).not.toContain(word);
        }
    });

    it('a server:key_requested push schedules a serve for that server unconditionally (own device excepted)', () => {
        const fn = body('A member device just asked for keys we may hold', '}, [keyRequestedEvents]);');
        expect(fn).toContain('coalesceKeyRequestEvents(keyRequestedEvents, deviceId)');
        expect(fn).toContain('void serveKeyRequests(serverId);');
        for (const word of ui) expect(fn, word).not.toContain(word);
    });

    it('the WebSocket handler queues the push without looking at presence, focus or the open server', () => {
        const realtime = readFileSync(join(__dirname, '..', 'hooks', 'useRealtime.ts'), 'utf8');
        const i = realtime.indexOf("msg.event === 'server:key_requested'");
        expect(i).toBeGreaterThan(-1);
        const handler = realtime.slice(i, i + 500);
        expect(handler).toContain('setKeyRequestedEvents(prev =>');
        for (const word of ['hasFocus', 'visibilityState', 'idle', 'status']) expect(handler, word).not.toContain(word);
    });
});
