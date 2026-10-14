import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "End call when the starter leaves" - source-level wiring pins. It is a CALL
 * CHANNEL setting (Calls channel settings -> Call behavior); there is no per-call
 * switch and NO "are you sure" prompt: with the setting on, the starter leaving on
 * purpose simply ends the call. Dashboard,
 * SidebarConference and CallPane have no render harness, and the thing that
 * matters here is exactly a wiring property: ONLY the user's own deliberate Leave
 * reaches the server as `deliberate: true`. A dropped connection, a failed
 * connect, an undone join and an inactivity timeout all share the same
 * disconnect plumbing and must never carry it, or flaky Wi-Fi would end a call
 * for everyone. The rules themselves are unit-tested in utils/endCallOnLeave.test.ts.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const dash = read('Dashboard.tsx');
const pane = read('CallPane.tsx');
const conf = read('SidebarConference.tsx');
const servers = read('..', 'hooks', 'useServers.ts');
const realtime = read('..', 'hooks', 'useRealtime.ts');
const gatewayEvents = read('..', 'utils', 'callTransition.ts');
const panel = read('server', 'ServerContextPanel.tsx');
const card = read('server', 'HuddleCallCard.tsx');
const floating = read('call', 'FloatingHuddleCard.tsx');
const voiceSettings = read('..', 'hooks', 'useVoiceSettings.ts');
const voiceUi = read('VoiceVideoSettings.tsx');
const ctx = read('..', 'contexts', 'CallServerCtx.ts');
const dialog = read('server', 'ChannelSettingsDialog.tsx');
const behavior = read('server', 'CallBehaviorSection.tsx');
const naming = read('server', 'CallNamingSection.tsx');

const between = (src: string, from: string, to: string): string => {
    const a = src.indexOf(from);
    expect(a, `"${from}" not found`).toBeGreaterThan(-1);
    const b = src.indexOf(to, a + from.length);
    expect(b, `"${to}" not found after "${from}"`).toBeGreaterThan(a);
    return src.slice(a, b);
};

