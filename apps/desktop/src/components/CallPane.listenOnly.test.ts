import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Join-to-listen: a member who may CONNECT but not SPEAK has a token with no
 * microphone grant. <LiveKitRoom audio={true}> would publish the mic on connect,
 * LiveKit rejects it, onError fails the call, and the member cannot join at all.
 * CallPane has no render harness, so the wiring is pinned at the source level.
 */
const src = readFileSync(join(__dirname, 'CallPane.tsx'), 'utf8');
const sidebar = readFileSync(join(__dirname, 'SidebarConference.tsx'), 'utf8');

describe('listen-only join', () => {
    it('the room only auto-starts what the token lets it publish', () => {
        // The token grant still gates the mic; instant join only adds "and the
        // user didn't mute/deafen while joining" (see instantCallJoin.wiring.test.ts).
        expect(src).toContain('const joinWithMic = grants.microphone && !joinIntent.muted && !joinIntent.deafened;');
        expect(src).toContain('audio={joinWithMic}');
        expect(src).toContain('video={videoByDefault && grants.camera}');
        expect(src).not.toMatch(/\baudio=\{true\}/);
    });

    it('the mic-restoring effects ask the live permissions first, and swallow a rejection', () => {
        // undeafen, push-to-talk off, push-to-talk key down, server-mute lifted
        const restoring = sidebar.match(/canPublishMicrophone\(localParticipant\)/g) ?? [];
        expect(restoring.length).toBeGreaterThanOrEqual(5);
        expect(sidebar).not.toMatch(/localParticipant\.setMicrophoneEnabled\(true\);/);
    });
});
