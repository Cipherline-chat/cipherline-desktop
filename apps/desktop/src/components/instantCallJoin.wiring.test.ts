import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Instant call join — source-level wiring pins (Dashboard / CallPane /
 * SidebarConference have no render harness). The decisions themselves are
 * unit-tested in utils/callJoinFlow.test.ts and utils/micPrewarm.test.ts;
 * these pin that every join path actually uses them, and that the optimistic
 * UI never loosened the encryption gate. Each names the way it would go wrong.
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dash = read('Dashboard.tsx');
const pane = read('CallPane.tsx');
const conf = read('SidebarConference.tsx');
const chat = read('ChatPane.tsx');
const bar = read('call/JoiningControlBar.tsx');

/** Source between two markers (both must exist, in order). */
function between(src: string, from: string, to: string): string {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    expect(a, `marker not found: ${from}`).toBeGreaterThan(-1);
    expect(b, `end marker not found: ${to}`).toBeGreaterThan(a);
    return src.slice(a, b);
}

/** beginCallJoin comes before the first network await, and the call is set only after settleCallJoin. */
function expectOptimisticThenSettled(block: string, name: string) {
    const begin = block.indexOf('beginCallJoin(');
    const firstAwait = block.search(/await (axios|spawnHuddleCall|joinHuddleCall|Promise\.all)/);
    const settle = block.indexOf('settleCallJoin(attempt)');
    const set = block.indexOf('setActiveCall({');
    expect(begin, `${name}: beginCallJoin`).toBeGreaterThan(-1);
    expect(firstAwait, `${name}: a network await`).toBeGreaterThan(-1);
    expect(begin, `${name}: UI must go up BEFORE the first round trip`).toBeLessThan(firstAwait);
    expect(settle, `${name}: settle`).toBeGreaterThan(firstAwait);
    expect(set, `${name}: the call is committed only after settle`).toBeGreaterThan(settle);
}

