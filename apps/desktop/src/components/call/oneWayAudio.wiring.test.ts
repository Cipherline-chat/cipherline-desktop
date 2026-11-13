import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SidebarConference needs a live room to render, so the one-way-audio wiring is
 * pinned at the source level, in the style of the other call wiring tests. Each
 * of these is a decision the 2026-11-04 investigation rests on.
 */
const conference = readFileSync(join(__dirname, '..', 'SidebarConference.tsx'), 'utf8');
const monitor = readFileSync(join(__dirname, 'BetaCallMonitor.tsx'), 'utf8');
const watchdog = readFileSync(join(__dirname, '..', '..', 'utils', 'audioSilenceWatchdog.ts'), 'utf8');

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const at = (src: string, needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `"${needle}" not found`).toBeGreaterThanOrEqual(0);
    return i;
};

describe('the outbound watchdog is judged by the sender, not by the SFU', () => {
    const block = conference.slice(at(conference, 'const silenceWatchdogRef'), at(conference, 'Clear on unmount (call ended)'));

    it('feeds the watchdog the mic sender\'s own getStats() report', () => {
        expect(block).toContain('readOutboundAudio(');
        expect(block).toContain('Track.Source.Microphone');
        expect(block).toContain('getRTCStatsReport()');
    });

    it('never feeds it localParticipant.audioLevel (the SFU\'s thresholded speaker report read 0 beside a live 60 kbps sender)', () => {
        expect(code(block)).not.toMatch(/audioLevel/);
        expect(code(watchdog)).not.toMatch(/audioLevel/);
        expect(code(watchdog)).not.toMatch(/outboundLevel/);
    });

    it('reads the meter through the peak-hold + age accessor, so a dead meter is not a quiet user', () => {
        expect(block).toContain('takePipelinePeak(');
        expect(block).toContain('pipelineAgeMs: peak.ageMs');
    });

    it('judges nothing while the room is not connected or is reconnecting, and skips the stats call while muted', () => {
        expect(block).toContain('room?.state === ConnectionState.Connected && !isReconnectingRef.current');
        expect(block.indexOf('if (micEnabled)')).toBeGreaterThan(-1);
        expect(block.indexOf('if (micEnabled)')).toBeLessThan(block.indexOf('readOutboundAudio('));
    });

    it('never overlaps two stats reads', () => {
        expect(block).toContain('if (busy) return;');
    });
});

describe('a trip is reported with its cause and tries the safe self-repair', () => {
    const effect = conference.slice(at(conference, 'The watchdog tripped: say which kind'), at(conference, 'The published-mic device follower'));

    it('reports the cause and the AudioContext state, and resumes a context that is not running', () => {
        expect(effect).toContain("reportBeta('call_one_way_audio', { direction: 'out', cause })");
        expect(effect).toContain("logCallEvent('audio_out_stall', { cause, ctx: rec.state, resumed: rec.resumed })");
        expect(effect).toContain('voiceProcessorManager.getCurrentProcessor()?.recoverContext()');
    });

    it('the banner says what is actually wrong for each cause', () => {
        expect(conference).toContain("silenceCause === 'no_rtp'");
        expect(conference).toContain("isn't sending any audio");
    });
});

describe('the inbound detector reports which leg is dead', () => {
    it('sends the booleans on the beta event and mirrors them into the call log', () => {
        expect(monitor).toContain("reportBeta('call_one_way_audio', { direction: 'in', cause: 'rtp_flat', sfu_hears: stalled.sfuHears, other_flowing: stalled.otherFlowing })");
        expect(monitor).toContain("logCallEvent('audio_in_stall', { cause: 'rtp_flat', sfu_hears: stalled.sfuHears, other_flowing: stalled.otherFlowing })");
    });

    it('still counts packets at the RTP level (before the E2EE cryptor), from the mic track only', () => {
        expect(monitor).toContain("s.type === 'inbound-rtp' && s.kind === 'audio'");
        expect(monitor).toContain('Track.Source.Microphone');
    });
});
