import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard for channel-key delivery reliability (2026-10-09, after the
 * key-handshake storm fix shipped in 1.0.20).
 *
 * The decision logic is unit-tested in utils/keyDistributionThrottle.test.ts
 * (every re-ask served at once — the 2026-10-09 call incident — latest-first
 * order, owed history, earliest resume wins); the end-to-end timings come from
 * the multi-client harness described in the commit. What only a source check
 * can pin is that Dashboard actually USES each piece. Every assertion names
 * the 1.0.20 code that fails it.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const realtime = readFileSync(join(__dirname, '..', 'hooks', 'useRealtime.ts'), 'utf8');
// The serve pass and the member_join decision live in utils/keyServePass.ts
// since 2026-10-11 (so a simulation can drive them); Dashboard wires effects.
const servePassSrc = readFileSync(join(__dirname, '..', 'utils', 'keyServePass.ts'), 'utf8');

function body(text: string, startMarker: string, endMarker: string): string {
    const a = text.indexOf(startMarker);
    expect(a, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
    const b = text.indexOf(endMarker, a + startMarker.length);
    expect(b, `end marker not found after ${startMarker}: ${endMarker}`).toBeGreaterThan(a);
    return text.slice(a, b);
}

const pull = () => body(src, 'const pullChannelKeysOnce = useCallback', '// ── Channel key backfill protocol');
const serve = () => body(src, 'const serveKeyRequests = useCallback', 'const serveKeyRequestsRef = useRef(');
const pass = () => body(servePassSrc, 'export function serveKeyRequestsPass(', 'export interface MemberJoinDeps');
const joinDecision = () => body(servePassSrc, 'export async function runMemberJoinDistribution(', "return 'distributed';");
const memberJoined = () => body(src, 'const distributeKeysToNewMember = (server_id: string, newUserId: string) => {', '}, [serverMemberJoinedEvents]);');
const connectSweep = () => body(src, '// Connect-time sweep over every server', '// RC-10 / Phase 6: refresh which epochs');
const retryTimer = () => body(src, 'const FALLBACK_ROTATION_AFTER_MS', '}, [token, deviceId, requestMissingChannelKeys, attemptFallbackRotation]);');
const requestMissing = () => body(src, 'const requestMissingChannelKeys = useCallback', 'const refreshProtectedEpochs = useCallback');

describe('keyless side: a pull triggered mid-pull is not dropped', () => {
    it('pullChannelKeys runs inside a per-server SingleFlight (one trailing re-pull), not an in-flight early return', () => {
        const fn = pull();
        expect(src).toContain('const [keyPullFlight] = useState(() => new SingleFlight());');
        expect(fn).toContain('(serverId: string): Promise<void> => keyPullFlight.run(serverId, () => pullChannelKeysOnce(serverId)),');
        // Control (1.0.20): `if (pullChannelKeysInFlightRef.current.has(serverId)) return;`
        // dropped the envelopes_ready push that landed while a pull was decrypting.
        expect(src).not.toContain('pullChannelKeysInFlightRef');
    });
});

describe('holder side: serving key requests', () => {
    it('Dashboard delegates the pass to serveKeyRequestsPass with the session-wide ledger / back-off / single-flight', () => {
        const fn = serve();
        expect(fn).toContain('return serveKeyRequestsPass({');
        for (const dep of ['backoff: handshakeBackoff', 'ledger: deliveryLedger', 'flight: keyServeFlight', 'distribute: distributeChannelKeys', 'owed: owedKeyServesRef.current']) {
            expect(fn).toContain(dep);
        }
    });

    it('answering is keyed on the request VERSION only: no time window, no "already sent" skip (2026-10-09 call incident)', () => {
        const fn = pass();
        // An unacked envelope is not proof of delivery; the device re-asking
        // (a new version) must always be served. Nothing in the pass may skip
        // a request because something was sent to it earlier.
        expect(fn).toContain('ledger.allDelivered(req.channel_id, epochs, req.requester_device_id, version, askSeenAt)');
        expect(fn).not.toMatch(/REDELIVERY_COOLDOWN|cooldown|satisfied_epochs|respace/i);
    });

    it('sends every request\'s newest epoch before any history (unless the batch route serves each request whole)', () => {
        expect(pass()).toMatch(/const phases = whole\s*\?\s*\(many \? groupPhasesByRequester\(wholeRequestPhases\(walk\)\) : wholeRequestPhases\(walk\)\)\s*:\s*latestFirstPhases\(walk\);/);
    });

    it('a request that threw is NOT marked answered (the next trigger retries it)', () => {
        const fn = pass();
        const loop = fn.slice(fn.indexOf('for (let i = 0; i < phases.length; i++) {'), fn.indexOf('// The rest — this item included'));
        expect(loop).toContain('unfinished.add(version);');                       // per request
        expect(loop).toContain('for (const en of entries) unfinished.add(en.requestVersion);'); // per device (distributeMany)
        expect(fn).toMatch(/if \(unfinished\.has\(version\)\) continue;\s*answered\.add\(version\);/);
    });

    it('a pass that stops part-way OWES the rest to its resume — even once the request closes server-side', () => {
        const fn = pass();
        // Latest-first means the device acks the newest epoch first, which
        // closes its request; the history must still go out from this holder.
        expect(fn).toContain('recordOwed(deps.owed, phases.slice(stoppedAt), deps.now());');
        expect(fn).toContain('const owedItems = takeOwed(deps.owed, listed, answered, now);');
        expect(fn).toContain('open.push(...owedItems);');
    });

    it('yields before more HISTORY when new asks arrived mid-pass (their newest epochs go first)', () => {
        const fn = pass();
        const guard = fn.slice(fn.indexOf('if (i >= latestCount && flight.hasPendingRerun(serverId)) {'));
        expect(guard.length).toBeGreaterThan(0);
        expect(guard.slice(0, 700)).toContain('stop = true; stoppedAt = i; break;');
    });

    it('passes when it first saw each ask, so an ask that a member_join delivery already answered is not re-sent', () => {
        const fn = pass();
        expect(fn).toContain('if (!seenAt.has(version)) seenAt.set(version, now);');
        expect(fn).toContain('{ requestVersion: version, requestSeenAt: askSeenAt, budget }');
        expect(fn).toContain('ledger.allDelivered(req.channel_id, epochs, req.requester_device_id, version, askSeenAt)');
    });

    it('fetches each requesting user\'s devices once per pass, not once per request', () => {
        expect(pass()).toContain('const devicesByUser = new Map<string,');
        expect(pass()).toContain('p = deps.getMemberDevices(serverId, uid);');
        expect(serve().match(/\/members\/\$\{[a-z_.]+\}\/devices`/g)).toHaveLength(1);
    });
});

describe('holder side: server:member_joined', () => {
    it('useRealtime queues every member_joined (no single slot that keeps only the last)', () => {
        expect(realtime).toContain('setServerMemberJoinedEvents(prev => [...prev, {');
        expect(realtime).not.toContain('setServerMemberJoinedEvent(');
    });

    it('Dashboard drains the whole queue, and sends every channel\'s newest epoch first', () => {
        const fn = memberJoined();
        expect(fn).toContain('for (const { server_id, user_id: newUserId } of batch) {');
        expect(fn).toContain('distributeKeysToNewMember(server_id, newUserId);');
        expect(fn).toContain('void runMemberJoinDistribution({');
        expect(fn).toContain('distribute: distributeChannelKeys,');
        const join = joinDecision();
        expect(join).toContain('for (const { item, epochs } of (deps.batched?.() === true ? wholeRequestPhases(plan) : latestFirstPhases(plan))) {');
        expect(join).toContain("await deps.distribute(serverId, item.channelId, epochs, recipients, 'member_join');");
    });
});

describe('background: independent of what the UI is showing', () => {
    it('the connect sweep covers EVERY joined server, own requests and serving side by side', () => {
        const fn = connectSweep();
        expect(fn).toContain('const list = [...servers];');
        expect(fn).toContain('for (const srv of list) await requestMissingChannelKeys(srv.server_id);');
        expect(fn).toContain('for (const srv of list) await serveKeyRequests(srv.server_id);');
        expect(fn).toContain('Promise.all([');
        // No dependency on the open server / active channel.
        expect(fn).not.toContain('activeServerView');
        expect(fn).not.toContain('activeChannel');
    });

    it('the retry timer re-requests gated channels of servers whose channel list was never loaded', () => {
        expect(requestMissing()).toContain('keyChannelServerRef.current.set(c.channel_id, serverId);');
        const fn = retryTimer();
        expect(fn).toContain('keyChannelServerRef.current.get(cid)');
        // …but the fallback ROTATION stays scoped to loaded servers (as before).
        const fallback = fn.slice(fn.indexOf('for (const cid of due) {'));
        expect(fallback.slice(0, 200)).toContain('channelToServer.get(cid)');
        expect(fallback.slice(0, 200)).not.toContain('keyChannelServerRef');
    });

    it('serving is driven by WS events and timers only — never gated on the open server', () => {
        const fn = serve();
        expect(fn).not.toContain('activeServerView');
        expect(fn).not.toContain('activeChannelRef');
        expect(memberJoined()).not.toContain('activeServerView');
    });
});

describe('keyless / stale side: say "that did not work" (2026-10-09 call incident)', () => {
    it('a key envelope that fails to install triggers a (deduped) re-ask right away, not only after the give-up', () => {
        const fn = pull();
        const fail = fn.slice(fn.indexOf('const failCount = (envelopeFailureCountRef.current.get(key) ?? 0) + 1;'));
        const notGivingUp = fail.slice(fail.indexOf('} else {'), fail.indexOf('} else {') + 1200);
        expect(notGivingUp).toContain('void channelKeyOpsRef.current.maybeFileKeyRequest(serverId, env.channel_id, [env.epoch]);');
    });

    it('opening / joining a channel that holds an OLDER epoch than the server\'s newest re-asks for it', () => {
        const fn = body(src, 'const ensureChannelKeyBootstrap = useCallback', 'const handleSelectChannel = useCallback');
        expect(fn).toContain('if (existingEpoch != null && latestEpoch !== undefined && existingEpoch < latestEpoch) {');
        const branch = fn.slice(fn.indexOf('existingEpoch < latestEpoch) {'));
        expect(branch.slice(0, 260)).toContain('maybeFileKeyRequest(channel.server_id, channel.channel_id, askableEpochRange(existingEpoch, latestEpoch))');
    });
});

describe('idle holder: rotation for a server never opened this session', () => {
    it('looks the channel up from the API when it is not in the loaded channel list (no skip_unknown_channel for idle holders)', () => {
        const fn = body(src, 'const rotateCallsChannelKey = useCallback', 'rotationInFlightRef.current.add(channelId);');
        expect(fn).toContain("let loaded = (serverChannelsRef.current[serverId] ?? []).find(c => c.channel_id === channelId);");
        const fallback = fn.slice(fn.indexOf('} else {', fn.indexOf('let loaded')));
        expect(fallback.slice(0, 400)).toContain('/servers/${serverId}/channels`');
        // Permission check still applies to a fetched channel.
        expect(fn).toContain('if (!canMintChannelKey(loaded.kind, perms)) return;');
        // Control (before): the kind came ONLY from serverChannelsRef.
        expect(fn).not.toMatch(/const kind = \(serverChannelsRef\.current\[serverId\] \?\? \[\]\)\s*\.find/);
    });
});

describe('2026-10-11 key-delivery latency ("had to wait 5 mins for the keys")', () => {
    // The ask path (per-server batch): prepareKeyAsk reads whether the channel is keyless,
    // finishKeyAsk arms the re-ask from the answer — shared by the single and batch POSTs.
    const fileReq = () => body(src, 'const prepareKeyAsk = useCallback', 'const maybeFileKeyRequest = useCallback');
    const reaskTick = () => body(src, 'reaskTickRef.current = (sid) => runReaskTick({', '}, sid);');

    it('a key request filed while holding NO key arms the fast re-ask (never a stale channel — 2026-10-07 storm)', () => {
        const fn = fileReq();
        expect(fn).toContain('keyless = (await window.electronAPI!.getLatestChannelEpoch(channelId)) === null;');
        const arm = fn.slice(fn.indexOf('if (ask.keyless && latestEpoch !== 0) {'));
        expect(arm.slice(0, 400)).toContain('keyReaskTargets.add(serverId, channelId,');
        expect(arm.slice(0, 400)).toContain('keyReaskScheduler.arm(serverId);');
        // Arming happens only inside that branch.
        expect(fn.match(/keyReaskScheduler\.arm\(/g)).toHaveLength(1);
        // Both POST paths go through finishKeyAsk, so single and batch asks arm alike.
        expect(fn.match(/finishKeyAsk\(serverId, (channelId|l\.channelId), (ask|l\.ask), /g)!.length).toBeGreaterThanOrEqual(5);
    });

    it('the re-ask check works on those targets and is satisfied only by the NEWEST epoch the API named', () => {
        const fn = reaskTick();
        expect(fn).toContain('wantedChannels: (s) => keyReaskTargets.forServer(s),');
        expect(fn).toContain('return held !== null && held >= (keyReaskTargets.latestOf(cid) ?? 1);');
        expect(fn).toContain('fileKeyRequest: (s, cid) => channelKeyOpsRef.current.fileKeyRequest(s, cid),');
        expect(body(src, 'onExhausted: (sid) => {', 'keyReaskTargets.clearServer(sid);')).toContain('noteNewestKeyPending(cid, false)');
    });

    it('every key-handshake POST has a timeout (a hung POST no longer holds the account\'s distributions for ~100 s)', () => {
        const fn = body(src, 'const distributeChannelKeys = useCallback', 'const mayMintChannelKey = useCallback');
        const post = fn.slice(fn.indexOf('/key-handshake`'));
        expect(post.slice(0, 400)).toContain('timeout: KEY_HANDSHAKE_POST_TIMEOUT_MS');
    });

    it('holders answer a key_requested push after the short serve jitter, each from its own walk offset', () => {
        expect(src).toContain('}, pickServeJitterMs());');
        expect(serve()).toContain('walkOffset: walkOffsetFor(deviceId),');
    });
});
