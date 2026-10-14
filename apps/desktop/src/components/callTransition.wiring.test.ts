import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Call-moderation overhaul — source-level wiring pins. Dashboard / CallPane /
 * useRealtime have no render harness, and the bug these guard against was
 * exactly a wiring bug: every piece (the move handler, the disconnect reasons,
 * the marker) worked in isolation, and the failure lived in how they raced.
 * The decisions are unit-tested in utils/callTransition.test.ts; these pin that
 * the app actually calls them, in the places the fix depends on.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const dash = read('Dashboard.tsx');
const pane = read('CallPane.tsx');
const realtime = read('..', 'hooks', 'useRealtime.ts');
const ctxPanel = read('server', 'ServerContextPanel.tsx');
const popover = read('call', 'PopoverMenu.tsx');
const conf = read('SidebarConference.tsx');

describe('the move marker is armed BEFORE React state (so the removal cannot win the race)', () => {
    it('useRealtime arms the transition marker, then sets the move event', () => {
        const a = realtime.indexOf("if (msg.event === 'huddle:force_move') {");
        const arm = realtime.indexOf("callTransitions.begin({ kind: 'move'", a);
        const set = realtime.indexOf('setHuddleForceMoveEvent({', a);
        expect(a).toBeGreaterThan(-1);
        expect(arm, 'marker armed').toBeGreaterThan(a);
        expect(set, 'state set').toBeGreaterThan(arm);
    });

    it('force_disconnect arms a disconnect marker the same way, from a parsed payload', () => {
        const a = realtime.indexOf("if (msg.event === 'huddle:force_disconnect') {");
        expect(a).toBeGreaterThan(-1);
        const body = realtime.slice(a, a + 600);
        expect(body).toContain('parseForceDisconnect(msg.data)');
        expect(body.indexOf("callTransitions.begin({ kind: 'disconnect'")).toBeGreaterThan(-1);
        expect(body.indexOf("callTransitions.begin({ kind: 'disconnect'")).toBeLessThan(body.indexOf('setHuddleForceDisconnectEvent('));
    });
});

describe('CallPane: a disconnect of a room being left is part of the transition', () => {
    it('routes every LiveKit disconnect through decideDisconnectHandling and honours teardown:false', () => {
        const i = pane.indexOf('onDisconnected={(reason) => {');
        expect(i).toBeGreaterThan(-1);
        const body = pane.slice(i, i + 3200);
        expect(body).toContain('decideDisconnectHandling(reason, sessionId)');
        expect(body).toContain('if (handling.teardown) onDisconnect();');
        // The old unconditional path is gone: no direct mapping + teardown that ignores a move.
        expect(body).not.toContain('mapDisconnectReasonToUserMessage(');
    });

    it('connection / encryption failures call the LATEST leave handler, not a mount-time closure', () => {
        const fc = pane.slice(pane.indexOf('const failConnection'), pane.indexOf('const failEncryption'));
        expect(fc).toContain('stableOnLeave()');
        expect(fc).toContain('failureTitleRef.current ??');
    });
});

describe('Dashboard: the move goes through the normal join path', () => {
    const effect = dash.slice(dash.indexOf('const moveHandledNonceRef'), dash.indexOf('// Auto-load active calls for any Huddle channel'));

    it('begins the join exactly as a user-initiated switch does, settles it, then commits via the shared selection', () => {
        const b = effect.indexOf("beginCallJoin('huddle-join'");
        const s = effect.indexOf('settleCallJoin(attempt)');
        const e = effect.indexOf('applyHuddleSelection(sel)');
        const an = effect.indexOf('announceForceMove(e, {');
        expect(b).toBeGreaterThan(-1);
        expect(s).toBeGreaterThan(-1);
        expect(e).toBeGreaterThan(-1);
        expect(an).toBeGreaterThan(-1);
        expect(effect).toContain('runForceMove(ev, {');
    });

    it('does not POST a leave or raise the switch-calls prompt from the move', () => {
        expect(effect).not.toContain('leaveHuddleCall(');
        expect(effect).not.toContain('handleLeaveHuddleCall');
        expect(effect).not.toContain('setPendingServerJoin');
        // And it no longer assembles activeCall by hand.
        expect(effect).not.toContain('setActiveCall({');
    });

    it('only the device that is IN the source call acts (an idle second device would kick it with DUPLICATE_IDENTITY)', () => {
        expect(effect).toContain('isInSourceCall: e => {');
        expect(effect).toContain('cur === e.from_call_id');
    });

    it('the move is de-duplicated per event (StrictMode / dependency churn)', () => {
        expect(effect).toContain('if (moveHandledNonceRef.current === ev.nonce) return;');
    });

    it('force_disconnect leaves via the ordinary handler and uses the neutral leave cue', () => {
        const d = dash.slice(dash.indexOf('const ev = huddleForceDisconnectEvent;'), dash.indexOf('const ev = huddleForceDisconnectEvent;') + 1100);
        expect(d).toContain('handleDisconnectCallRef.current?.(false)');
        expect(d).toContain("playSound('leave'");
        expect(d).not.toContain("playSound('error'");
    });
});