describe('every join path is optimistic and settle-gated', () => {
    it('server voice channel (handleJoinVoiceChannel)', () => {
        const b = between(dash, 'const handleJoinVoiceChannel = useCallback', '// ── Huddle call lifecycle handlers');
        expectOptimisticThenSettled(b, 'voice');
        // abandoned join is undone server-side, guarded against a same-channel re-click
        expect(b).toMatch(/if \(!settleCallJoin\(attempt\)\) \{[\s\S]*?joinTracker\.mayUndo\(attempt\)[\s\S]*?leave_voice/);
        // a failed join only rolls back the highlight if it is still the live join
        expect(b).toContain("if (failCallJoin(attempt, err, 'voice')) setActiveVoiceChannelId(null);");
        expect(b).not.toContain('setIsStartingCall(');
    });

    it('Calls channel: spawn', () => {
        const b = between(dash, 'const handleSpawnHuddleCall = useCallback', '/** Join an *existing* call under a Huddle');
        expectOptimisticThenSettled(b, 'huddle-spawn');
        expect(b).toMatch(/if \(!settleCallJoin\(attempt\)\) \{[\s\S]*?leaveHuddleCall\(res\.call_id\)/);
        expect(b).toContain("failCallJoin(attempt, err, 'huddle-spawn');");
    });

    it('Calls channel: join existing (key derives from the huddle id known locally)', () => {
        const b = between(dash, 'const handleJoinExistingHuddleCall = useCallback', '/** Leave the current Huddle call (no spawn). */');
        expectOptimisticThenSettled(b, 'huddle-join');
        expect(b).toContain("beginCallJoin('huddle-join', `huddle-call:${callId}`, huddleIdForKey, {");
        expect(b).toMatch(/joinTracker\.mayUndo\(attempt\)\) leaveHuddleCall\(res\.call_id\)/);
    });

    it('DM/group: start from the friends list (startGlobalCall)', () => {
        const b = between(dash, 'const startGlobalCall = async', 'const [, setGroupMemberContextId]');
        expectOptimisticThenSettled(b, 'dm-start');
        // abandoned start ends the session it created rather than leaving it ringing
        expect(b).toMatch(/if \(!settleCallJoin\(attempt\)\) \{[\s\S]*?if \(!joined && joinTracker\.mayUndo\(attempt\)\) axios\.post\(`\$\{API_BASE\}\/calls\/\$\{initRes\.data\.session_id\}\/end`/);
        // key generation overlaps the start request
        expect(b).toMatch(/Promise\.all\(\[\s*generateCallKey\(\),\s*axios\.post\(`\$\{API_BASE\}\/calls\/start`/);
    });

    it('DM/group: answer (acceptGlobalCall)', () => {
        const b = between(dash, 'const acceptGlobalCall = async', 'const leavePreviousServerCall = () =>');
        expectOptimisticThenSettled(b, 'dm-accept');
        // the ring card goes on the click, not after the round trip
        expect(b.indexOf('setGlobalIncomingCall(null);')).toBeLessThan(b.indexOf('await axios'));
    });

    it('DM/group: "Join Call" banner and crash-recovery rejoin', () => {
        const banner = between(dash, "const attempt = beginCallJoin('dm-join', `call:${status.session_id}`, null, {", 'Join Call');
        expect(banner).toContain('if (!settleCallJoin(attempt)) return;');
        expect(banner).toContain("failCallJoin(attempt, e, 'dm-join');");
        const rejoin = between(dash, 'const acceptRejoin = useCallback', '// Optimistically append a sent channel message');
        expectOptimisticThenSettled(rejoin, 'rejoin');
    });

    it('ChatPane start: reported through the same machinery, and an abandoned start is not connected', () => {
        expect(dash).toContain('onStartingCallChange={handleChatPaneStartingCall}');
        const h = between(dash, 'const handleChatPaneStartingCall = (starting: boolean) => {', '};');
        expect(h).toContain("beginCallJoin('dm-start', 'chatpane-start', null,");
        const conv = between(dash, 'const handleConvCallChange = async', 'const chatPaneJoinRef');
        expect(conv).toMatch(/if \(!settleCallJoin\(attempt\)\) \{[\s\S]*?joinTracker\.mayUndo\(attempt\)[\s\S]*?\/calls\/\$\{callData\.id\}\/end[\s\S]*?return;/);
    });
});

describe('real latency cuts', () => {
    it('leaving the previous server call is never awaited in front of a DM call any more', () => {
        for (const [from, to] of [
            ['const startGlobalCall = async', 'const [, setGroupMemberContextId]'],
            ['const acceptGlobalCall = async', 'const leavePreviousServerCall = () =>'],
            ['const handleConvCallChange = async', 'const chatPaneJoinRef'],
        ] as const) {
            const b = between(dash, from, to);
            expect(b, from).toContain('leavePreviousServerCall();');
            expect(b, from).not.toMatch(/await axios\.post\(\s*`\$\{API_BASE\}\/channels\/\$\{activeVoiceChannelId\}\/leave_voice`/);
            expect(b, from).not.toContain('await leaveHuddleCall(');
        }
    });

    it('ChatPane runs key generation, the device fetch and /calls/start together, and ends a session it orphaned', () => {
        const b = between(chat, 'const executeStartCall = async', '// If the server merged this start');
        expect(b).toContain('await Promise.allSettled([');
        expect(b).toMatch(/generateCallKey\(\),[\s\S]*?devices\?claim_otp=1[\s\S]*?\/calls\/start/);
        expect(b).toMatch(/initR\.status === 'fulfilled' && !initR\.value\.data\?\.joined[\s\S]*?\/end`/);
    });

    it('the Calls-channel key derives while the join request is in flight', () => {
        expect(dash).toContain('const callsChannelKey = useCallsChannelKey(activeCallsChannelId ?? pendingKeyChannelId);');
        expect(dash).toMatch(/const beginCallJoin = useCallback\([\s\S]*?setPendingKeyChannelId\(keyChannelId\);/);
        expect(dash).toMatch(/const beginCallJoin = useCallback\([\s\S]*?prefetchRnnoiseSources\(\);[\s\S]*?prewarmMic\(/);
    });
});

describe('the encryption gate is exactly as strict as before', () => {
    it('the derived key is still bound to the ACTIVE call\'s channel, never the pending one', () => {
        // freshCallsKeyB64 compares against activeCallsChannelId (activeCall's own
        // channel). Comparing against the pending id would let a key derived for
        // the clicked channel stand in for whatever the server put us in.
        expect(dash).toContain("callsChannelKey.status === 'ready' && callsChannelKey.channelId === activeCallsChannelId");
        expect(dash).toMatch(/resolveCallKeyGate\(\{\s*channelId: activeCallsChannelId,/);
        expect(dash).toContain('const activeCallsChannelId = activeCall?.callsChannelId ?? null;');
    });

    it('CallPane still mounts only on a connect verdict with a non-empty key', () => {
        expect(dash).toContain("if (callsChannelGate.kind !== 'connect') {\n                    return null;");
        expect(dash).toContain("console.error('[CallKey] Refusing to mount CallPane with an empty room key');");
    });

    it('the joining placeholders render nothing media-related: no CallPane, no LiveKit', () => {
        const imports = bar.split('\n').filter(l => l.startsWith('import ')).join('\n');
        expect(imports).toContain("from 'lucide-react'"); // positive control: the import scan sees imports
        expect(imports).not.toMatch(/livekit|CallPane|SidebarConference|micPrewarm/i);
    });
});

describe('handover to the real controls', () => {
    it('CallPane mounts SidebarConference (tiles + real ControlBar) only once the room is Connected', () => {
        expect(pane).toContain('{roomConnected && <CallSidebarPortal');
        const handover = between(pane, 'const doHandover = useCallback(() => {', '}, []);');
        expect(handover).toContain('if (h.done) return;'); // exactly once
        expect(handover).toContain('setRoomConnected(true);');
        expect(handover).toContain('notify?.();');
        // intent is latched at the handover and handed to SidebarConference
        expect(handover).toContain('setLatchedIntent({ muted: i.muted, deafened: i.deafened });');
        expect(handover).toContain('setSidebarSeed({ muted: i.muted, deafened: i.deafened });');
        expect(pane).toContain('initialMuted={sidebarSeed?.muted}');
        expect(pane).toContain('initialDeafened={sidebarSeed?.deafened}');
        // seed is single-use: cleared once the first SidebarConference has mounted
        expect(pane).toMatch(/if \(root && instantEnter\) onSeedConsumed\?\.\(\);/);
    });

    it('the handover waits for our mic (no mic-off flash on our own entry), bounded', () => {
        const onConnected = between(pane, 'onConnected={() => {', 'onDisconnected=');
        // no mic coming -> hand over at Connected; mic already up -> now; else wait, capped
        expect(onConnected).toMatch(/if \(!joinWithMic\) \{[\s\S]*?doHandover\(\);[\s\S]*?\} else if \(h\.micUp\) \{\s*doHandover\(\);[\s\S]*?h\.timer = window\.setTimeout\(doHandover, HANDOVER_MIC_WAIT_MS\);/);
        expect(pane).toMatch(/const onFirstMic = useCallback\(\(\) => \{\s*handoverRef\.current\.micUp = true;\s*if \(handoverRef\.current\.connected\) doHandover\(\);/);
        expect(pane).toContain('export const HANDOVER_MIC_WAIT_MS = 1000;');
        expect(pane).toContain('onFirstMic={onFirstMic}');
    });

    it('a muted/deafened join never asks LiveKit to publish the mic; the token grant still applies', () => {
        expect(pane).toContain('const joinWithMic = grants.microphone && !joinIntent.muted && !joinIntent.deafened;');
        expect(pane).toContain('audio={joinWithMic}');
        expect(pane).not.toContain('audio={grants.microphone}');
    });

    it('Dashboard swaps the joining controls out in the same commit the room connects', () => {
        expect(dash).toContain('onRoomConnected={() => setRoomConnectedCallId(call.id)}');
        expect(dash).toContain('{callPaneActive && joinPending && (');
        expect(dash).toMatch(/const joinPhase = deriveCallJoinPhase\(\{\s*isStartingCall,\s*activeCallId: activeCall\?\.id \?\? null,\s*keyGateKind: callsChannelGate\.kind,\s*roomConnectedCallId,/);
        // a stale "connected" never applies to a different call
        expect(dash).toContain('if (roomConnectedCallId !== null && roomConnectedCallId !== (activeCall?.id ?? null)) setRoomConnectedCallId(null);');
    });

    it('Leave on the joining controls cancels an in-flight join, or does the real leave once joined', () => {
        const leave = between(dash, 'onLeave={() => {\n                                        if (!activeCall) {', 'void handleDisconnectCall(false);');
        expect(leave).toContain('cancelCallJoin();');
        expect(leave).toContain('if (activeVoiceChannelId) setActiveVoiceChannelId(null);');
    });

    it('SidebarConference seeds its deafen / mute state from the join intent (and only at mount)', () => {
        expect(conf).toContain('const [localDeafened, setLocalDeafened] = React.useState(() => !!initialDeafened);');
        expect(conf).toContain('const wasMutedBeforeDeafenRef = React.useRef(!!initialMuted);');
        // and the intent is cleared in Dashboard after connect, so a remount can't re-apply it
        expect(dash).toContain("if (joinPhase === 'connected' && (joinIntent.muted || joinIntent.deafened)) setJoinIntent({ muted: false, deafened: false });");
    });

    it('no entrance animation on the joining controls (portal-reparent rule)', () => {
        expect(bar).not.toContain('framer-motion');
        expect(bar).not.toMatch(/animate-(in|fade|bounce|pulse)/);
        // the spinner stops under reduced motion
        expect(bar).toContain('motion-safe:animate-spin');
    });
});
