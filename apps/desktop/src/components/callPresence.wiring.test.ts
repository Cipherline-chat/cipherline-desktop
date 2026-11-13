import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Join / leave animations — source-level wiring pins for the surfaces that have
 * no render harness of their own (ServerContextPanel, SidebarConference,
 * FullscreenOverlay need a live server / LiveKit room). The behaviour is
 * unit-tested in utils/callPresenceLifecycle.test.ts and
 * call/presenceMotion.test.ts, and frame-tested in harness/call-anims.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
const ctxPanel = read('server', 'ServerContextPanel.tsx');
const floating = read('call', 'FloatingHuddleCard.tsx');
const conf = read('SidebarConference.tsx');
const strip = read('call', 'AudioOnlyStrip.tsx');
const fs = read('call', 'FullscreenOverlay.tsx');
const joining = read('call', 'JoiningCallView.tsx');
const motionSrc = read('call', 'presenceMotion.tsx') + read('call', 'presenceVariants.ts') + read('..', 'hooks', 'usePresenceRoster.ts');
const lifecycle = read('..', 'utils', 'callPresenceLifecycle.ts');

describe('server sidebar: every participant row joins / leaves through PresenceRoster', () => {
    it('huddle call rows (the case the owner reported: a join into a call that already exists)', () => {
        expect(ctxPanel).toContain('<PresenceRoster\n                                            ids={c.participants}');
        expect(ctxPanel).not.toContain('{c.participants.map(uid => {');
    });

    it('voice-channel rows, mounted even when empty so the FIRST join animates and the LAST leave ghosts out', () => {
        expect(ctxPanel).toContain('{!isMine && (\n                                            <div>\n                                                <PresenceRoster\n                                                    ids={participants}');
        expect(ctxPanel).not.toContain('{!isMine && participants.length > 0 && (');
    });

    it('the call card keeps owning first join / last leave, on the shared tokens', () => {
        expect(ctxPanel).toContain('animate={{ opacity: 1, y: 0, transition: CALL_CARD_ENTER }}');
        expect(ctxPanel).toContain('exit={{ opacity: 0, y: -6, transition: CALL_CARD_EXIT }}');
    });

    it('the floating huddle card (away from the server) uses the same rows', () => {
        expect(floating).toContain('<PresenceRoster\n                    ids={participantIds}');
        expect(floating).not.toContain('{participantIds.map(uid => {');
    });
});

describe('SidebarConference: one lifecycle tracker per call, fed the real roster', () => {
    it('gets the session tracker (survives this component remounting on a portal-root move) and observes the roster', () => {
        expect(conf).toContain("const presenceTracker = callPresenceTracker(sessionId || room?.name || 'call', {");
        expect(conf).toContain('presenceTracker.observe(participants.map(p => p.identity), presenceNow());');
        expect(conf).toContain('selfJoinIds: !instantEnter && localParticipant ? [localParticipant.identity] : [],');
    });

    it('every person-keyed tile / row is a PresenceMotion — no plain motion.div keyed on an identity is left', () => {
        expect(conf).not.toMatch(/<motion\.div key=\{p\.identity\}/);
        expect(conf).not.toMatch(/<motion\.div key=\{`(cam|ss|ssgate)-\$\{p\.identity\}`\}/);
        expect(conf).not.toMatch(/<motion\.div (layout )?key="local-cam(-portal)?"/);
        const tiles = conf.match(/<PresenceMotion key=/g) ?? [];
        // 2 share + 2 share-gate + 2 remote cam + local cam + 2 audio-row lists + DM wrap + DM grid
        expect(tiles.length).toBe(11);
        expect(conf).toContain('<PresenceMotion layout key="local-cam-portal"');
    });

    it('every AnimatePresence holding person tiles passes the leave context to exiting children', () => {
        const ap = conf.match(/<AnimatePresence[^>]*>/g) ?? [];
        const withCustom = ap.filter(a => a.includes('custom={presenceExit}'));
        expect(withCustom.length).toBe(7);
    });

    it('in-call rows exit IN the card (sync mode, ROW_VARIANTS), the DM / group grid reflows with layout (FLIP)', () => {
        const rowLists = conf.match(/<AnimatePresence (initial=\{(true|false)\} )custom=\{presenceExit\}>\n\s*\{audioOnlyParticipants\.map/g) ?? [];
        expect(rowLists.length).toBe(2);
        expect((conf.match(/surface="audio" kind="row"/g) ?? []).length).toBe(2);
        const grid = conf.slice(conf.indexOf('DM / group call tile grid'));
        expect(grid).toContain('<PresenceMotion key={p.identity} pid={p.identity} surface="audio" tracker={presenceTracker} layout');
        expect(grid.slice(0, grid.indexOf('</AnimatePresence>'))).toMatch(/key="ringing-tile"\n\s*layout/);
    });

    it('the compact audio strip and the fullscreen cells read the same tracker', () => {
        expect(strip).toContain('const tracker = currentCallPresenceTracker();');
        expect(strip).toContain('surface="audio"');
        expect(fs).toContain('const presence = currentCallPresenceTracker();');
        expect((fs.match(/<PresenceEnter/g) ?? []).length).toBe(5);
        expect((fs.match(/surface="fs"/g) ?? []).length).toBe(5);
    });

    it('your own join plays on the instant-join view (the hand-over mount stays still)', () => {
        expect(joining.match(/data-presence-join="self"/g)?.length).toBe(2);
        expect(joining).toContain('<PresenceIsolation>');
    });
});

describe('safety: purely visual, never a CSS keyframe class, never touches the call', () => {
    it('the presence layer imports nothing from LiveKit or the call engine', () => {
        for (const src of [motionSrc, lifecycle]) {
            expect(src).not.toMatch(/from ['"]livekit-client['"]/);
            expect(src).not.toMatch(/from ['"]@livekit\//);
            expect(src).not.toMatch(/\.disconnect\(|setSubscribed\(|callKey/);
        }
    });

    it('no CSS animation class (those restart when the call roots are reparented)', () => {
        expect(motionSrc).not.toMatch(/className=\{?["'`][^"'`]*animate-/);
        expect(motionSrc).not.toMatch(/@keyframes|animation:/);
    });

    it('rows isolate themselves from an ancestor AnimatePresence (initial={false} would block their join)', () => {
        expect(motionSrc).toContain('<PresenceContext.Provider value={null}>');
        expect(motionSrc).toMatch(/<PresenceIsolation>\n\s*\{items\.map/);
    });
});