describe('only the user\'s own Leave is deliberate', () => {
    it('SidebarConference: the Leave button and the leave hotkey go through handleUserLeave', () => {
        expect(conf).toContain("'keybind:leave-call':         handleUserLeave,");
        expect(conf).toContain('onLeave={handleUserLeave}');
        // ...and nothing else uses the raw handler with deliberate=true.
        const uses = [...conf.matchAll(/handleLeave\(([^)]*)\)/g)].map(m => m[1]);
        // '' = the inactivity timer's bare handleLeave() (deliberate defaults to false).
        expect(uses.sort()).toEqual(['', 'false', 'true']);
    });

    it('handleUserLeave is a plain deliberate leave: no guard, no dialog, nothing to wait for', () => {
        const body = between(conf, 'const handleUserLeave = () => {', '};').replace(/\s+/g, ' ').trim();
        expect(body).toBe('const handleUserLeave = () => { handleLeave(true);');
        expect(conf).not.toContain('confirmLeave');
        expect(conf).not.toContain('endOnLeave');
    });

    it('the inactivity auto-leave is NOT deliberate', () => {
        expect(conf).toContain('const handleLeave = (deliberate: boolean = false) => {');
        expect(conf).toContain('if (inactivityCountdown <= 0) { handleLeave(); return; }');
        expect(conf).toContain('setInactivityCountdown(null); handleLeave(false);');
    });

    it('SidebarConference passes `deliberate` up as the second argument', () => {
        expect(conf).toContain('onLeave(wasLastPerson, deliberate === true);');
    });

    it('CallPane: its own LiveKit-disconnect and failure paths call onDisconnect() with NO arguments', () => {
        const disc = between(pane, 'onDisconnected={(reason) => {', 'onError={(err) => {');
        expect(disc).toContain('if (handling.teardown) onDisconnect();');
        expect(disc).not.toMatch(/onDisconnect\([^)]/);
        // Connection / encryption failures route through stableOnLeave() with no args too.
        const fc = pane.slice(pane.indexOf('const failConnection'), pane.indexOf('const failEncryption'));
        expect(fc).toContain('stableOnLeave()');
    });

    it('CallPane forwards `deliberate` untouched from the Leave button', () => {
        expect(pane).toContain('latestCallbacksRef.current.onDisconnect(wasLastPerson, deliberate);');
    });

    it('Dashboard: only a strict `deliberate === true` from the pane reaches handleDisconnectCall as deliberate', () => {
        expect(dash).toContain('void handleDisconnectCall(wasLastPerson, deliberate === true);');
    });

    it('Dashboard: handleDisconnectCall defaults to NOT deliberate, and the huddle branch passes it on', () => {
        expect(dash).toContain('const handleDisconnectCall = async (wasLastPerson: boolean = false, deliberate: boolean = false) => {');
        expect(dash).toContain('handleLeaveHuddleCall({ deliberate });');
    });

    it('Dashboard: every OTHER caller of handleDisconnectCall is non-deliberate', () => {
        // The server-driven / automatic leaves (solo kick, asleep-while-ended,
        // moderator disconnect / creator-ended, key-wait and still-connecting Leave
        // buttons) pass at most wasLastPerson. Pinned as an exact list so a new
        // caller has to be a conscious decision.
        const args = [...dash.matchAll(/handleDisconnectCall(?:Ref\.current\?)?\.?\(([^)]*)\)/g)]
            .map(m => m[1].trim())
            // the declaration's own parameter list is not a call
            .filter(a => !a.startsWith('wasLastPerson: boolean'));
        expect(args.sort()).toEqual([
            'false',                         // solo-kick effect
            'false',                         // creator-ended / moderator disconnect (ref)
            'false',                         // key-wait "Leave" (CallEncryptionIndicator)
            'false',                         // still-connecting "Leave" (JoiningControlBar)
            'true',                          // asleep-while-ended teardown (ref)
            'wasLastPerson, deliberate === true', // CallPane forwarder
        ].sort());
    });

    it('handleLeaveHuddleCall takes an options object, so a stray click event can never read as deliberate', () => {
        expect(dash).toContain('const handleLeaveHuddleCall = useCallback(async (opts?: { deliberate?: boolean }) => {');
        expect(dash).toContain('const deliberate = opts?.deliberate === true;');
        expect(dash).toContain('leaveHuddleCall(callId, { deliberate })');
    });

    it('useServers: the body-less leave stays body-less; only deliberate sends {deliberate:true}', () => {
        const body = between(servers, 'const leaveHuddleCall = useCallback(', 'const { destroyed }');
        expect(body).toContain('const body = leaveRequestBody(opts?.deliberate);');
        expect(body).toContain('body,');
    });

    it('undoing a superseded join never leaves deliberately (it would end the call it just created/joined)', () => {
        const undos = [...dash.matchAll(/leaveHuddleCall\(res\.call_id[^)]*\)/g)].map(m => m[0]);
        expect(undos.length).toBeGreaterThanOrEqual(2);
        for (const u of undos) expect(u).not.toContain('deliberate');
    });
});

describe('switching calls is a deliberate leave (decision: the creator left voluntarily)', () => {
    it('both server-call switch paths and the DM-call switch pass deliberate for the call being left', () => {
        const prev = [...dash.matchAll(/leaveHuddleCall\(prevCall([^)]*)\)/g)].map(m => m[1]);
        expect(prev).toHaveLength(3);
        for (const a of prev) expect(a).toContain('deliberate: true');
    });

    it('the "Leave Current Call?" popup says so when the switch would end the current call for everyone', () => {
        const popup = between(dash, 'const { anchor, channelName, fn } = pendingServerJoin;', 'Leave & Join');
        expect(popup).toContain('leaveEndsCallForOthers(activeHuddleCallInfo, activeHuddleChannel, userId)');
        expect(popup).toContain('end your current call for everyone');
    });

    it('...and that popup stays the ONLY confirm: it gained a line, not a button or a second dialog', () => {
        const popup = between(dash, 'const { anchor, channelName, fn } = pendingServerJoin;', 'Leave & Join');
        expect(popup.match(/<ClButton/g)).toHaveLength(2); // Cancel + Leave & Join, exactly as before
    });
});

