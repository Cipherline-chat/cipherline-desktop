/**
 * Source-shape pins for the webcam-quality work. The RULES are tested
 * behaviourally (utils/cameraQuality, cameraPublish, remoteVideoQuality,
 * callLoadMonitor, performanceOffer tests); this file guards that they are
 * actually CONNECTED — the multi-agent "module tested in isolation, never
 * wired" failure this repo has hit before.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', '..', rel), 'utf8');

const tile = read('components/call/VideoTile.tsx');
const banner = read('components/call/FocusedStreamBanner.tsx');
const fullscreen = read('components/call/FullscreenOverlay.tsx');
const sidebar = read('components/SidebarConference.tsx');
const pane = read('components/CallPane.tsx');
const vv = read('components/VoiceVideoSettings.tsx');
const adv = read('components/AdvancedSettings.tsx');
const guard = read('components/call/CallPerformanceGuard.tsx');
const mainTs = readFileSync(join(here, '..', '..', '..', 'electron', 'main.ts'), 'utf8');
const preload = readFileSync(join(here, '..', '..', '..', 'electron', 'preload.ts'), 'utf8');

describe('viewer side: size-based layers, one arbiter, pre-warm', () => {
    it('VideoTile claims its layer through the arbiter (no direct setVideoQuality for cameras)', () => {
        expect(tile).toMatch(/claimRemoteQuality\(layerPub\)/);
        expect(tile).toMatch(/pickTileLayer\(\{/);
        expect(tile).toMatch(/displayedPixels\(tileBox\.w, tileBox\.h, dpr/);
        // Shares go through the arbiter too now (pickShareLayer); no direct calls left.
        expect(tile.match(/\.setVideoQuality\(/g)).toBeNull();
        expect(tile).toMatch(/pickShareLayer\(\{/);
    });
    it('VideoTile pre-warms on press and hover', () => {
        expect(tile).toMatch(/onPointerDown=\{handlePointerDown\}/);
        expect(tile).toMatch(/onPointerEnter=\{handlePointerEnter\}/);
        expect(tile).toMatch(/onPointerLeave=\{endHover\}/);
        expect(tile).toMatch(/prewarmRemoteQuality\(layerPub\)/);
    });
    it('FocusedStreamBanner pre-warms on focus change, not after the crossfade, and no longer hard-codes HIGH', () => {
        expect(banner).toMatch(/return prewarmRemoteQuality\(pub\)/);
        expect(banner.indexOf('prewarmRemoteQuality(pub)')).toBeLessThan(banner.indexOf('}, FOCUS_CROSSFADE_MS);'));
        expect(banner.indexOf('}, FOCUS_CROSSFADE_MS);')).toBeGreaterThan(0);
        expect(banner).not.toMatch(/quality=\{VideoQuality/);
    });
    it('grid and sidebar pass the tile count instead of a fixed tier', () => {
        expect(fullscreen).toMatch(/isGridView=\{true\} videoCount=\{gridVideoCount\}/);
        expect(fullscreen).not.toMatch(/quality=\{/);
        expect(sidebar).toMatch(/videoCount=\{totalCamTiles\}/);
        expect(sidebar).not.toMatch(/quality=\{/);
    });
});

describe('publisher side', () => {
    it('dynacast is on, adaptiveStream stays off', () => {
        expect(pane).toMatch(/\n\s*dynacast: true,/);
        expect(pane).toMatch(/\n\s*adaptiveStream: false,/);
    });
    it('the first camera publish goes through cameraPublish.startCamera with the user\'s tier and encoder prefs', () => {
        expect(sidebar).toMatch(/startCamera\(asCameraParticipant\(localParticipant\), \{\s*\.\.\.cameraStartOptions\(\),/);
        expect(sidebar).toMatch(/tier: getCameraQualityTier\(\),/);
        expect(sidebar).toMatch(/pref: getCameraCodecPref\(\)/);
        expect(sidebar).toMatch(/installH264HighPreference\([\s\S]{0,200}'camera',/);
    });
    it('a device switch re-tunes the ladder; a tier change applies live', () => {
        expect(sidebar).toMatch(/switchActiveDevice\('videoinput'[\s\S]{0,400}retuneCamera\(/);
        expect(sidebar).toMatch(/subscribeCameraQualityPrefs\([\s\S]{0,300}applyCameraTier\(/);
    });
    it('the performance guard is mounted in the call', () => {
        expect(pane).toMatch(/<CallPerformanceGuard \/>/);
    });
});

describe('settings', () => {
    it('Voice & Video has Camera quality; Advanced has Camera encoder', () => {
        expect(vv).toMatch(/<b>Camera quality<\/b>/);
        expect(vv).toMatch(/onChange=\{setCameraQualityTier\}/);
        expect(adv).toMatch(/<b>Camera encoder<\/b>/);
        expect(adv).toMatch(/setCameraCodecPref\(o\.value\)/);
    });
});

describe('receive-side load + incoming video quality', () => {
    it('the guard samples incoming video and picks the offer by what is expensive', () => {
        expect(guard).toMatch(/new ReceiveLoadDetector\(\)/);
        expect(guard).toMatch(/decodeStrained: rv\.decodeBound/);
        expect(guard).toMatch(/choosePerfOffer\(\{/);
        expect(guard).toMatch(/setIncomingVideoMode\(fx\.incomingMode\)/);
    });
    it('process CPU comes from main through one read-only IPC', () => {
        expect(mainTs).toMatch(/ipcMain\.handle\('perf:get-process-cpu'/);
        expect(preload).toMatch(/getProcessCpu: \(\): Promise<unknown> =>\s*ipcRenderer\.invoke\('perf:get-process-cpu'\)/);
    });
    it('tiles apply the mode; the sidebar and fullscreen apply the decode cap', () => {
        expect(tile).toMatch(/mode: incomingMode,/);
        expect(tile).toMatch(/setVideoFPS\(incomingMode === 'datasaver' \? DATASAVER_SHARE_FPS : 0\)/);
        expect(sidebar).toMatch(/chooseDecodedSet\(\{/);
        expect(sidebar).toMatch(/budgetHiddenVideoIds=\{budgetHiddenVideoIds\}/);
        expect(fullscreen).toMatch(/!budgetHiddenVideoIds\?\.has\(p\.identity\)/);
    });
    it('Voice & Video has Incoming video quality', () => {
        expect(vv).toMatch(/<b>Incoming video quality<\/b>/);
        expect(vv).toMatch(/onChange=\{setIncomingVideoMode\}/);
    });
});

describe('bandwidth round: 1:1 layering, H.265 negotiation, lighter share copy, call log', () => {
    const shareTs = readFileSync(join(here, '..', '..', 'utils', 'screenShare.ts'), 'utf8');
    const monitor = read('components/call/CallEventMonitor.tsx');
    const hud = read('components/call/StreamStatsHud.tsx');
    const auth = read('contexts/AuthContext.tsx');
    it('one loop drives layering and the H.265 negotiation, with make-before-break republishes', () => {
        expect(sidebar).toMatch(/new CameraLayeringPolicy\(mode, now\)/);
        expect(sidebar).toMatch(/hevc\.observe\(roomHevcState\(remotes\), allowed, now\)/);
        expect(sidebar).toMatch(/republishCamera\(asCameraParticipant\(lp\)/);
        expect(sidebar).toMatch(/swapShareCodec\(lp as unknown as ShareParticipantLike/);
        expect(sidebar).toMatch(/lp\.setAttributes\(\{ \[HEVC_ATTR\]: formatDecodeCaps\(\{ h265 \}\) \}\)/);
        expect(sidebar).toMatch(/single: initialLayering\(remoteParticipants\.length\) === 'single'/);
    });
    it('the share uses H.265 only through the negotiation, and the lighter copy only when asked + hardware', () => {
        expect(sidebar).toMatch(/const hevcShare = hevcModeRef\.current === 'h265' && hevcEncodeRef\.current && !hasHevcFailed\(\);/);
        expect(sidebar).toMatch(/const lowerLayer = getShareLowLayerEnabled\(\) && shareHw;/);
        expect(sidebar).toMatch(/installShareLowLayerControl\(track, \{/);
    });
    it('content hint stays motion everywhere (owner: Text & detail made game streaming laggy)', () => {
        expect(sidebar).not.toMatch(/contentHint\s*=\s*'detail'|contentHint: 'detail'|'text'/);
        expect(sidebar.match(/contentHint = 'motion'|contentHint: 'motion'/g)!.length).toBeGreaterThanOrEqual(4);
        expect(shareTs).toMatch(/params\.degradationPreference = 'maintain-framerate';/);
    });
    it('call log: monitor mounted, overlay section, cleared on sign-out', () => {
        expect(pane).toMatch(/<CallEventMonitor \/>/);
        expect(monitor).toMatch(/markCallStart\(\)/);
        expect(hud).toMatch(/<CallLogSection \/>/);
        expect(hud).toMatch(/Copy call log/);
        expect(auth).toMatch(/clearCallEvents\(\); \/\/ the in-memory call event log never outlives a session/);
    });
    it('Advanced has the H.265 switch and the lighter-copy switch', () => {
        expect(adv).toMatch(/<b>Allow H\.265 when everyone supports it<\/b>/);
        expect(adv).toMatch(/<b>Lighter copy for viewers \(saves bandwidth\)<\/b>/);
        expect(adv).toMatch(/value: 'h265', title: 'H\.265'/);
    });
});
