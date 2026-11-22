import { describe, it, expect, vi } from 'vitest';
import {
    ServerMuteGate,
    serverMuteGateFor,
    metadataServerMuted,
    serverMutedMicView,
    type ServerMuteContext,
} from './serverMuteGate';

/**
 * A fake local participant shaped like what the SFU does to us (measured on
 * LiveKit 1.9.12 + livekit-client 2.18.8): a server mute arrives as metadata,
 * then a grant without MICROPHONE, then the SFU UNPUBLISHES our mic. A lift
 * restores the grant and nothing else.
 */
function fakeMic(initialOn: boolean) {
    const s = { on: initialOn, grant: true, serverFlag: false };
    const setEnabled = vi.fn((on: boolean) => {
        if (on && !s.grant) return Promise.reject(new Error('insufficient permissions'));
        s.on = on;
        return Promise.resolve();
    });
    return {
        s,
        mic: { isEnabled: () => s.on, canPublish: () => s.grant, setEnabled },
        setEnabled,
        restricted: () => s.serverFlag || !s.grant,
    };
}

const CTX: ServerMuteContext = { selfDeafened: false, pushToTalk: false, canSpeak: true };
const note = (g: ServerMuteGate, f: ReturnType<typeof fakeMic>, extra: Partial<{ selfDeafened: boolean; pushToTalk: boolean }> = {}) =>
    g.noteMicState(f.s.on, { restricted: f.restricted(), selfDeafened: false, pushToTalk: false, ...extra });

/** The SFU side of a server mute, in the order the client observes it. The
 *  React effect (setServerMuted) runs AFTER the teardown - the race the old
 *  snapshot lost. */
function serverMute(g: ServerMuteGate, f: ReturnType<typeof fakeMic>) {
    f.s.serverFlag = true;            // ParticipantMetadataChanged
    f.s.grant = false;                // ParticipantPermissionsChanged
    f.s.on = false;                   // LocalTrackUnpublished (SFU teardown): the gate does not listen to it
    return g.setServerMuted(true, f.mic, CTX);
}
function serverLift(g: ServerMuteGate, f: ReturnType<typeof fakeMic>, ctx: ServerMuteContext = CTX, opts: { grantFirst?: boolean } = { grantFirst: true }) {
    f.s.serverFlag = false;
    if (opts.grantFirst) f.s.grant = true;
    return g.setServerMuted(false, f.mic, ctx);
}

describe('server mute x self mute - the four combinations', () => {
    it('live -> server mute -> lift: live again, with no click (the owner bug)', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        expect(serverMute(g, f)).toBe('applied');
        expect(f.s.on).toBe(false);
        expect(serverLift(g, f)).toBe('restored');
        expect(f.setEnabled).toHaveBeenCalledWith(true);
        expect(f.s.on).toBe(true);
    });

    it('self-muted before -> server mute -> lift: stays self-muted', () => {
        const f = fakeMic(false); const g = new ServerMuteGate(false); note(g, f);
        expect(g.isSelfMuted()).toBe(true);
        serverMute(g, f);
        expect(serverLift(g, f)).toBe('kept-muted');
        expect(f.setEnabled).not.toHaveBeenCalled();
        expect(f.s.on).toBe(false);
    });

    it('live -> server mute -> user presses Mute during it -> lift: stays muted', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        expect(g.userToggled()).toBe(true);
        expect(f.setEnabled).not.toHaveBeenCalled(); // the track is not touched while server-muted
        expect(serverLift(g, f)).toBe('kept-muted');
        expect(f.s.on).toBe(false);
    });

    it('self-muted -> server mute -> user unmutes during it -> lift: live', () => {
        const f = fakeMic(false); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        expect(g.userToggled()).toBe(false);
        expect(f.setEnabled).not.toHaveBeenCalled(); // no early publish: the SFU holds it
        expect(serverLift(g, f)).toBe('restored');
        expect(f.s.on).toBe(true);
    });
});

