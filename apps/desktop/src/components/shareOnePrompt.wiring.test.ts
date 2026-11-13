/**
 * Source-wiring pins for "the desktop's screen chooser opens exactly ONCE per user choice" (Linux Wayland,
 * 2026-11-04). The decisions are tested where they live (utils/sharePlatformSupport.test.ts,
 * utils/screenShare.portalRetune.test.ts, electron/capture-consent.test.ts, electron/portal-source.test.ts);
 * this pins the places only a full call render or a running main process would exercise. Every pin has a
 * control showing the matcher can fail.
 *
 * What was measured (harness/linux-share-matrix, stage `probe`, Electron 43.8.1, frames pulled):
 *   - a capture answered with a made-up id (no listing) .......... 1 ScreenCast.Start
 *   - a listing, then a capture answered with the listed source .. 2 Start (a listing is a chooser, and the selection
 *                                                                   is NOT held for the capture that follows)
 *   - applyConstraints on a live portal capture .................. +1 Start per change
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const sc = read('SidebarConference.tsx');
const picker = read('ScreenSharePickerModal.tsx');
const mainTs = read('../../electron/main.ts');
const body = (src: string, start: string, end: string): string => {
    const a = src.indexOf(start);
    expect(a, start).toBeGreaterThan(-1);
    const b = src.indexOf(end, a + start.length);
    expect(b, end).toBeGreaterThan(a);
    return src.slice(a, b);
};
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('main: nothing lists on the portal, the capture is the one chooser', () => {
    const list = body(mainTs, "ipcMain.handle('desktop-capturer-get-sources'", "ipcMain.handle('screen-capture:get-access-status'");
    it('the source-list handler answers [] on the portal BEFORE it could ask for a listing', () => {
        const guard = list.indexOf('if (captureViaPortal()) {');
        const request = list.indexOf('desktopSources.request(');
        expect(guard).toBeGreaterThan(-1);
        expect(request).toBeGreaterThan(guard);
        expect(list.slice(guard, request)).toContain('return [];');
    });

    const resolveH = body(mainTs, "ipcMain.handle('desktop-capturer-resolve'", '// ── Desktop annotation overlay');
    it('a placeholder is admitted without a list, ONLY through the portal and ONLY in its own shape', () => {
        expect(resolveH).toContain('const portalPlaceholder = captureViaPortal() && isPortalSourceId(sourceId);');
        expect(resolveH).toMatch(/if \(portalPlaceholder\) \{\s*match = \{ id: sourceId, name: PORTAL_SOURCE_NAME/);
    });
    it('consent is unchanged: the placeholder is authorized like any source before Chromium is answered', () => {
        const auth = resolveH.indexOf('captureConsent.authorizeVideo(');
        const answer = resolveH.indexOf('cb({ video: portalVideo ??');
        expect(auth).toBeGreaterThan(-1);
        expect(answer).toBeGreaterThan(auth);
        expect(resolveH).toContain('portalCaptureVideo(++portalCaptureSeq)');
        // still exactly one place hands a source to Chromium
        expect(strip(mainTs).match(/\bcb\(\{ video:/g)).toHaveLength(1);
    });
    it('a source that is not a placeholder is never looked up on the portal (refused), and the ONE listing the resolve step may make is a pick (portal-pick.ts)', () => {
        expect(resolveH).toMatch(/if \(!match && !captureViaPortal\(\)\) \{[\s\S]*?desktopSources\.request\(/);
        // two listing calls in the step: the off-portal id lookup above, and the pick below - nothing else can open the desktop's chooser
        expect(resolveH.match(/desktopSources\.request\(/g)).toHaveLength(2);
        const pickAt = resolveH.indexOf('portalRestoreMode(process.env) === \'listed\'');
        const listAt = resolveH.indexOf("desktopSources.request({ types: ['screen', 'window']");
        expect(pickAt).toBeGreaterThan(-1);
        expect(listAt).toBeGreaterThan(pickAt);
    });
    it('the pick: a NEW placeholder lists once (the one dialog); the SAME placeholder is answered from its pick and never lists; a closed dialog is a cancel', () => {
        const pick = resolveH.slice(resolveH.indexOf("portalRestoreMode(process.env) === 'listed'"), resolveH.indexOf('cb({ video: portalVideo ??'));
        expect(pick).toContain('planPortalPick(portalPicks, sourceId)');
        expect(pick).toMatch(/if \(plan\.action === 'reuse'\) \{\s*portalVideo = plan\.source;\s*\} else \{/);
        expect(pick).toContain('const pick = pickFromListing(listed);');
        expect(pick).toMatch(/if \(!pick\) \{\s*cb\(null\);\s*noteResolve\('portal_pick_closed'\);\s*return 'cancelled';\s*\}/);
        // the listing happens only on the 'list' branch, and the pick is remembered only after it produced one
        expect(pick.indexOf('desktopSources.request')).toBeGreaterThan(pick.indexOf('} else {'));
        expect(pick.indexOf('portalPicks.set(sourceId, pick)')).toBeGreaterThan(pick.indexOf('if (!pick)'));
    });
    it('on a desktop without the restore mode ("single") the placeholder is answered as before: a made-up id, no listing', () => {
        expect(resolveH).toContain('portalVideo ?? (portalPlaceholder ? portalCaptureVideo(++portalCaptureSeq)');
        expect(resolveH).toMatch(/if \(portalPlaceholder && portalRestoreMode\(process\.env\) === 'listed'\) \{/);
    });
    it('the last listing helper that runs for a share (the share diagnostics) stays off the portal', () => {
        expect(mainTs).toMatch(/if \(!offered && sourceKind === 'screen' && !captureViaPortal\(\)\) \{\s*try \{\s*const fresh = await desktopSources\.request/);
    });
    it('control: the matchers fail on code without the guard', () => {
        expect("ipcMain.handle('x', async () => { const s = await desktopSources.request({}); })".indexOf('if (captureViaPortal()) {')).toBe(-1);
    });
});

describe('the picker: nothing is listed on the portal', () => {
    it('the source list is fetched only when the capture path is KNOWN to be enumerated (X11), never on the portal or while unknown', () => {
        expect(picker).toMatch(/if \(!isLinux \|\| viaPortal === null\) return;\s*if \(viaPortal\) \{\s*(?:\/\/[^\n]*\n\s*)?setLinuxStep\('portal'\);\s*return;\s*\}\s*void fetchLinuxSources\(\);/);
    });
    it('"Choose what to share…" and "Apply to current share" never call the source list', () => {
        const handlers = body(picker, 'const portalOptions = (sourceId: string)', 'const handleCancel');
        expect(handlers).not.toContain('getDesktopSources');
        expect(handlers).toContain('newPortalSourceId()');
        expect(handlers).toContain('portalOptions(liveSourceId)');
    });
    it('the warm-up of the picker never lists on Linux', () => {
        expect(sc).toMatch(/if \(!api\?\.getDesktopSources \|\| api\.platform === 'linux' \|\| !canScreenShare\) return;/);
    });
    it('the quick-share keybind starts the capture on the portal instead of listing first', () => {
        const q = body(sc, "'keybind:quick-screenshare':", 'const api = window.electronAPI;');
        expect(q).toBeTruthy();
        const handler = body(sc, 'const api = window.electronAPI;\n                    // Wayland (portal)', 'if (!api?.getDesktopSources) {');
        expect(handler).toContain('if (await captureViaPortal()) {');
        expect(handler).toContain('sourceId: newPortalSourceId()');
        expect(handler).not.toContain('getDesktopSources');
    });
});

describe('renderer: the portal capture is opened at the quality picked, and a live change re-opens it only where portalCapturePlan says', () => {
    it('every getDisplayMedia that can reach the portal asks for the PICKED quality, never the monitor\'s maximum (acquire-first, hot swap, fresh start)', () => {
        expect(body(sc, 'const acquireCaptureFirst = async', 'const startScreenShareFrom = async')).toContain('portalCaptureRequest(options, await readCaptureCeiling())');
        expect(body(sc, 'const tryHotSwapScreenShare = async', 'const shareSenderParamOpts')).toContain('portalCaptureRequest(options, await readCaptureCeiling(),');
        expect(body(sc, 'const startScreenShareFrom = async', 'const tPublish = performance.now();')).toContain('portalCaptureRequest(options, captureCeiling, codec)');
        // the old request took a source id and asked for the maximum: gone from every call
        expect(sc).not.toContain('portalCaptureRequest(options.sourceId');
    });
    it('each portal capture records what it was asked for (the decision of a later change needs it)', () => {
        expect(body(sc, 'const acquireCaptureFirst = async', 'const startScreenShareFrom = async')).toContain('portalAskedRef.current = { fps, width: cap.box.width, height: cap.box.height };');
        expect(body(sc, 'const tryHotSwapScreenShare = async', 'const shareSenderParamOpts')).toContain('portalAskedRef.current = { fps: portalCap.frameRate, width: capBox.width, height: capBox.height };');
        expect(body(sc, 'const startScreenShareFrom = async', 'const tPublish = performance.now();')).toContain('portalAskedRef.current = { fps: captureFps, width: captureBox.width, height: captureBox.height };');
    });
    it('the kept capture is re-constrained on the portal ONLY where portalCapturePlan says (a raise past what it was asked for), and everywhere else', () => {
        const keep = body(sc, 'if (reusedCapture && !sliceLayout) {', '} else if (sliceLayout) {');
        expect(keep).toMatch(/if \(!portalCap \|\| portalRetuneTouchesCapture\(\{ restoreListed: restoreListedRef\.current, asked: portalAskedRef\.current, want: cloneWant \}\)\) \{\s*try \{\s*await clone\.applyConstraints\(/);
        expect(keep).toContain('settleCaptureSize(clone, captureBox)');
        const crop = body(sc, 'const captureDisplayForCrop = async', 'await mintShareGrant(options);\n            pendingScreenShareRef.current = pendingShare(options, false);\n            const handshakeMs');
        expect(crop).toContain('if (!portalCap) try { await capturedFirst.applyConstraints(');
    });
    it('every applyConstraints on a share track is either off the portal or the kept-capture / retune paths guarded above', () => {
        const uses = sc.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /\.applyConstraints\(/.test(l) && !/^\s*\/\//.test(l));
        // the three guarded sites in this file (the echo-cancellation one is the mic, not a share)
        const share = uses.filter(({ l }) => /clone\.applyConstraints|capturedFirst\.applyConstraints/.test(l));
        expect(share.length).toBe(2);
        const src = read('../utils/screenShare.ts');
        const retune = body(src, 'export async function retuneScreenShareInPlace', 'export function maxShareFps');
        expect(retune).toMatch(/const touchCapture = !opts\.viaPortal \|\| portalRetuneTouchesCapture\(\{[^}]*\}\);\s*if \(touchCapture\) \{\s*if \(opts\.viaPortal\) opts\.onReopen\?\.\(\);\s*await msTrack\.applyConstraints\(/);
        // and it never asks the desktop for a new source by itself: a retune is applyConstraints on the live track, no getDisplayMedia
        expect(retune).not.toContain('getDisplayMedia');
    });
    it('a live retune passes viaPortal, what the capture was asked for and the restore mode; a capture left as it was is scaled by the sender (shareSenderParamOpts, reapply, codec swap)', () => {
        expect(sc).toMatch(/retuneScreenShareInPlace\(track, resolution, frameRate, \{\s*step: shareResStepRef\.current, captured, viaPortal: viaPortalRef\.current,\s*\.\.\.\(viaPortalRef\.current \? \{\s*restoreListed: restoreListedRef\.current,\s*asked: portalAskedRef\.current,\s*ceiling: await readCaptureCeiling\(\),\s*onAsked: \(a: CaptureAsk\) => \{ portalAskedRef\.current = a; \},\s*onReopen: \(\) => setScreenShareNotice\(\{ tone: 'info', text: applying \}\),\s*\} : \{\}\),\s*\}\)/);
        expect(body(sc, 'const shareSenderParamOpts =', 'const reapplyShareSenderParams')).toContain('viaPortalRef.current ? { box: captureBoxFor(options.resolution, codec) }');
        expect(sc.match(/\.\.\.\(viaPortalRef\.current \? \{ box: captureBoxFor\(/g)).toHaveLength(2); // both swapShareCodec callers
        expect(body(sc, 'const ssTrackSid = useLocalPublicationSid', 'const shareViewersRef')).toContain('viaPortalRef.current && !cropPipelineRef.current && !hdrPipelineRef.current');
    });
    it('control: the matcher fails on a retune that touches the capture unconditionally', () => {
        expect(/if \(touchCapture\) \{\s*if \(opts\.viaPortal\) opts\.onReopen\?\.\(\);\s*await msTrack\.applyConstraints\(/.test('await msTrack.applyConstraints({ frameRate: { max: 1 } });')).toBe(false);
    });
});

describe('republish paths reach no new portal request, audio on or off', () => {
    const start = body(sc, 'const startScreenShareFrom = async', 'const tPublish = performance.now();');
    it('a same-source pick through the portal is never a hot swap (a hot swap acquires a NEW capture); it republishes on the kept one', () => {
        expect(start).toMatch(/const portalSameSource = \(await captureViaPortal\(\)\) && localParticipant\.isScreenShareEnabled\s*&& currentShareRef\.current\?\.sourceId === options\.sourceId;/);
        expect(start).toMatch(/&& !hasLoopbackAudioPublished\s*&& !portalSameSource\s*\) \{\s*const swapped = await tryHotSwapScreenShare\(/);
        expect(start).toContain('if (!reusedCapture && localParticipant.isScreenShareEnabled && (fresh || portalSameSource)) {');
    });
    it('audio is not part of the decision to keep the capture', () => {
        expect(start).not.toMatch(/canReuseLiveCapture\(\{[^}]*audio/);
        const fn = body(read('../utils/sharePlatformSupport.ts'), 'export function canReuseLiveCapture(', '\n}\n');
        expect(fn).toContain('sameShareLayout');         // control: the slice really is the function
        expect(fn).not.toContain('audio');
        expect(body(read('../utils/sharePlatformSupport.ts'), 'export function canReuseCropCapture(', '\n}\n')).not.toContain('audio');
    });
    it('a kept capture renews the share\'s consent in main BEFORE the teardown ends the live share (so its native audio stays trusted)', () => {
        const keepBlock = body(start, 'reuseCloneRef.current = reusedCapture; // stopped by handleScreenShareSelect if nothing took it', 'if (localParticipant.isScreenShareEnabled) {\n            const tTeardown');
        expect(keepBlock).toContain('if (reusedCapture) await continueShareGrant(options);');
        const helper = body(sc, 'const continueShareGrant = async', 'const viaPortalRef');
        expect(helper).toContain('(await continueCaptureGrant(o.sourceId, o.audio)) ?? (await mintCaptureGrant(o.sourceId, o.audio))');
    });
    it('a NEW source is a new capture and a new consent: the acquire mints its own grant and resolves through main (not continued)', () => {
        const a = body(sc, 'const acquireCaptureFirst = async', 'const startScreenShareFrom = async');
        expect(a).toMatch(/await mintShareGrant\(options\);\s*pendingScreenShareRef\.current = pendingShare\(options, false\);/);
        expect(a).not.toContain('continueShareGrant');
        const hot = body(sc, 'const tryHotSwapScreenShare = async', 'const shareSenderParamOpts');
        expect(hot).toMatch(/await mintShareGrant\(options\);/);
        expect(hot).not.toContain('continueShareGrant');
    });
    it('a placeholder with an app\'s audio is "window" audio mode (the app handle), anything else on the portal is everything-except-us', () => {
        expect(start).toContain('const portalAppAudio = isPortalSourceId(options.sourceId) && !!options.appAudio?.handle;');
        expect(start).toContain("const nativeMode: 'window' | 'screen' = (isWindowSource || portalAppAudio) ? 'window' : 'screen';");
    });
});

describe('change of source: one chooser, and the old share keeps running until the new capture is in hand', () => {
    it('the acquire-before-teardown rule is still the portal\'s path for another source (a new placeholder is another source)', () => {
        const start = body(sc, 'const startScreenShareFrom = async', 'const tPublish = performance.now();');
        const acquire = start.indexOf('await acquireCaptureFirst(options)');
        const hold = start.indexOf('await shareRepublishSignal.begin(localParticipant)');
        const teardown = start.indexOf('const tTeardown = performance.now();');
        expect(acquire).toBeGreaterThan(0);
        expect(hold).toBeGreaterThan(acquire);
        expect(teardown).toBeGreaterThan(hold);
    });
});

describe('a portal capture is awaited until the user has answered (its first frame), never published before', () => {
    it('acquire-first waits for the first frame with the running share untouched, and a capture that never gets one is a cancel', () => {
        const a = body(sc, 'const acquireCaptureFirst = async', 'const startScreenShareFrom = async');
        expect(a).toContain('const first = await waitForFirstFrameSize(track, PORTAL_FIRST_FRAME_WAIT);');
        expect(a).toContain('if (!first.size) { try { track.stop(); } catch { /* gone */ } throw portalChooserClosedError(); }');
        expect(a.indexOf('waitForFirstFrameSize')).toBeLessThan(a.indexOf('return { ok: true, track };'));
    });
    it('the hot swap settles with the long wait on the portal and treats no frame as a closed chooser', () => {
        const hot = body(sc, 'const tryHotSwapScreenShare = async', 'const shareSenderParamOpts');
        expect(hot).toContain('settleCaptureSize(newMs, capBox, portalCap ? PORTAL_FIRST_FRAME_WAIT : {})');
        expect(hot).toContain('if (portalCap && !settledSwap.first) throw portalChooserClosedError();');
        expect(hot.indexOf('portalChooserClosedError()')).toBeLessThan(hot.indexOf('await lkTrack.replaceTrack(newMs'));
    });
    it('a fresh start publishes only after the first frame, with the long wait, and none stops the tracks and cancels', () => {
        const start = body(sc, 'const startScreenShareFrom = async', 'const tPublish = performance.now();');
        const rest = sc.slice(sc.indexOf('const tPublish = performance.now();'), sc.indexOf('const tPublish = performance.now();') + 9000);
        expect(rest).toContain('if (portalCap && !st.first) throw portalChooserClosedError();');
        expect(rest).toContain('...(portalCap ? { waitOptions: PORTAL_FIRST_FRAME_WAIT } : {})');
        expect(start).toBeTruthy();
    });
    it('the encoder watchdog is armed only AFTER the publish, so an open chooser can never read as a stall', () => {
        const rest = sc.slice(sc.indexOf('const tPublish = performance.now();'));
        expect(rest.indexOf('armEncoderWatchdog(options, codec, wdSender)')).toBeGreaterThan(rest.indexOf('publishScreenShareSettled('));
    });
});
