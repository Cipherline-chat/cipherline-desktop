/**
 * The report builder against PLANTED identities: every input a real report is
 * built from carries usernames, display names, emails, server / channel /
 * conversation names, home paths with spaces, UUIDs, LiveKit SIDs, device
 * labels and file names — and the serialized body must contain none of them.
 */
import { describe, it, expect } from 'vitest';
import {
    buildDiagnosticReport, CATEGORY_SPEC, describeCollection, maxScreenShareFps, fitPayload,
    reportFileText, isValidReplyEmail, type BundleInput,
} from './bundle';
import { WebrtcRing } from './webrtcRing';
import { buildSettingsSnapshot } from './settingsSnapshot';
import { DIAGNOSTIC_CATEGORIES, DIAGNOSTIC_LIMITS, type DiagnosticCategory, type SystemInfo } from './reportTypes';
import type { StatsEntry } from '../streamStatsHud';

const NOW = Date.UTC(2026, 9, 7, 18, 22, 41);

// ── Planted identities ───────────────────────────────────────────────────────
const ME = { username: 'dawson_kraai', display: 'Dawson Kraai', email: 'dawson.kraai@gmail.com' };
const FRIENDS = ['nightowl42', 'Mira Okafor'];
const SERVER = 'Pixel Pirates';
const CHANNEL = 'secret-raid-planning';
const GROUP = 'Saturday Squad';
const OS_USER = 'dawsonk';
const HOME_WIN = 'C:\\Users\\Dawson Kraai';
const HOME_POSIX = '/home/dawson kraai';
const UUID = '3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b';
const SID_P = 'PA_8fKq2LmZx9Qw';
const SID_T = 'TR_AbCdEf12345x';
const DEVICE_LABEL = 'Dawson’s AirPods Pro';
const FILE = 'tax return 2025.pdf';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

const PLANTED = [
    ME.username, ME.display, ME.email, ...FRIENDS, SERVER, CHANNEL, GROUP, OS_USER,
    'Dawson Kraai', 'dawson kraai', UUID, SID_P, SID_T, 'AirPods', 'tax return', '2025.pdf', TOKEN.slice(0, 20),
];
const TERMS = [ME.username, ME.display, ME.email, ...FRIENDS, SERVER, CHANNEL, GROUP, OS_USER];

function expectClean(value: unknown): void {
    const s = JSON.stringify(value).toLowerCase();
    for (const p of PLANTED) expect(s, `leaked "${p}"`).not.toContain(p.toLowerCase());
}

const SYSTEM: SystemInfo = {
    app_version: '1.0.17', build_commit: '34f51243', channel: 'stable', electron: '43.2.0', chrome: '140.0.7339.133', node: '22.19.0',
    platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', cpu_cores: 12, ram_gb: 15.9,
    gpu: { devices: [{ vendor_id: '0x8086', device_id: '0x3e92', active: true, driver_vendor: 'Intel', driver_version: '31.0.101.2125' }], feature_status: { gpu_compositing: 'enabled', video_encode: 'disabled_software' } },
    displays: [{ width: 2560, height: 1440, scale_factor: 1, refresh_hz: 144, primary: true }],
    hardware_acceleration: true, uptime_s: 5412,
};

