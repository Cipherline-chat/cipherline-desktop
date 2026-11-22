import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

/**
 * A phone's share-audio helper connection must never be a person in the call UI.
 * These pin that every roster/count/sound consumer reads through the helper-aware
 * path, so a new direct `useParticipants` / `remoteParticipants.size` does not
 * quietly bring the ghost back.
 */
describe('share-audio helper is filtered at every call-UI consumer', () => {
    it.each([
        'components/SidebarConference.tsx',
        'components/CallPane.tsx',
        'components/call/FocusedStreamBanner.tsx',
        'components/call/FullscreenOverlay.tsx',
    ])('%s reads rosters through useCallParticipants (not raw useParticipants)', (f) => {
        const s = src(f);
        expect(s).toContain('useCallParticipants(');
        expect(s).not.toMatch(/=\s*useParticipants\(/);
    });
    it.each([
        'components/SidebarConference.tsx',
        'components/call/CallEventMonitor.tsx',
        'components/call/BetaCallMonitor.tsx',
    ])('%s counts remotes without helpers', (f) => {
        const s = src(f);
        expect(s).toContain('realRemoteCount(');
        expect(s).not.toMatch(/remoteParticipants\.size/);
    });
    it('ring capability, HEVC capability and entrance sounds skip helpers', () => {
        expect(src('components/E2EEActivator.tsx')).toContain('isShareAudioHelperIdentity');
        expect(src('components/call/EntranceSoundTransport.tsx')).toContain('isShareAudioHelperIdentity');
        expect(src('components/SidebarConference.tsx')).toContain('.filter(p => !isShareAudioHelperIdentity(p.identity))');
    });
    it('playback takes the share audio from the helper connection when there is one', () => {
        const s = src('hooks/useParticipantAudio.ts');
        expect(s).toContain('useShareAudioHelper(p.identity)');
        expect(s).toContain('acquireSSAudioChain(remote, ssSource)');
    });
});
