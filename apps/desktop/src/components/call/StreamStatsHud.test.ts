// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalVideoTrack, RemoteVideoTrack, TrackPublication } from 'livekit-client';
import { StreamStatsHud } from './StreamStatsHud';
import { setScreenShareSession } from '../../utils/screenShareDiagnostics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Render check for the overlay the owner verifies 90 fps with: given a real-
// shaped stats report, the numbers that locate a shortfall are on screen —
// capture vs encoded fps against the sender's own maxFramerate, the encoder
// and whether it is hardware, the degradation mode and the SFU-recorded
// encryption.

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

async function render(el: React.ReactElement): Promise<string> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(el); });
    // Let the first poll's getRTCStatsReport() promise settle.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return host.textContent ?? '';
}

const report = (entries: Record<string, unknown>[]) => new Map(entries.map(e => [e.id as string, e]));

describe('StreamStatsHud', () => {
    it('shows the sender pipeline for your own share', async () => {
        const track = {
            getRTCStatsReport: async () => report([
                { id: 'O', type: 'outbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 90, frameWidth: 2560, frameHeight: 1440,
                  encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: true,
                  qualityLimitationReason: 'none', keyFramesEncoded: 2, qualityLimitationResolutionChanges: 0, bytesSent: 1, framesEncoded: 1, totalEncodeTime: 0 },
                { id: 'M', type: 'media-source', kind: 'video', framesPerSecond: 90, width: 2560, height: 1440 },
                { id: 'C', type: 'codec', mimeType: 'video/H264' },
            ]),
            sender: {
                getParameters: () => ({
                    encodings: [{ maxFramerate: 90, maxBitrate: 54_000_000 }],
                    degradationPreference: 'maintain-framerate',
                }),
            },
        } as unknown as LocalVideoTrack;
        const pub = { trackInfo: { encryption: 1 } } as unknown as TrackPublication;
        const text = await render(React.createElement(StreamStatsHud, { track, isLocal: true, publication: pub }));
        expect(text).toContain('capture90 fps 2560×1440');
        expect(text).toContain('encoded90 fps / 90 2560×1440');
        expect(text).toContain('H264');
        expect(text).toContain('HW');
        expect(text).toContain('MediaFoundationVideoEncodeAccelerator');
        expect(text).toContain('cap 54');
        expect(text).toContain('maintain-framerate');
        expect(text).toContain('e2ee GCM');
    });

    it('shows the receiver side for someone else’s share, and flags an unencrypted track', async () => {
        const track = {
            getRTCStatsReport: async () => report([
                { id: 'I', type: 'inbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 88, frameWidth: 2560, frameHeight: 1440,
                  decoderImplementation: 'libvpx', framesDropped: 4, freezeCount: 0, bytesReceived: 1 },
                { id: 'C', type: 'codec', mimeType: 'video/VP8' },
            ]),
        } as unknown as RemoteVideoTrack;
        const pub = { trackInfo: { encryption: 0 } } as unknown as TrackPublication;
        const text = await render(React.createElement(StreamStatsHud, { track, isLocal: false, publication: pub }));
        expect(text).toContain('received88 fps 2560×1440');
        expect(text).toContain('VP8');
        expect(text).toContain('SW');
        expect(text).toContain('total 4');
        expect(text).toContain('e2ee OFF');
    });

    it('stays up (placeholder) when stats are not available yet', async () => {
        const track = { getRTCStatsReport: async () => undefined } as unknown as RemoteVideoTrack;
        const text = await render(React.createElement(StreamStatsHud, { track, isLocal: false }));
        expect(text).toContain('stats…');
    });

    it('a paced H.264 High share: target vs capture ask, guessed Hz, and the bandwidth ramp named separately', async () => {
        setScreenShareSession({
            sourceId: 'screen:1:0', requestedFps: 90, captureFps: 113, codecPref: 'auto', codec: 'h264', h264Profile: 'high',
            codecReason: 'auto: HW H.264 High (CB not HW)', hw: { h264: false, vp9: false, vp8: false, h264High: true },
            main: {
                platform: 'win32', windowsBuild: 26200, sourceKind: 'screen', displayHz: 200, displayHzSource: 'primary',
                capturer: { backend: 'dxgi', why: 'auto: DXGI (grabs ~2.7× faster than WGC)' }, capturerPref: 'auto',
                gpus: [], videoEncode: 'enabled', h264CbpHwEnabled: true, captureLog: false,
            },
            startedAt: performance.now(),
        });
        const track = {
            mediaStreamTrack: { getSettings: () => ({ frameRate: 113 }) },
            getRTCStatsReport: async () => report([
                { id: 'O', type: 'outbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 90, frameWidth: 1280, frameHeight: 720,
                  encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: true,
                  qualityLimitationReason: 'bandwidth', keyFramesEncoded: 2, bytesSent: 1, framesEncoded: 1, totalEncodeTime: 0 },
                { id: 'M', type: 'media-source', kind: 'video', framesPerSecond: 90, width: 2560, height: 1440 },
                { id: 'C', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f' },
                { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
                { id: 'P', type: 'candidate-pair', availableOutgoingBitrate: 2_900_000, currentRoundTripTime: 0.025 },
            ]),
            sender: { getParameters: () => ({ encodings: [{ maxFramerate: 90, maxBitrate: 68_000_000 }], degradationPreference: 'maintain-framerate' }) },
        } as unknown as LocalVideoTrack;
        const pub = { source: 'screen_share', trackInfo: { encryption: 1 } } as unknown as TrackPublication;
        try {
            const text = await render(React.createElement(StreamStatsHud, { track, isLocal: true, publication: pub }));
            expect(text).toContain('capture90 fps / req 90 (asks 113) 2560×1440');
            expect(text).toContain('screen · ≈200 Hz · DXGI');
            expect(text).toContain('H264 High');
            expect(text).toContain('encoded90 fps / 90 1280×720');
            expect(text).toMatch(/bwlink 2\.9 Mbps, still ramping \(0s in\) — sending 1280×720 to fit/);
            expect(text).toContain('limitednothing limiting'); // frame rate is fine; the link costs resolution
        } finally {
            setScreenShareSession(null);
        }
    });
});