describe('Dashboard: a replaced CallPane cannot end the call that replaced it', () => {
    it('the pane\'s onDisconnect is guarded by the pane\'s own call id', () => {
        expect(dash).toContain('if (!shouldActOnPaneDisconnect(call.id, activeCallRef.current?.id)) return;');
        expect(dash).not.toContain('onDisconnect={handleDisconnectCall}');
    });

    it('a failed move is titled for the move, and the room connecting completes it', () => {
        expect(dash).toContain('failureTitle={failureTitleFor(call.id, call.voiceChannelName)}');
        expect(dash).toContain('callTransitions.markConnected(call.id)');
    });

    it('a user leave ends a pending move (so a later failure is not mislabelled)', () => {
        const i = dash.indexOf('const handleDisconnectCall = async');
        expect(dash.slice(i, i + 1200)).toContain('callTransitions.clearMove();');
    });
});

describe('Disconnect is in the participant menus and asks first', () => {
    it('ServerContextPanel offers it next to "Move to" in both participant menus', () => {
        expect(ctxPanel).toContain('items.push(...buildMoveToSubmenu(uid));\n            items.push(...buildDisconnectItems(uid, displayName));');
        expect(ctxPanel).toContain('items.push(...buildMoveToSubmenu(m.user_id));\n        items.push(...buildDisconnectItems(m.user_id, displayName));');
    });

    it('the menu item is gated by canOfferDisconnect (permission, not self, in a call) and confirms before sending', () => {
        const i = ctxPanel.indexOf('const buildDisconnectItems');
        const body = ctxPanel.slice(i, i + 1800);
        expect(body).toContain('canOfferDisconnect({');
        expect(body).toContain('disconnectConfirmCopy(displayName)');
        // The request is only fired from the confirm dialog's onConfirm.
        expect(body).toMatch(/onSelect: \(\) => setPendingConfirm\(\{[\s\S]*?onConfirm: \(\) => \{ void commitDisconnect\(target, uid\); \}/);
    });

    it('the in-call popover offers it only through the permission-carrying context, with an inline confirm', () => {
        expect(popover).toContain('const canDisconnect = !!userId && !!callServerCtx?.canManageCallMembers && !!callServerCtx.disconnectMember;');
        expect(popover).toContain('{canDisconnect && (');
        // Two-step: the first click only asks.
        expect(popover).toContain('onClick={() => setAsking(true)}');
        expect(popover).toContain('disconnectConfirmCopy(displayName)');
    });
});

describe('self-mute / self-deafen persist across a switch or a move (no hot mic)', () => {
    const begin = dash.slice(dash.indexOf('const beginCallJoin = useCallback'), dash.indexOf('const settleCallJoin = useCallback'));

    it('beginCallJoin - the start of EVERY join path, a moderator move included - carries the intent instead of resetting it', () => {
        expect(begin).toContain('resolveCarriedIntent(');
        expect(begin).toContain('setJoinIntent(carried);');
        // The old unconditional reset is gone.
        expect(begin).not.toContain('setJoinIntent({ muted: false, deafened: false })');
    });

    it('the mic device is only warmed for a join that will use it', () => {
        expect(begin).toContain('if (shouldWarmMic(carried)) prewarmMic(');
        expect(begin).not.toMatch(/^\s*prewarmMic\(/m);
    });

    it('CallPane decides whether the room asks for the mic from the same intent (audio is never requested when muted/deafened)', () => {
        expect(pane).toContain('const joinWithMic = shouldPublishMicAtConnect(joinIntent, grants.microphone);');
        expect(pane).toContain('audio={joinWithMic}');
    });

    it('SidebarConference publishes the user\'s own intent while in a call', () => {
        expect(conf).toContain('selfCallIntent.set(deriveSelfIntent({');
        // Moderator-applied state is passed as "forced", never as the user's choice.
        expect(conf).toContain('serverForcedMute: localServerMutedAudio || baseServerDeafened');
    });

    it('a real leave clears it, so a join from nothing starts clean', () => {
        const i = dash.indexOf('const handleDisconnectCall = async');
        expect(dash.slice(i, i + 1600)).toContain('selfCallIntent.clear();');
    });
});