describe('the root cause: the SFU teardown is never read as a self-mute', () => {
    it('a mute/unpublish event observed while restricted does not change the choice', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        f.s.grant = false; f.s.on = false; // grant gone + track down, flag not seen yet
        note(g, f);
        expect(g.isSelfMuted()).toBe(false);
        f.s.serverFlag = true; note(g, f);
        expect(g.isSelfMuted()).toBe(false);
    });

    it('POSITIVE CONTROL: the old "snapshot isMicrophoneEnabled when the flag lands" rule loses this race', () => {
        // What SidebarConference used to do, verbatim in spirit:
        //   on flag true:  wasMuted = !isMicrophoneEnabled
        //   on flag false: if (!wasMuted) setMicrophoneEnabled(true)
        const f = fakeMic(true);
        f.s.serverFlag = true; f.s.grant = false; f.s.on = false; // teardown landed before the effect ran
        const wasMutedBeforeServerMute = !f.mic.isEnabled();
        f.s.serverFlag = false; f.s.grant = true;
        const oldWouldRestore = !wasMutedBeforeServerMute;
        expect(oldWouldRestore).toBe(false); // -> "they have to manually unmute themselves"
        // ...and the gate, fed the same sequence, restores.
        const f2 = fakeMic(true); const g = new ServerMuteGate(false); note(g, f2);
        serverMute(g, f2);
        expect(serverLift(g, f2)).toBe('restored');
    });

    it('mute/unmute events are learned only while nothing else holds the mic', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false);
        f.s.on = false;
        note(g, f, { selfDeafened: true });
        expect(g.isSelfMuted()).toBe(false); // a deafen's forced mute is not a choice
        note(g, f, { pushToTalk: true });
        expect(g.isSelfMuted()).toBe(false); // nor push-to-talk's closed mic
        note(g, f);
        expect(g.isSelfMuted()).toBe(true);  // a plain mute is
        f.s.on = true; note(g, f);
        expect(g.isSelfMuted()).toBe(false);
    });

    it('a mic event while the gate itself is server-muted is ignored even if the caller says unrestricted', () => {
        const g = new ServerMuteGate(false);
        const f = fakeMic(true); note(g, f);
        serverMute(g, f);
        g.noteMicState(false, { restricted: false, selfDeafened: false, pushToTalk: false });
        expect(g.isSelfMuted()).toBe(false);
    });
});

describe('the lift', () => {
    it('waits for the restored grant when the flag arrives first, then restores', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        expect(serverLift(g, f, CTX, { grantFirst: false })).toBe('pending');
        expect(f.setEnabled).not.toHaveBeenCalled();
        expect(g.isRestorePending()).toBe(true);
        f.s.grant = true;
        expect(g.permissionsChanged(f.mic, CTX)).toBe('restored');
        expect(f.s.on).toBe(true);
        expect(g.permissionsChanged(f.mic, CTX)).toBe('none'); // once
    });

    it('a re-mute while the restore is pending cancels it', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        serverLift(g, f, CTX, { grantFirst: false });
        serverMute(g, f);
        f.s.grant = true;
        expect(g.permissionsChanged(f.mic, CTX)).toBe('none');
        expect(f.setEnabled).not.toHaveBeenCalled();
    });

    it('pressing Mute while the restore is pending cancels it', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        serverLift(g, f, CTX, { grantFirst: false });
        g.userChose(true);
        f.s.grant = true;
        expect(g.permissionsChanged(f.mic, CTX)).toBe('none');
    });

    it.each([
        ['self-deafened', { ...CTX, selfDeafened: true }],
        ['push-to-talk', { ...CTX, pushToTalk: true }],
        ['no SPEAK', { ...CTX, canSpeak: false }],
    ])('never opens the mic when %s', (_n, ctx) => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        expect(serverLift(g, f, ctx)).toBe('kept-muted');
        expect(f.setEnabled).not.toHaveBeenCalled();
    });

    it('a lift with no server mute before it is not a transition (mount, normal call)', () => {
        const f = fakeMic(false); const g = new ServerMuteGate(false);
        expect(g.setServerMuted(false, f.mic, CTX)).toBe('none');
        expect(f.setEnabled).not.toHaveBeenCalled();
    });

    it('a repeated mute flag is applied once', () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false);
        expect(serverMute(g, f)).toBe('applied');
        expect(g.setServerMuted(true, f.mic, CTX)).toBe('none');
    });

    it('a failed re-publish (device busy) does not throw', async () => {
        const f = fakeMic(true); const g = new ServerMuteGate(false); note(g, f);
        serverMute(g, f);
        f.s.serverFlag = false; f.s.grant = true;
        f.setEnabled.mockImplementationOnce(() => Promise.reject(new Error('NotReadableError')));
        expect(g.setServerMuted(false, f.mic, CTX)).toBe('restored');
        await Promise.resolve();
    });
});