describe('there is no leave prompt', () => {
    it('the dialog component, its state and its handlers are gone', () => {
        expect(existsSync(join(__dirname, 'call', 'EndCallConfirm.tsx'))).toBe(false);
        for (const gone of ['EndCallConfirm', 'endCallConfirm', 'EndCallChoice', 'runEndCallChoice', 'endCallGuardRef',
            'handleEndCallChoice', 'shouldConfirmCreatorLeave', 'end-call-confirm']) {
            expect(dash, gone).not.toContain(gone);
        }
        expect(read('..', 'utils', 'endCallOnLeave.ts')).not.toMatch(/runEndCallChoice|shouldConfirmCreatorLeave|EndCallChoice/);
    });

    it('the panel\'s "Leave call" menu item leaves straight away, deliberately', () => {
        expect(dash).toContain('onLeaveHuddleCall={handleLeaveHuddleFromPanel}');
        const fn = between(dash, 'const handleLeaveHuddleFromPanel = useCallback(() => {', '}, [handleLeaveHuddleCall]);');
        expect(fn.replace(/\s+/g, ' ').trim()).toMatch(/\{ void handleLeaveHuddleCall\(\{ deliberate: true \}\);$/);
    });

    it('CallServerCtx no longer carries a leave guard', () => {
        expect(ctx).not.toContain('endOnLeave');
        expect(ctx).not.toContain('confirmLeave');
        expect(dash).not.toContain('endOnLeaveCtx');
    });
});

describe('the switch lives in the Calls channel settings, not on the call', () => {
    it('the channel settings dialog edits it: own state, dirty tracking, create + edit payloads', () => {
        expect(dialog).toContain("import { CallBehaviorSection } from './CallBehaviorSection';");
        expect(dialog).toContain('useState(() => endsWhenStarterLeaves(channel))');
        // Only a CHANGE is sent (an API from before the setting rejects the field); create sends only ON.
        expect(dialog).toContain('endCallWhenStarterLeaves !== endsWhenStarterLeaves(editing)');
        expect(dialog).toContain('if (endCallDirty) body.end_call_when_starter_leaves = true;');
        expect(dialog).toContain('...(endCallDirty ? { end_call_when_starter_leaves: endCallWhenStarterLeaves } : {}),');
        // part of the Save / discard-changes flow like every other field
        expect(between(dialog, 'const overviewDirty = isEdit', 'const permsDirty')).toContain('endCallDirty');
        // ...in its own "Call behavior" card, between Call limits and Call names - NOT under Call names
        const iLimits = dialog.indexOf('>Call limits</div>');
        const iBehavior = dialog.indexOf('>Call behavior</div>');
        const iNames = dialog.indexOf('>Call names</div>');
        expect(iLimits).toBeGreaterThan(-1);
        expect(iBehavior).toBeGreaterThan(iLimits);
        expect(iNames).toBeGreaterThan(iBehavior);
    });

    it('the row is built from the SAME Row as the call-name switches (cannot drift), with a ClToggle', () => {
        expect(naming).toContain('export const Row: React.FC<');
        expect(behavior).toContain("import { Row } from './CallNamingSection';");
        expect(behavior).toContain('<ClToggle checked={value} onChange={onChange}');
        expect(behavior).toContain('END_WHEN_STARTER_LEAVES_LABEL');
    });

    it('the per-call mechanism is gone, everywhere', () => {
        expect(existsSync(join(__dirname, 'call', 'CallSettingsPopover.tsx'))).toBe(false);
        for (const [name, src] of [['Dashboard', dash], ['ServerContextPanel', panel], ['HuddleCallCard', card],
            ['FloatingHuddleCard', floating], ['useServers', servers], ['useRealtime', realtime], ['callTransition', gatewayEvents]] as const) {
            for (const gone of ['CallSettingsPopover', 'CallSettingsButton', 'CallSettingsModel', 'callSettings', 'activeCallSettings',
                'endOnLeaveToggle', 'endOnLeaveMenu', 'setCallEndsOnCreatorLeave', 'SetCallEndsOnCreatorLeave', 'onSetCallEndsOnCreatorLeave',
                'applyHuddleCallSettings', 'huddleCallSettingsEvent', 'huddle:call_settings', 'parseCallSettings', 'end_on_creator_leave',
                'setEndOptionOptimistic', 'withCallEndOption', '/settings`']) {
                expect(src, `${name} still has ${gone}`).not.toContain(gone);
            }
        }
    });

    it('the card\'s right-click menu has no end-call row (Leave call / Join call / Rename / Copy Call ID only)', () => {
        expect(panel).not.toContain('endOnLeaveMenu');
        expect(panel).not.toMatch(/checked: endEntry/);
        expect(panel).not.toContain('End call for everyone when I leave');
    });
});

describe('the card line, the channel setting and the voice default', () => {
    it('the notice reaches the call card, in the server panel and the floating card', () => {
        expect(panel.match(/endsNote=\{endsNote\}/g)).toHaveLength(2);
        expect(card).toContain('data-testid="call-ends-when-note"');
        expect(card).toContain('title={endsNote}');
        expect(floating).toContain('endsNote={endsNote}');
        expect(dash).toContain('endsNote={endsWhenNotice(');
        // Driven by the CHANNEL setting the client already holds - both call sites pass the channel.
        expect(panel).toContain('endsWhenNotice(c, h, userId,');
        expect(between(dash, 'endsNote={endsWhenNotice(', 'token={token}')).toContain('liveHuddleCall, activeHuddleChannel, userId,');
    });

    it('the setting follows the server through the channel list (no per-call state, no extra event)', () => {
        expect(servers).toContain('end_call_when_starter_leaves?: boolean;');
        expect(servers).not.toContain('end_on_creator_leave');
        // channels_changed already refetches the list, which carries the field.
        expect(realtime).toContain("'server:channels_changed'");
        expect(dash).toContain('const activeHuddleChannel = useMemo(');
        expect(dash).toContain('.find(c => c.channel_id === activeHuddleChannelId)');
    });

    it('a call this client starts is recorded as its own from the spawn RESPONSE (not only the WS broadcast)', () => {
        const spawn = between(dash, 'const handleSpawnHuddleCall = useCallback(', 'const handleJoinExistingHuddleCall');
        const apply = spawn.indexOf('applyHuddleSpawn(huddle.channel_id, {');
        expect(apply).toBeGreaterThan(-1);
        expect(spawn).toContain('spawner_user_id: res.spawner_user_id,');
        expect(apply).toBeLessThan(spawn.indexOf('applyHuddleSelection(buildHuddleSelection({'));
    });

    it('the Voice & Video default is gone, and a saved copy of the old key is tolerated and dropped on load', () => {
        expect(voiceUi).not.toContain('Starting calls');
        expect(voiceUi).not.toContain('End call for everyone when I leave');
        expect(voiceUi).not.toContain('setEndCallOnCreatorLeaveDefault');
        expect(voiceSettings).not.toContain('endCallOnCreatorLeaveDefault?:');
        expect(voiceSettings).not.toContain('endCallOnCreatorLeaveDefault: false');
        expect(voiceSettings).not.toContain('setEndCallOnCreatorLeaveDefault');
        expect(voiceSettings).toContain("export const RETIRED_VOICE_SETTING_KEYS = ['endCallOnCreatorLeaveDefault'] as const;");
        expect(voiceSettings).toContain('delete (merged as Record<string, unknown>)[k]');
        // the blob key itself must not change
        expect(voiceSettings).toContain("export const VOICE_SETTINGS_STORAGE_KEY = 'cipherline_voice_settings';");
    });

    it('nothing applies a default after a spawn any more', () => {
        const spawn = between(dash, 'const handleSpawnHuddleCall = useCallback(', 'const handleJoinExistingHuddleCall');
        expect(spawn).not.toContain('endCallOnCreatorLeaveDefault');
        expect(spawn).not.toContain('handleSetCallEndsOnCreatorLeave');
    });
});
