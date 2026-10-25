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

    it('the run keeps its grace window across the sid arrival (no second grace)', () => {
        const s0 = reduceViewerCues(initialViewerCueState(), { epoch: PENDING, viewers: [], now: 0 }).state;
        const s1 = reduceViewerCues(s0, { epoch: SID, viewers: [], now: VIEWER_CUE_GRACE_MS - 100 }).state;
        expect(s1.armedAt).toBe(0);
        const r = reduceViewerCues(s1, { epoch: SID, viewers: ['bob'], now: VIEWER_CUE_GRACE_MS + 50 });
        expect(r.cues).toEqual(['start']);
    });

    it('a viewer inside the first grace window is still absorbed (no pile-in storm)', () => {
        const s0 = reduceViewerCues(initialViewerCueState(), { epoch: PENDING, viewers: [], now: 0 }).state;
        expect(reduceViewerCues(s0, { epoch: SID, viewers: ['alice'], now: 1000 }).cues).toEqual([]);
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
