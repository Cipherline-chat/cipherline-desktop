/**
 * Source-wiring pins for the Linux screen-share work (2026-11-02): the places only a
 * full call render would exercise, the same approach as screenShareStartWiring.test.ts.
 * The decisions themselves are tested in utils/sharePlatformSupport.test.ts. Each pin
 * has a control showing the matcher can fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const sc = read('SidebarConference.tsx');
const mainTs = read('../../electron/main.ts');
const body = (name: string): string => {
    const i = sc.indexOf(`const ${name} = `);
    if (i < 0) return '';
    const j = sc.indexOf('\n    };\n', i);
    return sc.slice(i, j);
};

describe('Wayland portal: no second dialog for one share', () => {
    it('the probe of a new source is skipped through the portal', () => {
        const s = body('startScreenShareFrom');
        expect(s).toMatch(/options\.sourceId !== currentShareRef\.current\?\.sourceId && shouldProbeNewSource\(await captureViaPortal\(\)\)\) \{\s*const probe = await probeShareSource/);
    });
    it('every capture handshake timeout is the portal-aware one, not a bare 10 s', () => {
        expect(sc).not.toMatch(/getDisplayMedia handshake timed out'\)\), 10_000\)/);
        expect((sc.match(/getDisplayMedia handshake timed out'\)\), handshakeMs\)/g) ?? []).length).toBe(2);
        expect(sc).toMatch(/const handshakeMs = captureHandshakeMs\(await captureViaPortal\(\)\);/);
        expect(body('tryHotSwapScreenShare')).toMatch(/const viaPortal = await captureViaPortal\(\);\s*viaPortalRef\.current = viaPortal;\s*const handshakeMs = captureHandshakeMs\(viaPortal\);/);
    });
    it('a closed chooser during the hot swap ends the change and keeps the running share', () => {
        const hot = body('tryHotSwapScreenShare');
        expect(hot).toContain('if (cancelStopsSwap(viaPortal, err)) return { cancelled: err };');
        const s = body('startScreenShareFrom');
        expect(s).toMatch(/if \(swapped && typeof swapped === 'object'\) return reportShareStartError\(swapped\.cancelled, \{ stillSharing: true \}\);/);
    });
});

describe('Wayland portal: a fresh republish keeps the capture it has', () => {
    const s = body('startScreenShareFrom');
    it('the live capture is cloned BEFORE the old track is torn down', () => {
        const clone = s.indexOf('liveCapture.clone()');
        const teardown = s.indexOf('const tTeardown = performance.now();');
        expect(clone).toBeGreaterThan(0);
        expect(clone).toBeLessThan(teardown);
        expect(s).toMatch(/canReuseLiveCapture\(\{\s*(?:\/\/[^\n]*\n\s*)*viaPortal: viaPortalNow, fresh: true, live: true,/);
    });
    it('a re-used capture mints no grant and opens no handshake with main', () => {
        expect(s).toMatch(/if \(!reusedCapture\) \{\s*await mintShareGrant\(options\);\s*pendingScreenShareRef\.current = pendingShare\(options, useNativeAudio \? false : options\.audio\);\s*\}/);
    });
    it('it is the FIRST publish branch, and it publishes the clone as a user-provided screen-share track', () => {
        const reuse = s.indexOf('if (reusedCapture && !sliceLayout) {\n            // The live capture, kept');
        const slice = s.indexOf('} else if (sliceLayout) {');
        expect(reuse).toBeGreaterThan(0);
        expect(slice).toBeGreaterThan(reuse);
        expect(s).toContain('await localParticipant.publishTrack(new LocalVideoTrack(clone, undefined, true), { source: Track.Source.ScreenShare, ...publishOptions });');
    });
    it('a start that throws cannot leave the clone running', () => {
        const h = body('handleScreenShareSelect');
        expect(h).toMatch(/const leftover = reuseCloneRef\.current;\s*reuseCloneRef\.current = null;\s*if \(leftover\) \{ try \{ leftover\.stop\(\);/);
        // and once LiveKit owns it the ref is cleared, or that finally would stop the live share
        expect(s).toMatch(/reuseCloneRef\.current = null; \/\/ LiveKit owns it now/);
    });
    it('the pre-publish clamp event records that the capture was kept', () => {
        expect(s).toContain("logCallEvent('share_clamp', { codec, phase: 'pre', reused: true, how: reusedHow, ...settleEventDetails(settled) });");
    });
    it('control: the matchers fail on code without the wiring', () => {
        expect('if (isAdjustment && options.sourceId !== currentShareRef.current?.sourceId) { const probe = await probeShareSource')
            .not.toMatch(/shouldProbeNewSource/);
        expect(body('noSuchFunction')).toBe('');
    });
});

describe('Wayland portal: a change of source asks for the new capture before the share is touched', () => {
    const s = body('startScreenShareFrom');
    it('the new capture is acquired BEFORE the viewers are told to hold and BEFORE the old track comes down', () => {
        const ask = s.indexOf('shouldAcquireBeforeTeardown({');
        const acquire = s.indexOf('await acquireCaptureFirst(options)');
        const hold = s.indexOf('await shareRepublishSignal.begin(localParticipant)');
        const teardown = s.indexOf('const tTeardown = performance.now();');
        expect(ask).toBeGreaterThan(0);
        expect(acquire).toBeGreaterThan(ask);
        expect(hold).toBeGreaterThan(acquire);
        expect(teardown).toBeGreaterThan(hold);
        expect(s).toMatch(/shouldAcquireBeforeTeardown\(\{\s*viaPortal: await captureViaPortal\(\), live: localParticipant\.isScreenShareEnabled,/);
    });
    it('a closed dialog or any failure keeps the running share and changes nothing', () => {
        expect(s).toMatch(/const got = await acquireCaptureFirst\(options\);\s*if \(!got\.ok\) return reportShareStartError\(got\.error, \{ stillSharing: true \}\);/);
    });
    it('what was acquired is stopped by the start\'s own cleanup if nothing publishes it', () => {
        expect(s).toMatch(/acquiredCapture = got\.track;\s*reuseCloneRef\.current = acquiredCapture;/);
    });
    it('the share having ended while the chooser was open makes this a plain start, not an adjustment', () => {
        expect(s).toContain('let isAdjustment = localParticipant.isScreenShareEnabled;');
        expect(s).toMatch(/\n\s+isAdjustment = localParticipant\.isScreenShareEnabled;/);
    });
    it('it is published through the same fresh path as a kept capture: no second grant, no handshake', () => {
        expect(s).toContain('let reusedCapture: MediaStreamTrack | null = acquiredCapture;');
        expect(s).toMatch(/if \(!reusedCapture\) \{\s*await mintShareGrant\(options\);/);
    });
    it('a capture asked for first goes to the crop pipeline for a single-screen share', () => {
        expect(s).toContain('await publishCroppedShare(sliceLayout, reusedCapture);');
        expect(s).toContain('if (reuseCloneRef.current === capTrack) reuseCloneRef.current = null; // the crop owns it now');
    });
    it('the acquire asks for no audio and the same grant + pending-share handshake as the hot swap', () => {
        const a = body('acquireCaptureFirst');
        expect(a).toMatch(/await mintShareGrant\(options\);\s*pendingScreenShareRef\.current = pendingShare\(options, false\);/);
        expect(a).toContain('audio: false,');
        expect(a).toContain('captureHandshakeMs(true)');
    });
    it('control: the ordering matcher fails if the acquire came after the teardown', () => {
        const bad = 'const tTeardown = performance.now();\nawait acquireCaptureFirst(options)';
        expect(bad.indexOf('await acquireCaptureFirst(options)')).toBeGreaterThan(bad.indexOf('const tTeardown = performance.now();'));
    });
});

describe('Wayland portal: slice to whole keeps the crop pipeline\'s capture, only while it delivers frames', () => {
    const s = body('startScreenShareFrom');
    it('a clone of the pipeline\'s capture is checked against a REAL frame before it is trusted', () => {
        const clone = s.indexOf('cropPipelineRef.current.cloneSource()');
        const frame = s.indexOf('waitForFirstFrameSize(candidate, { timeoutMs: 1_500 })');
        const keep = s.indexOf("reusedHow = 'crop_source'");
        const teardown = s.indexOf('const tTeardown = performance.now();');
        expect(clone).toBeGreaterThan(0);
        expect(frame).toBeGreaterThan(clone);
        expect(keep).toBeGreaterThan(frame);
        expect(teardown).toBeGreaterThan(keep);
        expect(s).toContain("if (frame.how === 'frame') {");
    });
    it('a capture that is not delivering is stopped and the fresh capture the fallback exists for is taken', () => {
        expect(s).toMatch(/\} else \{\s*try \{ candidate\.stop\(\); \} catch \{ \/\* gone \*\/ \}/);
    });
    it('it is only asked through canReuseCropCapture (portal, same source, slice -> whole)', () => {
        expect(s).toMatch(/\} else if \(cropPipelineRef\.current && canReuseCropCapture\(\{\s*viaPortal: viaPortalNow,/);
    });
    it('the kept capture says how it was kept in the pre-publish clamp event', () => {
        expect(s).toContain("logCallEvent('share_clamp', { codec, phase: 'pre', reused: true, how: reusedHow, ...settleEventDetails(settled) });");
    });
});

describe('main: nothing read-only opens the portal', () => {
    it('the diagnostics lookup does not enumerate screens through the portal', () => {
        expect(mainTs).toContain("if (!offered && sourceKind === 'screen' && !captureViaPortal()) {");
    });
    it('a capture of a source the picker never offered is refused through the portal, not looked up (a list request IS the chooser)', () => {
        const i = mainTs.indexOf("ipcMain.handle('desktop-capturer-resolve'");
        const resolveBody = mainTs.slice(i, mainTs.indexOf("ipcMain.handle('annot-overlay:show'", i));
        expect(resolveBody).toMatch(/if \(!match && !captureViaPortal\(\)\) \{\s*[^}]*desktopSources\.request\(\{ types: \['window', 'screen'\]/);
        // control: the matcher fails on the old unconditional fallback
        expect("if (!match) {\n const fresh = await desktopSources.request({ types: ['window', 'screen']").not.toMatch(/if \(!match && !captureViaPortal\(\)\)/);
    });
    it('every way out of a capture resolve leaves a capture:resolve row (outcome, cache hit/miss, portal, ms)', () => {
        const i = mainTs.indexOf("ipcMain.handle('desktop-capturer-resolve'");
        const resolveBody = mainTs.slice(i, mainTs.indexOf("ipcMain.handle('annot-overlay:show'", i));
        expect(resolveBody).toContain("freezeMonitor.event('capture:resolve', Date.now() - resolveStartedAt,");
        for (const outcome of ["'cancelled'", "'malformed'", "'no_source'", "'error'"]) expect(resolveBody).toContain(`noteResolve(${outcome});`);
        expect(resolveBody).toContain('noteResolve(`denied_${decision.why}`);');
        expect(resolveBody).toContain("noteResolve(decision.via === 'dialog' ? 'ok_dialog' : 'ok');");
        // no title, no id: the kind of source only
        expect(resolveBody).toContain("kind=${typeof sourceId === 'string' ? sourceId.split(':')[0].slice(0, 8) : '-'}");
    });
    it('main answers share:capture-path from the launch environment', () => {
        expect(mainTs).toContain("ipcMain.handle('share:capture-path', () => ({");
        expect(mainTs).toContain('viaPortal: captureViaPortal(),');
        // restoreListed is never true off the portal (the renderer reads both from one probe)
        expect(mainTs).toContain("restoreListed: captureViaPortal() && portalRestoreMode(process.env) === 'listed',");
    });
});
