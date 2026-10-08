import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Join in place (owner feedback on instant join): the joining user is drawn
 * INSIDE the call view — the huddle card for Calls-channel calls, a mirror of
 * SidebarConference for DM / group / legacy voice — never as a separate block
 * at the top; the only "connecting" signal is the bottom controls; the hand-over
 * to the real view does not re-animate or move; the caller's ringback waits for
 * the connected call. No render harness for these files, so pinned at the
 * source level. Pure logic: utils/joinView.test.ts, utils/ringback.test.ts.
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dash = read('Dashboard.tsx');
const pane = read('CallPane.tsx');
const conf = read('SidebarConference.tsx');
const card = read('call/ParticipantCard.tsx');
const view = read('call/JoiningCallView.tsx');
const scp = read('server/ServerContextPanel.tsx');

describe('the joining view mirrors SidebarConference exactly (drift guard)', () => {
    // Each string is in BOTH files. If SidebarConference's layout changes,
    // this fails until the joining view is changed to match — otherwise the
    // hand-over would jump.
    const shared = [
        'call-no-select w-full flex flex-col relative',
        "'pt-0 pb-0 px-0 gap-0' : 'pt-3 pb-1 px-0 gap-3'",
        "scrollbarGutter: 'stable both-edges'",
        'className="flex flex-col gap-3"',
        "height: 1, marginTop: -13, flexShrink: 0, pointerEvents: 'none', visibility: 'hidden'",
        'rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]',
        'className="flex flex-col w-full"',
        'flex-1 flex flex-row flex-wrap justify-center items-center content-center gap-x-8 gap-y-6',
        // the ringing tile
        'relative z-10 rounded-full overflow-hidden flex items-center justify-center transition-all p-0 border-none ring-1 ring-white/10',
        'absolute inset-0 z-0 bg-cl-lume/20 rounded-full animate-ping pointer-events-none',
        "animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]",
        'text-cl-lume tracking-widest uppercase animate-pulse',
    ];
    for (const s of shared) {
        it(`shares: ${s.slice(0, 60)}`, () => {
            expect(conf).toContain(s);
            expect(view).toContain(s);
        });
    }

    it('rows use the row shell with the local ping; tiles the tile shell at normal size (as SidebarConference does)', () => {
        expect(conf).toMatch(/sizeMode="row"[\s\S]{0,1500}?showLocalPing/);
        expect(view).toContain('<LocalPingReadout stats={null} />');
        expect(view).toContain('sizeMode="normal"');
    });

    it('positive control: the drift guard notices a difference', () => {
        expect(conf).not.toContain('pt-3 pb-2 px-0 gap-3');
        expect(view).not.toContain('pt-3 pb-2 px-0 gap-3');
    });
});

describe('ParticipantCard renders through the shared shells (one markup for both)', () => {
    it('row and tile modes render the shells', () => {
        expect(card).toContain('<ParticipantRowShell');
        expect(card).toContain('<ParticipantTileShell');
    });
    it('no avatar markup left outside the shells', () => {
        const shells = card.indexOf('// ── Presentational shells');
        expect(shells).toBeGreaterThan(-1);
        expect(card.slice(0, shells)).not.toContain('<EncryptedAvatar');
        expect(card.slice(shells).match(/<EncryptedAvatar/g)?.length).toBe(2);
    });
    it('the joining view draws with the same shells', () => {
        expect(view).toContain("import { ParticipantRowShell, ParticipantTileShell, LocalPingReadout } from './ParticipantCard';");
        expect(view).toContain("import { tileMetrics } from './participantTileMetrics';");
    });
});

describe('Dashboard draws you in the call, not at the top', () => {
    it('the old top-of-panel self row is gone', () => {
        expect(dash).not.toContain('JoiningSelfRow');
    });
    it('DM / group / legacy voice: the mirror sits in #call-sidebar-root\'s own box', () => {
        expect(dash).toContain('{joiningCallViewProps && (\n                                        <div className="shrink-0 w-full flex flex-col relative">\n                                            <JoiningCallView {...joiningCallViewProps} />');
        expect(dash).toContain('id="call-sidebar-root"\n                                        className="shrink-0 w-full flex flex-col relative"');
    });
    it('huddles: the server panel and the floating card read the display lists', () => {
        expect(dash).toContain('huddleCalls={huddleDisplay.calls}');
        expect(dash).toContain('activeHuddleCallId={huddleDisplay.mineCallId}');
        expect(dash).toContain("(huddleDisplay.calls[activeHuddleChannelId ?? ''] ?? []).find(c => c.call_id === activeHuddleCallId)");
        // stable key across the client-side → server card change
        expect(scp).toContain('key={c.render_key ?? c.call_id}');
    });
    it('a join view only counts while its join is in flight or its call is ours (no ghost "you")', () => {
        const live = dash.slice(dash.indexOf('const liveJoinView: JoinView | null = (() => {'), dash.indexOf('const huddleDisplay = useMemo('));
        expect(live).toContain('if (isStartingCall || joinPending) return joinView;');
        expect(live).toContain('return id && id === activeHuddleCallId ? joinView : null;');
    });
    it('every failure / cancel clears the view', () => {
        const fail = dash.slice(dash.indexOf('const failCallJoin = useCallback'), dash.indexOf('/** Leave pressed while the join request is still in flight. */'));
        expect(fail).toContain('setJoinView(null);');
        const cancel = dash.slice(dash.indexOf('const cancelCallJoin = useCallback'), dash.indexOf('const toggleJoinMute'));
        expect(cancel).toContain('setJoinView(null);');
    });
    it('Leave on the card of a call still joining cancels the join', () => {
        const leave = dash.slice(dash.indexOf('const handleLeaveHuddleCall = useCallback'), dash.indexOf('const callId = activeHuddleCallId;'));
        expect(leave).toContain('if (!activeCall && joinTracker.pending()) {');
        expect(leave).toContain('cancelCallJoin();');
    });
});

describe('hand-over does not re-animate', () => {
    it('SidebarConference skips its entrance animations on the hand-over mount', () => {
        expect(conf).toContain('initialMuted, initialDeafened, instantEnter,');
        expect(conf.match(/initial=\{instantEnter \? false : \{ opacity: 0 \}\}/g)?.length).toBe(2);
        expect(conf).toContain('<AnimatePresence mode="popLayout" initial={!instantEnter}>');
        expect(pane).toContain('instantEnter={!!sidebarSeed}');
    });
});

describe('ringback waits for the connected call', () => {
    it('CallAudioEffects rings only via ringbackWanted, with the room-connected flag', () => {
        expect(pane).toContain('<CallAudioEffects isInitiator={isCallInitiator} noRinging={noRinging} roomConnected={rtcConnected} />');
        expect(pane).toMatch(/const ringWanted = ringbackWanted\(\{[\s\S]*?roomConnected,/);
        expect(pane).toContain("ringback.update(ringWanted, () => playLoopingSound('ringing', soundsPrefs()));");
        expect(pane.match(/playLoopingSound\('ringing'/g)?.length).toBe(1);
        expect(pane).toContain('useEffect(() => () => ringback.dispose(), [ringback]);');
    });
    it('rtcConnected is set from the room\'s Connected event only', () => {
        expect(pane.match(/setRtcConnected\(true\)/g)?.length).toBe(1);
        const onConnected = pane.slice(pane.indexOf('onConnected={() => {'), pane.indexOf('onDisconnected='));
        expect(onConnected).toContain('setRtcConnected(true);');
    });
});
