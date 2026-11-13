/**
 * Owner 2026-10-24: "I don't hear the viewer sound on my screenshare most of
 * the time. This happens right after I start a screenshare and then someone
 * joins shortly after."
 *
 * The cue epoch is `<sid|pending>:<live|recon>`, read during render. The
 * conference only re-renders on roster events, so the first render that sees
 * the publication's sid is very often the one CAUSED by the first viewer's
 * Watch — and the reducer treated pending→sid as a brand-new epoch, adopting
 * that viewer into the silent baseline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialViewerCueState, reduceViewerCues, isSidArrival, VIEWER_CUE_GRACE_MS } from './screenShareViewers';

const PENDING = 'pending:live';
const SID = 'TR_abc:live';

describe('reduceViewerCues — the sid arriving in the same render as the first viewer', () => {
    it('the first viewer of a fresh share is cued even when the sid lands in that same render', () => {
        const s0 = reduceViewerCues(initialViewerCueState(), { epoch: PENDING, viewers: [], now: 0 }).state;
        const r = reduceViewerCues(s0, { epoch: SID, viewers: ['alice'], now: VIEWER_CUE_GRACE_MS + 500 });
        expect(r.cues).toEqual(['start']);
        expect(r.state.epoch).toBe(SID);
    });

    it('a restart keeps its grace window across the sid arrival (no second grace)', () => {
        const off = reduceViewerCues(reduceViewerCues(initialViewerCueState(), { epoch: SID, viewers: [], now: 0 }).state, { epoch: '', viewers: [], now: 100 }).state;
        const s0 = reduceViewerCues(off, { epoch: PENDING, viewers: [], now: 200 }).state;
        const s1 = reduceViewerCues(s0, { epoch: SID, viewers: [], now: 200 + VIEWER_CUE_GRACE_MS - 100 }).state;
        expect(s1.armedAt).toBe(200);
        const r = reduceViewerCues(s1, { epoch: SID, viewers: ['bob'], now: 200 + VIEWER_CUE_GRACE_MS + 50 });
        expect(r.cues).toEqual(['start']);
    });

    it('a viewer right after a new share starts cues, in the same render as the sid or not', () => {
        const t = Date.UTC(2026, 10, 2); // A real clock: the cooldown's zero is decades behind it.
        const s0 = reduceViewerCues(initialViewerCueState(), { epoch: PENDING, viewers: [], now: t }).state;
        expect(reduceViewerCues(s0, { epoch: SID, viewers: ['alice'], now: t + 300 }).cues).toEqual(['start']);
        expect(reduceViewerCues(s0, { epoch: PENDING, viewers: ['alice'], now: t + 300 }).cues).toEqual(['start']);
    });

    it('a reconnect or a republish (a different sid) is still a new, silent epoch', () => {
        const s0 = reduceViewerCues(initialViewerCueState(), { epoch: SID, viewers: ['alice'], now: 0 }).state;
        expect(reduceViewerCues(s0, { epoch: 'TR_abc:recon', viewers: ['alice', 'bob'], now: 10_000 }).cues).toEqual([]);
        expect(reduceViewerCues(s0, { epoch: 'TR_new:live', viewers: ['alice', 'bob'], now: 10_000 }).cues).toEqual([]);
    });

    it('isSidArrival', () => {
        expect(isSidArrival('pending:live', 'TR_x:live')).toBe(true);
        expect(isSidArrival('pending:recon', 'TR_x:recon')).toBe(true);
        expect(isSidArrival('pending:live', 'TR_x:recon')).toBe(false);
        expect(isSidArrival('TR_a:live', 'TR_b:live')).toBe(false);
        expect(isSidArrival('', 'TR_b:live')).toBe(false);
    });

    it('the conference builds its epoch as "<sid|pending>:<live|recon>"', () => {
        const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
        expect(src).toContain("`${localSharePub?.trackSid ?? 'pending'}:${isReconnecting ? 'recon' : 'live'}`");
    });
});
