import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for out-of-call camera / screen-share presence.
 *
 * The pieces are unit-tested in isolation (utils/callMediaPresence.test.ts,
 * hooks/useCallMediaReporter.test.ts, server/ParticipantStatusIcons.test.ts);
 * this pins that each one is actually REACHED — the "built and tested but
 * never registered" class of bug. Dashboard.tsx has no render harness, so a
 * mount test would cost far more than it pins (same reasoning as
 * avatarWarmingWiring.test.ts).
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dashboard = read('Dashboard.tsx');
const realtime = read('../hooks/useRealtime.ts');
const servers = read('../hooks/useServers.ts');
const panel = read('server/ServerContextPanel.tsx');
const home = read('HomePanel.tsx');

describe('reporting MY state', () => {
    it('Dashboard mounts the reporter inside CallProvider with the realtime sender and both call kinds', () => {
        const at = dashboard.indexOf('<CallMediaReporterBridge');
        expect(at).toBeGreaterThan(dashboard.indexOf('<CallProvider>'));
        const el = dashboard.slice(at, dashboard.indexOf('/>', at));
        for (const prop of ['userId={userId}', 'huddleCallId={activeHuddleCallId}', 'voiceChannelId={activeVoiceChannelId}', 'connCount={wsConnectCount}', 'send={sendCallMediaReport}']) {
            expect(el).toContain(prop);
        }
    });

    it('useRealtime sends call:media_report and exposes the sender', () => {
        expect(realtime).toContain("event: 'call:media_report'");
        expect(realtime).toMatch(/return \{[\s\S]*sendCallMediaReport,/);
    });
});

describe('receiving everyone else\'s state', () => {
    it('useRealtime applies call:media_state into the presence store', () => {
        expect(realtime).toMatch(/msg\.event === 'call:media_state'\)\s*\{\s*applyCallMediaEvent\(msg\.data\)/);
    });

    it('join/leave and call-destroyed events clear media', () => {
        expect(realtime).toContain('clearCallMediaUser(voiceChannelMediaKey(msg.data.channel_id), msg.data.user_id)');
        expect(realtime).toContain('clearCallMediaUser(huddleCallMediaKey(msg.data.call_id), msg.data.user_id)');
        expect(realtime).toContain('clearCallMediaKey(huddleCallMediaKey(msg.data.call_id))');
    });

    it('both seeds feed the store (full seed replaces, per-Calls-channel list is partial)', () => {
        expect(dashboard).toContain('applyCallMediaSeed(callMediaEntriesFromSeed(servers), { replaceAll: true })');
        expect(servers).toContain('applyCallMediaSeed(callMediaEntriesFromCalls(');
    });
});

describe('rendering', () => {
    it('both sidebar participant lists use the shared icons, keyed to their call', () => {
        expect(panel).toContain('mediaKey={huddleCallMediaKey(c.call_id)}');
        expect(panel).toContain('inThisCall={activeHuddleCallId === c.call_id}');
        expect(panel).toContain('mediaKey={voiceChannelMediaKey(vc.channel_id)}');
        // The old inline copies (which only knew LiveKit state) are gone.
        expect(panel).not.toContain('const ts    = participantTrackStates[uid];');
    });

    it('Home "Happening now" shows the summary for each live call', () => {
        expect(home).toContain('<CallMediaSummary');
    });
});
