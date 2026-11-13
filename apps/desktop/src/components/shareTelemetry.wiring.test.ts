import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference and CallEventMonitor cannot be mounted under vitest, so -
 * like shareFpsSurround.wiring.test.ts - this reads the source to pin the WIRING
 * of the share telemetry (share_rx_fps / share_net / share_display / share_ref,
 * the pinned share context and the report-time snapshot). The numbers
 * themselves are tested where they are computed (shareRxStats, shareNetStats,
 * displayRefresh, shareSnapshot, callEventLog).
 */
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const SC = src('SidebarConference.tsx');
const CEM = src('call/CallEventMonitor.tsx');
const COLLECT = src('../utils/diagnostics/collect.ts');
const BUNDLE = src('../utils/diagnostics/bundle.ts');
const MODAL = src('diagnostics/ReportProblemModal.tsx');
const HEALTH = src('../utils/shareHealth.ts');

describe('viewer (CallEventMonitor)', () => {
    it('reuses the track report the freeze / loss checks already fetched - no second stats call for share_rx_fps', () => {
        expect(CEM).toContain('const report = await track.getRTCStatsReport() as StatsLike | undefined;');
        expect(CEM).toContain('const cur = readInboundVideo(report);');
        expect(CEM.split('getRTCStatsReport()').length - 1).toBe(3); // the monitor's one + the snapshot provider's + the 1 s ring read (never feeds share_rx_fps)
        expect(CEM).toContain('w.watch.observe(now, report as ShareStatsLike | undefined');
    });

    it('only remote SCREEN SHARES are watched, and share_ref is resolved before the first sample', () => {
        expect(CEM).toMatch(/if \(source === Track\.Source\.ScreenShare\) \{\s*let w = watches\.get\(pub\.trackSid\);/);
        expect(CEM).toContain('w.watch.setRef(await resolveShareRef(pub.trackSid));');
    });

    it('logs the three viewer kinds with every requested field', () => {
        expect(CEM).toMatch(/logCallEvent\('share_rx_start', \{\s*share_ref: o\.start\.share_ref, track: o\.start\.track, codec: o\.start\.codec, decoder: o\.start\.decoder,/);
        for (const k of ['share_ref', 'track', 'rx_fps', 'dec_fps', 'drop_fps', 'disp_fps', 'jb_ms', 'res', 'layer', 'focus', 'tile']) {
            expect(CEM).toMatch(new RegExp(`logCallEvent\\('share_rx_fps', \\{[^}]*\\b${k}: `));
        }
        expect(CEM).toContain("logCallEvent('share_display', { share_ref: d.share_ref, role: d.role, hz: d.hz, hz_src: d.hz_src });");
    });

    it('the display rate is one short rAF measurement per watched share, only while the page is visible (a second-monitor viewer still measures)', () => {
        expect(CEM).toContain('if (!document.hidden && w.watch.claimHzMeasurement(now)) {');
        expect(CEM).toContain('measureDisplayHz({ visible: () => !document.hidden })');
        expect(CEM).not.toMatch(/requestAnimationFrame\(/);
    });

    it('watches are dropped with their subscription and on unmount, and the snapshot provider is unregistered', () => {
        // Dropping a watch also ends its stall recovery, so a share is never left paused at the SFU.
        expect(CEM).toContain('for (const [sid, w] of [...watches.entries()]) if (!seen.has(sid)) { w.recovery.stop(); watches.delete(sid); }');
        expect(CEM).toMatch(/clearInterval\(iv\);\s*clearInterval\(ringIv\);\s*offSnap\(\);\s*for \(const w of watches\.values\(\)\) w\.recovery\.stop\(\);\s*watches\.clear\(\);/);
        expect(CEM).toContain('const offSnap = setShareSnapProvider(');
    });

    it('never reads an identity: the SID only feeds resolveShareRef and map keys', () => {
        const sidReads = [...CEM.matchAll(/\.trackSid\b/g)].length;
        expect(sidReads).toBeGreaterThan(0);
        for (const line of CEM.split('\n').filter(l => /\.trackSid\b/.test(l))) {
            expect(line, line).toMatch(/resolveShareRef\(|watches\.(get|set)\(|seen\.add\(|decode\.(get|set)\(|rx\.(get|set)\(|trackPlaceholder\(|\.trackSid, |\{ forEach|shareFallbackNotice\.isOptedOut\(/);
        }
        expect(CEM).not.toMatch(/logCallEvent\([^)]*trackSid/);
        expect(CEM).not.toMatch(/\.identity|\.metadata\b|participant\.name/);
    });
});

describe('sharer (SidebarConference + ShareStatsSampler)', () => {
    it('share_net is logged from the SAME sender report as share_fps (the sampler), with cap and ref wired in', () => {
        expect(SC).toContain('getShareRef: () => shareRef,');
        expect(SC).toContain('capKbpsFromEncodings(sender.getParameters().encodings)');
        for (const k of ['share_ref', 'kbps', 'cap_kbps', 'avail_kbps', 'rtt_ms', 'loss_pct', 'enc_ms']) {
            expect(SC).toMatch(new RegExp(`logCallEvent\\('share_net', \\{[^}]*\\b${k}: `));
        }
        expect(HEALTH).toContain('const stats = await this.deps.getStats();');
        expect(HEALTH.match(/await this\.deps\.getStats\(\)/g)).toHaveLength(2); // sample() once, the watchdog once: net reuses sample()'s report
        expect(HEALTH).toMatch(/this\.deps\.report\(buildShareFpsDetail[\s\S]*this\.deps\.reportNet\(nd\)/);
    });

    it('share_start and share_display carry share_ref; the display Hz comes from the main-process diagnostics (no new IPC)', () => {
        expect(SC).toMatch(/logCallEvent\('share_start', \{[^}]*verdict: 'published'[^}]*share_ref: publishedRef \?\? ''/);
        expect(SC).toMatch(/logCallEvent\('share_display', \{\s*share_ref: shareRef, role: 'sharer',\s*hz: main\.displayHz \?\? NaN, hz_src: main\.displayHzSource \?\? 'unknown', share: main\.sourceKind,/);
        expect(SC).toContain("if (!claimShareOnce('share_display', shareRef)) return;");
        expect(SC).toContain('subscribeScreenShareSession(logDisplay)');
        expect(SC).toContain('return () => { alive = false; clearInterval(txIv); offSession(); off(); sampler.dispose(); };');
    });

    it('share_fps keeps its 11 keys (full; share_ref rides on share_net / share_start / share_display); `act` (active layers) took the slot of `hw`', () => {
        expect(SC).toMatch(/logCallEvent\('share_fps', \{\s*src_fps, enc_fps, sent_fps, limit, enc, act,\s*target: share\.frameRate, focus: d\.focus === true,\s*fg_state: fgLog\.fg_state, fg_exe: fgLog\.fg_exe, fg_cover: fgLog\.fg_cover,\s*\}\);/);
    });
});

describe('report (collect / bundle / modal)', () => {
    it('opening the reporter starts the snapshot and reads the pinned context', () => {
        expect(COLLECT).toContain('const snapshot = startShareSnapshot();');
        expect(COLLECT).toContain('pinnedCallEvents: readPinnedCallEvents(),');
        expect(COLLECT).toContain('...(snapshot ? { shareSnapshot: snapshot } : {}),');
    });
    it('building reads the live snapshot, moves generated_at to its newest sample and passes both to the builder', () => {
        expect(COLLECT).toContain('now: Math.max(p.now, p.shareSnapshot?.latestAt() ?? 0),');
        expect(COLLECT).toContain('pinnedCallEvents: p.pinnedCallEvents,');
        expect(COLLECT).toContain('snapshotCallEvents: snapEvents,');
    });
    it('the builder merges them into call_events under the cap, and trimming protects the context', () => {
        expect(BUNDLE).toContain('if (spec.callEvents) raw.call_events = mergeCallEvents(input, now);');
        expect(BUNDLE).toContain('SHARE_CONTEXT_KINDS.has(e.event)');
    });
    it('the modal rebuilds once when the snapshot completes (so Save / Send carry all of it)', () => {
        expect(MODAL).toContain('void h.done.then(() => { if (alive) setSnapshotTick(n => n + 1); });');
        expect(MODAL).toMatch(/crashEntry, snapshotTick\]\);/);
    });
});
