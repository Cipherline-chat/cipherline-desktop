import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CallEventMonitor and SidebarConference cannot be mounted under vitest, so this
 * reads the source to pin the WIRING of the freeze / dip diagnostics (the numbers
 * are tested where they are computed: shareFreezeContext, shareSecondRing,
 * shareEncoderOverload, shareRxStats). Survey of 30 screen_share reports, 2026-11.
 */
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const SC = src('SidebarConference.tsx');
const CEM = src('call/CallEventMonitor.tsx');

describe('viewer: freezes of a screen share carry their context', () => {
    it('a SHARE\'s freeze_start / freeze_end go through the share logger (counters + ring); a camera keeps its short line', () => {
        expect(CEM).toContain('logShareFreezeStart({ track: name, bg: isWindowBackground(), delta: freezeDelta(st.fc, fcNow)');
        expect(CEM).toMatch(/logShareFreezeEnd\(\{ track: name, ms: Math\.round\(now - st\.frozenSince\), delta: freezeDelta\(st\.fbase, fcNow\)/);
        expect(CEM).toContain("logCallEvent('freeze_start', { track: name, bg: isWindowBackground(), rx: rxSince(st.packets, packets) });");
        expect(CEM).toContain("logCallEvent('freeze_end', { track: name, ms: Math.round(now - st.frozenSince) });");
    });

    it('the freeze baseline is the sample BEFORE the freeze was seen, and is cleared when it ends', () => {
        expect(CEM).toContain('st.fbase = st.fc;');
        expect(CEM).toContain('st.fc = fcNow;');
        expect(CEM).toMatch(/st\.frozenSince = null;\s*st\.fbase = null;/);
    });

    it('shares and cameras are named in separate placeholder namespaces', () => {
        expect(CEM).toContain("trackPlaceholder(pub.trackSid, source === Track.Source.Camera ? 'remote-video' : 'remote-screen')");
    });

    it('a 1 s read feeds the ring of each watched share, and is stopped on unmount', () => {
        expect(CEM).toContain('const ringIv = setInterval(() => { void ringTick(); }, 1000);');
        expect(CEM).toContain('watch.observeSecond(at, report, info.playback, info.playbackKey);');
        expect(CEM).toMatch(/clearInterval\(iv\);\s*clearInterval\(ringIv\);/);
    });

    it('the tile\'s presented frames come from the element that is actually drawing (not the largest hidden copy)', () => {
        expect(CEM).toContain('pickShareVideoElements(els');
        expect(CEM).toMatch(/playback: presenting \? readPlaybackSnapshot\(presenting, at\) : null,\s*playbackKey: presenting,/);
    });

    it('a healthy share still writes rx_video_health once a minute, with packets and share_ref', () => {
        expect(CEM).toContain('quietHealthDue(now, r.quietAt)');
        expect(CEM).toMatch(/packets: Math\.max\(0, cur\.packetsReceived - r\.win\.packetsReceived\),\s*share_ref: shareRef,/);
    });
});

describe('sharer: the dip and the overload reasons', () => {
    it('share_fps says how many layers are active, and a dip under half the target writes the last seconds', () => {
        expect(SC).toContain('const act = num(d.act);');
        expect(SC).toContain('const dip = shareFpsDip({ target: share.frameRate, src: src_fps, enc: enc_fps, sent: sent_fps, act });');
        expect(SC).toContain('logShareTxRing({ shareRef, why: dip, target: share.frameRate, summary });');
    });

    it('the 1 s sender read is stopped with the effect', () => {
        expect(SC).toContain('const txIv = setInterval(() => { void txTick(); }, 1000);');
        expect(SC).toContain('clearInterval(txIv);');
    });

    it('the overload watch\'s reason changes are logged after every observation', () => {
        expect(SC).toMatch(/for \(const note of overload\.takeNotes\(\)\) \{\s*logCallEvent\('share_encoder_overload', overloadNoteDetail\(note,/);
    });
});
