import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server mute / server deafen - source-level wiring pins. SidebarConference,
 * ControlBar and useParticipantAudio have no render harness (they need a live
 * LiveKit room); the owner-visible behaviour lives in how they are wired:
 *
 *   1. deafen does NOT touch the mic: not the mic effect, not the mic button,
 *      not push-to-talk, not the carried "my mute" intent;
 *   2. deafen blocks other participants' MICROPHONE audio only - the
 *      screen-share audio chain never reads it;
 *   3. no notice of any kind for a server mute / unmute / deafen / undeafen;
 *   4. the red state icons stay (rows and tiles).
 *
 * The decisions themselves are unit-tested (utils/localServerDeafen.test.ts,
 * utils/callMediaPresence.test.ts); these pin that the app actually uses them.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const conf = read('SidebarConference.tsx');
const controlBar = read('call', 'ControlBar.tsx');
const audio = read('..', 'hooks', 'useParticipantAudio.ts');
const card = read('call', 'ParticipantCard.tsx');
const icons = read('server', 'ParticipantStatusIcons.tsx');
const panel = read('server', 'ServerContextPanel.tsx');

/** Source between `start` and the next `end` after it (throws if absent). */
function between(src: string, start: string, end: string): string {
    const a = src.indexOf(start);
    expect(a, `"${start}" present`).toBeGreaterThan(-1);
    const b = src.indexOf(end, a + start.length);
    expect(b, `"${end}" after "${start}"`).toBeGreaterThan(a);
    return src.slice(a, b);
}

describe('deafen is independent of the microphone', () => {
    it('isLocalDeafened (what the mic effect, push-to-talk and the toggle use) is SELF deafen only', () => {
        expect(conf).toMatch(/const isLocalDeafened = localDeafened \|\| baseLocalDeafened;/);
        expect(conf).not.toMatch(/const isLocalDeafened = [^;]*baseServerDeafened/);
        // The union exists only for the deafen icon and the tray.
        expect(conf).toMatch(/const isDeafenedForUi = isLocalDeafened \|\| baseServerDeafened;/);
    });

    it('the "deafened -> mic off / undeafened -> restore mic" effect keys on self deafen, never the server flag', () => {
        const effect = between(conf, 'if (isLocalDeafened) {\n            if (localParticipant.isMicrophoneEnabled)', '[isLocalDeafened, localParticipant]');
        expect(effect).not.toContain('baseServerDeafened');
    });

    it('the carried "my mute" intent no longer treats a server deafen as a forced mute (only a server MUTE is)', () => {
        expect(conf).toMatch(/serverForcedMute: localServerMutedAudio,/);
        expect(conf).not.toMatch(/serverForcedMute: [^,]*baseServerDeafened/);
    });

    it('the mic button is disabled by a server MUTE only, not by a server deafen', () => {
        const line = between(controlBar, 'const micDisabled', ';\n');
        expect(line).toContain('serverMutedAudio');
        expect(line).not.toContain('isServerDeafened');
        // ...and its tooltip no longer claims "unmute is blocked" for a deafen.
        expect(controlBar).not.toContain("You've been server deafened — unmute is blocked");
    });

    it('the deafen button is still locked while a server deafen holds (a self-deafen cannot override it)', () => {
        expect(controlBar).toMatch(/const deafenDisabled = isServerDeafened;/);
    });
});

describe('deafen blocks other participants\' MICROPHONES, not screen-share audio', () => {
    it('SidebarConference publishes the server-deafen flag for the audio chains and clears it on teardown', () => {
        expect(conf).toContain('setLocalServerDeafened(baseServerDeafened)');
        expect(conf).toMatch(/useEffect\(\(\) => \(\) => setLocalServerDeafened\(false\), \[\]\)/);
    });

    it('the MIC chain is silenced through shouldSilenceMicAudio with the server-deafen flag (every write site)', () => {
        expect(audio).toContain('const serverDeafened = useLocalServerDeafened();');
        const uses = audio.match(/shouldSilenceMicAudio\(/g) ?? [];
        expect(uses.length).toBe(2); // the post-acquire write and the volume effect
        expect(audio).toContain('serverDeafened: serverDeafenedRef.current');
        expect(audio).toMatch(/shouldSilenceMicAudio\(\{ isLocalMuted, isLocalDeafened, serverDeafened \}\)/);
    });

    it('the SHARE-audio chain is silenced through shouldSilenceShareAudio and never reads the server-deafen flag', () => {
        const effect = between(audio, 'const chain = ssAudioChains.get(p.identity);\n        if (!chain) return;\n        chain.perUserGain', '[isLocal, isScreenShare, p.identity, screenShareVolume');
        expect(effect).toContain('shouldSilenceShareAudio(');
        expect(effect).not.toMatch(/serverDeafened/);
    });

    it('server deafen does not unsubscribe anything: no setSubscribed / canSubscribe change is tied to it', () => {
        expect(conf).not.toMatch(/baseServerDeafened[^\n]*setSubscribed/);
        expect(audio).not.toMatch(/serverDeafened[^\n]*setSubscribed/);
    });
});

describe('no notices for server mute / unmute / deafen / undeafen', () => {
    it('the "Server mute removed" toast is gone from the client entirely', () => {
        expect(conf).not.toContain('Server mute removed');
        expect(conf).not.toContain('A moderator removed your server mute');
    });

    it('the server-mute effect still restores the mic silently, with no toast between its transition and its end', () => {
        const effect = between(conf, 'const prevServerMutedAudioRef = React.useRef(false);', '[localServerMutedAudio]');
        expect(effect).not.toContain('toast.push');
        expect(effect).not.toContain('playSound');
        expect(effect).toContain('setMicrophoneEnabled(true)');
    });

    it('none of the moderation actions in the panel toast on success', () => {
        const call = between(panel, 'const serverMuteCallParticipant = React.useCallback(', 'const removeVoiceModeration');
        expect(call).not.toContain('toast.push');
        const remove = between(panel, 'const removeVoiceModeration = React.useCallback(', 'const buildVoiceModerationItems');
        expect(remove).not.toContain('toast.push');
    });
});

describe('state icons stay on rows and tiles', () => {
    it('the participant card row draws the red server-mute and server-deafen badges, with a time-left tooltip', () => {
        expect(card).toContain('modMeta.serverMutedAudio');
        expect(card).toContain('modMeta.serverDeafened');
        expect(card).toContain('title={modTitles.muted}');
        expect(card).toContain('title={modTitles.deafened}');
    });

    it('a server-deafened participant is not drawn as silenced / non-speaking (they can still talk)', () => {
        expect(card).toMatch(/const isDeafened = meta\?\.deafened === true;/);
    });

    it('the server sidebar rows resolve the badges from LiveKit in a call and from presence outside one', () => {
        expect(icons).toContain('resolveServerModeration(inThisCall, pmeta, presence)');
        // a server deafen no longer hides the person's own mute icon
        expect(icons).not.toMatch(/selfMuted && [^\n]*serverDeafened/);
    });
});

describe('a moderator can remove a mute / deafen from a member who is not in voice', () => {
    it('the member menu offers removal (no room named) and the panel keeps the expiry list loaded', () => {
        expect(panel).toContain('removeServerVoiceModeration(axios, API_BASE, token, server.server_id, targetUserId, bit)');
        expect(panel).toContain('items.push(...buildVoiceModerationItems(m.user_id));');
        expect(panel).toContain('useServerVoiceModerationFeed({');
        expect(panel).toContain('removeVoiceModerationLabel(');
    });
});