describe('remount, reconnect, rejoin', () => {
    it('the same Room keeps one gate: a call UI remount mid-mute does not lose the choice, and a lift seen after it restores', () => {
        const room = {};
        const f = fakeMic(true);
        const g1 = serverMuteGateFor(room, false); note(g1, f);
        serverMute(g1, f);
        // UI unmounts; it remounts with a different initialMuted (ignored for an existing Room)
        const g2 = serverMuteGateFor(room, true);
        expect(g2).toBe(g1);
        note(g2, f); // mount-time sync while restricted: ignored
        expect(g2.isSelfMuted()).toBe(false);
        expect(serverLift(g2, f)).toBe('restored');
    });

    it('the lift happened while the UI was unmounted: the remount sees flag=false and restores', () => {
        const room = {};
        const f = fakeMic(true);
        const g = serverMuteGateFor(room, false); note(g, f);
        serverMute(g, f);
        f.s.serverFlag = false; f.s.grant = true; // lift lands with no UI mounted
        const again = serverMuteGateFor(room, false);
        expect(again.setServerMuted(false, f.mic, CTX)).toBe('restored');
    });

    it('a rejoin is a new Room: seeded from the joining controls, then a lift honours that', () => {
        const live = serverMuteGateFor({}, false);
        const f = fakeMic(false); f.s.grant = false; f.s.serverFlag = true; // joined while server-muted: no mic published
        note(live, f);
        expect(live.setServerMuted(true, f.mic, CTX)).toBe('applied');
        expect(serverLift(live, f)).toBe('restored');

        const muted = serverMuteGateFor({}, true);
        const f2 = fakeMic(false); f2.s.grant = false; f2.s.serverFlag = true;
        note(muted, f2);
        muted.setServerMuted(true, f2.mic, CTX);
        expect(serverLift(muted, f2)).toBe('kept-muted');
    });

    it('subscribers hear choice changes (the Mute button re-renders) and only real changes', () => {
        const g = new ServerMuteGate(false);
        const fn = vi.fn();
        const off = g.subscribe(fn);
        g.userToggled();
        g.userChose(true);  // no change
        g.userToggled();
        expect(fn).toHaveBeenCalledTimes(2);
        off();
        g.userToggled();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('metadataServerMuted', () => {
    it.each([
        ['{"server_muted_audio":true}', true],
        ['{"server_muted_audio":false}', false],
        ['{"server_muted_audio":"true"}', false],
        ['{"server_deafened":true}', false],
        ['null', false],
        ['not json', false],
        ['', false],
        [undefined, false],
    ])('%s -> %s', (m, want) => {
        expect(metadataServerMuted(m)).toBe(want);
    });
});

describe('serverMutedMicView', () => {
    it('says server-muted either way and tells the user what the lift will do', () => {
        const live = serverMutedMicView(false);
        const self = serverMutedMicView(true);
        expect(live.notice).toBe('Server muted by a moderator');
        expect(self.notice).toBe('Server muted by a moderator');
        expect(live.iconOff).toBe(false);
        expect(self.iconOff).toBe(true);
        expect(live.noticeDetail).toMatch(/live again/);
        expect(self.noticeDetail).toMatch(/stay muted/);
        expect(live.title).toMatch(/moderator/);
        expect(self.title).toMatch(/unmute/);
    });
});