// A screen-share call whose raw stats are full of SIDs.
function fakeSenderReport(i: number, sid: string): StatsEntry[] {
    return [
        { id: `RTCOutboundRTPVideoStream_${sid}_1`, type: 'outbound-rtp', kind: 'video', trackIdentifier: sid, mid: sid, ssrc: 1234,
          frameWidth: 2560, frameHeight: 1440, framesPerSecond: 61, framesSent: 61 * 5 * i, framesEncoded: 61 * 5 * i, bytesSent: 7_000_000 * i,
          totalEncodeTime: i, encoderImplementation: 'OpenH264', powerEfficientEncoder: false, qualityLimitationReason: 'cpu',
          qualityLimitationDurations: { cpu: 4.2 * i, bandwidth: 0, other: 0, none: 0.8 * i }, targetBitrate: 24_000_000, nackCount: i, pliCount: 1,
          codecId: `RTCCodec_${sid}` },
        { id: `RTCCodec_${sid}`, type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
        { id: `RTCMediaSourceStats_${sid}`, type: 'media-source', kind: 'video', framesPerSecond: 88.6, width: 2560, height: 1440, trackIdentifier: sid },
        { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP_1' },
        { id: 'CP_1', type: 'candidate-pair', currentRoundTripTime: 0.038, availableOutgoingBitrate: 42_000_000, localCandidateId: '192.168.1.20', remoteCandidateId: '203.0.113.9' },
    ];
}
function fakeRemoteAudio(i: number, sid: string): StatsEntry[] {
    return [
        { id: `RTCInboundRTPAudioStream_${sid}`, type: 'inbound-rtp', kind: 'audio', trackIdentifier: sid, bytesReceived: 20_000 * i, packetsLost: i, packetsReceived: 500 * i, jitter: 0.0041, codecId: 'C2' },
        { id: 'C2', type: 'codec', mimeType: 'audio/opus' },
    ];
}

function recordedRing(): WebrtcRing {
    const ring = new WebrtcRing();
    ring.beginCall();
    ring.setCapture({ kind: 'screen', requestedFps: 90, requestedResolution: '1440p', codecPref: 'auto' });
    const screen = {}; const remote = {};
    for (let i = 1; i <= 6; i++) {
        ring.record(NOW - (7 - i) * 5000, [
            { ref: screen, direction: 'outbound', kind: 'video', source: 'screen_share', report: fakeSenderReport(i, SID_T), targetFps: 90 },
            { ref: remote, direction: 'inbound', kind: 'audio', report: fakeRemoteAudio(i, SID_P) },
        ]);
    }
    return ring;
}

function input(category: DiagnosticCategory, over: Partial<BundleInput> = {}): BundleInput {
    return {
        category, trigger: 'manual', now: NOW,
        description: `Hi, I'm ${ME.display} (${ME.email}). In ${SERVER} #${CHANNEL} with @nightowl42 my share drops; see ${HOME_WIN}\\Desktop\\${FILE} and https://evil.example.com/x?token=abc`,
        replyEmail: 'reply-to@example.org',
        system: SYSTEM,
        settings: buildSettingsSnapshot({
            hardwareAcceleration: true,
            voice: { noiseSuppression: true, micDeviceId: 'a8f3c0e1d2b4', micVolume: 100 },
            devices: [{ kind: 'audioinput', deviceId: 'x', label: DEVICE_LABEL } as never, { kind: 'audiooutput' }, { kind: 'videoinput' }],
            notifications: { desktop_notifications_enabled: true, keywords: [ME.username, 'raid'], custom_sounds: [{ name: 'x', file: `${HOME_POSIX}/${FILE}` }], show_preview: 'full' },
            notificationPermission: 'granted',
            screenShareCodecPref: 'auto',
            shareSession: { requestedFps: 90, captureFps: 113, resolution: '1440p', codec: 'h264', main: { sourceKind: 'window', displayHz: 144, capturer: { backend: 'wgc' }, videoEncode: 'enabled' } },
            startupFlags: { active: { screenCapturer: 'auto', captureLog: false } },
        }),
        entitlement: { isPaid: true, canPublishVideo: true, maxUploadBytes: 2 * 1024 ** 3 },
        perfLog: [
            { at: NOW - 60_000, source: 'renderer', ms: 412, activity: 'screenshare:start, view:server' },
            { at: NOW - 12_900, source: 'main', ms: 230, activity: 'idle' },
            { at: NOW - 30_000, source: 'event', ms: 0, activity: 'process:gone type=GPU reason=crashed exit=1' },
        ],
        webrtc: recordedRing().summary(NOW),
        callEvents: [
            { t: NOW - 50_000, kind: 'join', detail: { participants: 3, room: `${SERVER} / ${CHANNEL}`, who: ME.display } },
            { t: NOW - 49_000, kind: 'ice_selected', detail: { type: 'relay', protocol: 'udp', turn: true, peer: `${FRIENDS[0]}@${UUID}` } },
            { t: NOW - 44_000, kind: 'codec_fallback', detail: { track: 'self-camera', from: 'H264', to: 'VP8', reason: `encoder ${SID_T} failed for ${FRIENDS[1]}` } },
            { t: NOW - 20_000, kind: 'freeze', detail: { track: 'remote-video-1', ms: 840, note: `${HOME_WIN}\\${FILE}` } },
        ],
        crash: {
            kind: 'renderer_exception', process_type: 'renderer', error_name: 'TypeError',
            message: `Cannot read properties of undefined (reading 'name') for ${GROUP} / ${UUID} / ${SID_P}`,
            stack: `TypeError: x\n    at render (${HOME_WIN}\\AppData\\Local\\Programs\\cipherline\\resources\\app.asar\\dist\\assets\\index-AbC12x9Z.js:1:2)\n    at ${HOME_POSIX}/x/${FILE}:3:4`,
            occurred_at: '2026-10-07T18:20:00.000Z', app_version_at_crash: '1.0.17',
        },
        recentErrors: [
            { at: NOW - 5000, kind: 'unhandledrejection', name: 'Error', message: `fetch failed for ${ME.username} Bearer ${TOKEN}`, stack: `Error\n    at ${HOME_POSIX}/app.js:1:1` },
            { at: NOW - 3000, kind: 'error', message: `Mira Okafor left ${CHANNEL} (${SID_T})` },
        ],
        scrub: { sensitiveTerms: TERMS, homeDir: HOME_WIN },
        ...over,
    };
}

describe('buildDiagnosticReport — planted identities never leak', () => {
    for (const category of DIAGNOSTIC_CATEGORIES) {
        it(`${category}: JSON.stringify(body) contains none of the planted identities`, () => {
            const { body } = buildDiagnosticReport(input(category));
            const { reply_email: _reply, ...rest } = body;
            expect(_reply).toBe('reply-to@example.org');
            expectClean(rest);
            // and the reply address the user typed is never inside the payload
            expect(JSON.stringify(body.payload)).not.toContain('reply-to@example.org');
        });
    }

    it('the description is scrubbed but still readable', () => {
        const { body } = buildDiagnosticReport(input('screen_share'));
        expect(body.description).toContain('my share drops');
        expect(body.description).toContain('<name>');
        expect(body.description).toContain('<email>');
        expect(body.description).not.toContain('evil.example.com');
    });

    it('device labels, keywords and custom sound paths become counts', () => {
        const { body } = buildDiagnosticReport(input('notifications'));
        expect(body.payload.settings.keyword_count).toBe(2);
        expect(body.payload.settings.custom_sound_count).toBe(1);
        const call = buildDiagnosticReport(input('call_audio')).body.payload.settings;
        expect(call.audio_input_devices).toBe(1);
        expect(call.mic_device).toBe('selected');
    });

    it('WebRTC tracks are placeholders; no SID, candidate address or ssrc survives', () => {
        const { body } = buildDiagnosticReport(input('screen_share'));
        const w = body.payload.webrtc!;
        expect(w.samples.length).toBe(6);
        expect(w.samples[0].outbound[0].track).toBe('screen-1');
        expect(w.samples[0].inbound[0].track).toBe('remote-audio-1');
        const s = JSON.stringify(w);
        for (const bad of [SID_P, SID_T, '192.168.1.20', '203.0.113.9', 'ssrc', 'trackIdentifier', 'mid']) expect(s).not.toContain(bad);
        expect(w.capture).toMatchObject({ kind: 'screen', requested_fps: 90, requested_resolution: '1440p', capture_fps: 88.6, codec_pref: 'auto' });
        const last = w.samples[w.samples.length - 1];
        expect(last.outbound[0]).toMatchObject({ codec: 'H264', encoder: 'OpenH264', hardware: false, target_fps: 90, quality_limitation_reason: 'cpu' });
        expect(last.t_s).toBeLessThanOrEqual(0);
    });

    it('a friend called "video" and a server called "Intel" do not corrupt the report', () => {
        const { body } = buildDiagnosticReport(input('screen_share', { scrub: { sensitiveTerms: [...TERMS, 'video', 'Intel', 'auto', 'enabled'], homeDir: HOME_WIN } }));
        expect(body.payload.system.gpu.devices[0].driver_vendor).toBe('Intel');
        expect(body.payload.webrtc!.samples[0].outbound[0].kind).toBe('video');
        expect(body.payload.settings.screen_share_codec).toBe('auto');
        expect(body.payload.system.gpu.feature_status.gpu_compositing).toBe('enabled');
        expectClean(body.payload);
    });
});

describe('category matrix', () => {
    const sections = (c: DiagnosticCategory) => Object.keys(buildDiagnosticReport(input(c)).body.payload).sort();
    it('every category has system, settings and perf_log', () => {
        for (const c of DIAGNOSTIC_CATEGORIES) expect(sections(c)).toEqual(expect.arrayContaining(['generated_at', 'trigger', 'system', 'settings', 'perf_log']));
    });
    it('call categories add entitlement + webrtc + call_events, nothing crash-related', () => {
        for (const c of ['screen_share', 'call_audio', 'video_camera'] as const) {
            expect(sections(c)).toEqual(['call_events', 'entitlement', 'generated_at', 'perf_log', 'settings', 'system', 'trigger', 'webrtc']);
        }
    });
    it('crash adds crash + recent_errors', () => {
        expect(sections('crash')).toEqual(['crash', 'generated_at', 'perf_log', 'recent_errors', 'settings', 'system', 'trigger']);
    });
    it('performance adds recent_errors and the long perf log', () => {
        expect(sections('performance')).toEqual(['call_events', 'generated_at', 'perf_log', 'recent_errors', 'settings', 'system', 'trigger']);
        expect(CATEGORY_SPEC.performance.perfRows).toBe(DIAGNOSTIC_LIMITS.maxPerfRows);
    });
    it('notifications / other: only the basics', () => {
        expect(sections('notifications')).toEqual(['generated_at', 'perf_log', 'settings', 'system', 'trigger']);
        expect(sections('other')).toEqual(['generated_at', 'perf_log', 'settings', 'system', 'trigger']);
    });
    it('settings are scoped to the category', () => {
        const ss = buildDiagnosticReport(input('screen_share')).body.payload.settings;
        expect(ss.screen_share_fps).toBe(90);
        expect(ss.capture_backend).toBe('wgc');
        expect(ss.noise_suppression).toBe(true);
        expect(ss).not.toHaveProperty('desktop_notifications');
        const n = buildDiagnosticReport(input('notifications')).body.payload.settings;
        expect(n.desktop_notifications).toBe(true);
        expect(n).not.toHaveProperty('screen_share_fps');
        const o = buildDiagnosticReport(input('other')).body.payload.settings;
        expect(Object.keys(o).sort()).toEqual(['hardware_acceleration']);
    });
    it('a crash report without a pending crash simply has no crash section', () => {
        expect(buildDiagnosticReport(input('crash', { crash: null })).body.payload).not.toHaveProperty('crash');
    });
    it('a call category with no call yet still says so', () => {
        expect(buildDiagnosticReport(input('call_audio', { webrtc: null })).body.payload.webrtc).toEqual({ call_active: false, samples: [] });
    });
    it('every category has a "What\'s collected" list', () => {
        for (const c of DIAGNOSTIC_CATEGORIES) expect(describeCollection(c).length).toBeGreaterThanOrEqual(3);
    });
});

describe('entitlement — 90 fps ceiling', () => {
    it('paid / trial (canPublishVideo) → 90; free → 0 (no screen share at all)', () => {
        expect(maxScreenShareFps(true)).toBe(90);
        expect(maxScreenShareFps(false)).toBe(0);
        const free = buildDiagnosticReport(input('screen_share', { entitlement: { isPaid: false, canPublishVideo: false, maxUploadBytes: 100 * 1024 * 1024 } }));
        expect(free.body.payload.entitlement).toEqual({ is_paid: false, can_publish_video: false, max_screen_share_fps: 0, max_upload_mb: 100 });
    });
});

describe('limits and truncation', () => {
    it('perf rows: newest kept, oldest dropped, t_s relative and ascending', () => {
        const perfLog = Array.from({ length: 1000 }, (_, i) => ({ at: NOW - (1000 - i) * 1000, source: 'renderer' as const, ms: 200 + i, activity: 'x' }));
        const { body } = buildDiagnosticReport(input('performance', { perfLog }));
        expect(body.payload.perf_log!.total_rows).toBe(1000);
        expect(body.payload.perf_log!.rows).toHaveLength(DIAGNOSTIC_LIMITS.maxPerfRows);
        expect(body.payload.perf_log!.rows.at(-1)).toMatchObject({ t_s: -1, ms: 1199 });
        const ts = body.payload.perf_log!.rows.map(r => r.t_s);
        expect([...ts].sort((a, b) => a - b)).toEqual(ts);
        expect(buildDiagnosticReport(input('other', { perfLog })).body.payload.perf_log!.rows).toHaveLength(60);
    });

    it('recent errors capped at maxRecentErrors', () => {
        const recentErrors = Array.from({ length: 50 }, (_, i) => ({ at: NOW - 50_000 + i, kind: 'error' as const, message: `e${i}` }));
        const errs = buildDiagnosticReport(input('crash', { recentErrors })).body.payload.recent_errors!;
        expect(errs).toHaveLength(DIAGNOSTIC_LIMITS.maxRecentErrors);
        expect(errs.at(-1)!.message).toBe('e49');
    });

    it('a huge report is trimmed to fit maxPayloadBytes, oldest first', () => {
        const big = 'at frame (app.asar/dist/assets/index.js:1:2) '.repeat(80);
        const recentErrors = Array.from({ length: 20 }, (_, i) => ({ at: NOW - 1000 + i, kind: 'error' as const, message: `boom ${i}`, stack: big }));
        const perfLog = Array.from({ length: 300 }, (_, i) => ({ at: NOW - 300_000 + i * 1000, source: 'metrics' as const, ms: 0, activity: `browser 1.2% 140MB | tab ${i}.0% 620MB | gpu 22.1% 310MB | utility(3) 0.4% 75MB | total 1100MB` }));
        const r = buildDiagnosticReport(input('crash', { recentErrors, perfLog, crash: { kind: 'renderer_exception', occurred_at: '2026-10-07T18:20:00.000Z', stack: big.repeat(3) } }));
        expect(r.payloadBytes).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxPayloadBytes);
        expect(r.bodyBytes).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxBodyBytes);
        // Small enough already? Then force a tiny limit to exercise the trimmer.
        const p = JSON.parse(JSON.stringify(r.body.payload));
        const trimmed = fitPayload(p, 6_000);
        expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThanOrEqual(6_000);
        expect(trimmed).toContain('perf_log');
        // newest perf rows survive
        if (p.perf_log.rows.length) expect(p.perf_log.rows.at(-1).activity).toContain('tab 299.0%');
    });

    it('description capped at maxDescriptionChars; invalid reply email dropped', () => {
        const r = buildDiagnosticReport(input('other', { description: 'x '.repeat(5000), replyEmail: 'not an email' }));
        expect(r.body.description!.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxDescriptionChars);
        expect(r.body).not.toHaveProperty('reply_email');
        expect(isValidReplyEmail('a@b.co')).toBe(true);
        expect(isValidReplyEmail('a@b')).toBe(false);
    });

    it('body header mirrors the scrubbed system block; file text is the same object', () => {
        const { body } = buildDiagnosticReport(input('screen_share'));
        expect(body).toMatchObject({ schema: 1, category: 'screen_share', app_version: '1.0.17', platform: 'win32', os_version: '10.0.22631' });
        expect(JSON.parse(reportFileText(body))).toEqual(body);
    });

    it('verbatim keys that do not match their pattern become <invalid>', () => {
        const { body } = buildDiagnosticReport(input('other', { system: { ...SYSTEM, build_commit: `dawson ${UUID}` } }));
        expect(body.payload.system.build_commit).toBe('<invalid>');
    });
});
