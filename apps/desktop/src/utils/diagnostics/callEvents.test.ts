/**
 * `call_events` — the call engine's decision log inside a diagnostic report:
 * which categories carry it, the last-300 cap, short-scalar `detail`, the
 * scrubber (and the structured-term exemption) applied to every string, the
 * injectable source shim, and the wire-contract constants.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportPreview } from '../../components/diagnostics/ReportPreview';
import { callEventDetailText, callEventLabel, callEventTone } from './callEventsView';
import { buildDiagnosticReport, shapeCallEvents, CATEGORY_SPEC, describeCollection, fitPayload, type BundleInput } from './bundle';
import { readCallEvents, setCallEventsSource, type CallEventInput } from './callEventsSource';
import { clearCallEvents, logCallEvent } from '../callEventLog';
import { avSyncSnapshotEvents } from '../avSyncMonitor';
import { createScrubber, scrubDeep, DEFAULT_DEEP_LIMITS } from './scrub';
import {
    DIAGNOSTIC_CATEGORIES, DIAGNOSTIC_LIMITS, DIAGNOSTIC_VERBATIM_KEYS,
    type DiagnosticCategory, type SystemInfo,
} from './reportTypes';

const NOW = Date.UTC(2026, 9, 7, 18, 22, 41);

const SYSTEM: SystemInfo = {
    app_version: '1.0.17', build_commit: '34f51243', channel: 'stable', electron: '43.2.0', chrome: '140.0.7339.133', node: '22.19.0',
    platform: 'win32', os_version: '10.0.22631', arch: 'x64', cpu_model: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', cpu_cores: 12, ram_gb: 15.9,
    gpu: { devices: [], feature_status: {} }, displays: [], hardware_acceleration: true, uptime_s: 100,
};

const base = (category: DiagnosticCategory, over: Partial<BundleInput> = {}): BundleInput => ({
    category, trigger: 'manual', now: NOW, system: SYSTEM, settings: {}, scrub: { sensitiveTerms: [] }, ...over,
});

const ev = (secAgo: number, kind: string, detail?: CallEventInput['detail']): CallEventInput => ({ t: NOW - secAgo * 1000, kind, ...(detail ? { detail } : {}) });

afterEach(() => setCallEventsSource(null));

describe('which categories carry call_events', () => {
    it('screen_share, call_audio, video_camera and performance — and only those', () => {
        for (const c of DIAGNOSTIC_CATEGORIES) {
            const want = ['screen_share', 'call_audio', 'video_camera', 'performance'].includes(c);
            expect(CATEGORY_SPEC[c].callEvents, c).toBe(want);
            const p = buildDiagnosticReport(base(c, { callEvents: [ev(5, 'join')] })).body.payload;
            if (want) expect(p.call_events, c).toEqual([{ t_s: -5, event: 'join' }]);
            else expect(p, c).not.toHaveProperty('call_events');
        }
    });
    it('an empty log is an empty array (the section is present, so the preview can say "none")', () => {
        expect(buildDiagnosticReport(base('screen_share')).body.payload.call_events).toEqual([]);
    });
    it('the "What\'s collected" list mentions it for call categories only', () => {
        expect(describeCollection('screen_share').join('\n')).toMatch(/call events/);
        expect(describeCollection('other').join('\n')).not.toMatch(/call events/);
    });
});

describe('cap, order and shape', () => {
    it('keeps the newest 300, oldest first, t_s relative to generated_at', () => {
        const many = Array.from({ length: 450 }, (_, i) => ({ t: NOW - (450 - i) * 1000, kind: 'freeze', detail: { n: i } }));
        const out = buildDiagnosticReport(base('screen_share', { callEvents: [...many].reverse() })).body.payload.call_events!;
        expect(out).toHaveLength(DIAGNOSTIC_LIMITS.maxCallEvents);
        expect(out[0]).toMatchObject({ t_s: -300, detail: { n: 150 } });
        expect(out.at(-1)).toMatchObject({ t_s: -1, detail: { n: 449 } });
        const ts = out.map(e => e.t_s);
        expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    });

    it('drops events with a bad name or time; never throws on junk', () => {
        const junk = [
            ev(1, 'Bad Name'), ev(2, 'has-dash'), ev(3, ''), ev(4, 'x'.repeat(41)), ev(5, 'ok_event'),
            { t: Number.NaN, kind: 'join' }, { t: 'now' as never, kind: 'join' }, null as never, undefined as never, 5 as never,
        ];
        expect(shapeCallEvents(junk, NOW).map(e => e.event)).toEqual(['ok_event']);
        expect(shapeCallEvents(undefined, NOW)).toEqual([]);
    });

    it('detail keeps ONLY short scalars under identifier keys', () => {
        const out = shapeCallEvents([ev(1, 'codec_decision', {
            ok_str: 'H264', ok_num: 1.23456, ok_bool: false,
            too_long: 'x'.repeat(DIAGNOSTIC_LIMITS.maxCallEventDetailChars + 1),
            empty: '', obj: { a: 1 } as never, arr: [1, 2] as never, nul: null as never, nan: Number.NaN, inf: Infinity,
            'Bad Key': 'x', 'has-dash': 'x', UPPER: 'x', fn: (() => 1) as never,
        })], NOW);
        expect(out[0].detail).toEqual({ ok_str: 'H264', ok_num: 1.235, ok_bool: false });
    });

    it('detail is capped at maxCallEventDetailKeys, and omitted when nothing survives', () => {
        const detail = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
        const out = shapeCallEvents([ev(1, 'a', detail), ev(2, 'b', { obj: {} as never }), ev(3, 'c', [1] as never)], NOW);
        expect(Object.keys(out.find(e => e.event === 'a')!.detail!)).toHaveLength(DIAGNOSTIC_LIMITS.maxCallEventDetailKeys);
        expect(out.find(e => e.event === 'b')).not.toHaveProperty('detail');
        expect(out.find(e => e.event === 'c')).not.toHaveProperty('detail');
    });

    it('a size-limit trim drops the OLDEST call events first (down to 60) and reports it', () => {
        const p = {
            generated_at: '', trigger: 'manual', system: SYSTEM, settings: {},
            call_events: Array.from({ length: 300 }, (_, i) => ({ t_s: -300 + i, event: 'freeze', detail: { note: 'x'.repeat(40), i } })),
        } as never;
        const trimmed = fitPayload(p, 9_000);
        const left = (p as { call_events: Array<{ detail: { i: number } }> }).call_events;
        expect(trimmed).toContain('call_events');
        expect(left.length).toBeLessThan(300);
        expect(left.at(-1)!.detail.i).toBe(299);
    });
});

describe('scrubbing', () => {
    const TERMS = ['Mira Okafor', 'nightowl42', 'Pixel Pirates'];

    it('identifying strings planted in detail never survive', () => {
        const { body } = buildDiagnosticReport(base('screen_share', {
            scrub: { sensitiveTerms: TERMS, homeDir: 'C:\\Users\\Dawson Kraai' },
            callEvents: [ev(9, 'join', {
                who: 'Mira Okafor', room: 'Pixel Pirates', mail: 'mira@example.org', url: 'https://evil.example.com/x?token=abc',
                path: 'C:\\Users\\Dawson Kraai\\Desktop\\tax return.pdf', sid: 'PA_8fKq2LmZx9Qw', uid: '3f9a12bc-1d2e-4f50-8a6b-9c0d1e2f3a4b', ip: '203.0.113.9',
            })],
        }));
        const s = JSON.stringify(body.payload.call_events);
        for (const leak of ['Mira', 'Okafor', 'Pixel', 'mira@', 'evil.example', 'abc', 'Dawson', 'tax return', 'PA_8f', '3f9a12bc', '203.0.113.9']) {
            expect(s, `leaked ${leak}`).not.toContain(leak);
        }
        expect(body.payload.call_events![0].detail).toMatchObject({ who: '<name>', room: '<name>', mail: '<email>' });
    });

    it('a sensitive term equal to plain vocabulary does not wreck the log (a friend called "relay")', () => {
        const { body } = buildDiagnosticReport(base('screen_share', {
            scrub: { sensitiveTerms: ['relay', 'ice_selected', 'H264'] },
            callEvents: [ev(3, 'ice_selected', { type: 'relay', codec: 'H264', quality_limitation_reason: 'none' })],
        }));
        expect(body.payload.call_events![0]).toMatchObject({ event: 'ice_selected', detail: { type: 'relay', codec: 'H264', quality_limitation_reason: 'none' } });
    });

    it('…but a producer-supplied non-vocabulary string does NOT exempt a term', () => {
        const { body } = buildDiagnosticReport(base('screen_share', {
            scrub: { sensitiveTerms: ['nightowl42'] },
            callEvents: [ev(3, 'join', { peer: 'nightowl42' }), ev(2, 'leave', { note: 'nightowl42' })],
        }));
        expect(JSON.stringify(body.payload)).not.toContain('nightowl42');
    });

    it('track placeholders pass; a SID-shaped or identity track becomes <invalid>', () => {
        const { body } = buildDiagnosticReport(base('video_camera', {
            callEvents: [
                ev(5, 'codec_fallback', { track: 'self-camera' }), ev(4, 'freeze', { track: 'remote-video-1' }),
                ev(3, 'freeze', { track: 'TR_AbCdEf12345x' }), ev(2, 'freeze', { track: 'Mira' }),
            ],
        }));
        expect(body.payload.call_events!.map(e => e.detail!.track)).toEqual(['self-camera', 'remote-video-1', '<invalid>', '<invalid>']);
    });

    it('a call-event log scrubbed again (API-style) is unchanged: scrubDeep is idempotent on it', () => {
        const { body } = buildDiagnosticReport(base('screen_share', {
            callEvents: [ev(5, 'ice_selected', { type: 'relay', protocol: 'udp', turn: true }), ev(4, 'codec_fallback', { from: 'H264', to: 'VP8', track: 'self-camera' }),
                ev(3, 'h265_negotiation', { result: 'unsupported', codec: 'video/H265' }), ev(2, 'av_sync', { offset_ms: -42.5 })],
        }));
        const again = scrubDeep(body.payload.call_events, createScrubber(), DEFAULT_DEEP_LIMITS, DIAGNOSTIC_VERBATIM_KEYS);
        expect(again).toEqual(body.payload.call_events);
        expect(JSON.stringify(again)).not.toContain('<');
    });
});

describe('A/V sync in the call bundle (av_sync_estimate + av_sync_* call events)', () => {
    it('survives the builder and the scrubber unchanged — scalars, placeholders, snake_case', () => {
        const entries = [
            { slot: 'remote-av-1', source: 'camera' as const, path: 'element' as const, offsetMs: 40, uncertaintyMs: 12, audioPathMs: 140, videoPathMs: 100, verdict: 'ok' as const, at: NOW - 2000 },
            { slot: 'remote-av-2', source: 'screen_share' as const, path: 'webaudio' as const, offsetMs: 210, uncertaintyMs: 30, audioPathMs: 330, videoPathMs: 120, verdict: 'audio-late' as const, at: NOW - 1000 },
        ];
        const callEvents: CallEventInput[] = [
            ev(9, 'av_sync_playback_path', { slot: 'remote-av-1', chain: 'mic', path: 'webaudio', reason: 'volume-or-ns', web_audio_extra_ms: 46 }),
            ev(8, 'av_sync_ss_audio_trim', { dropped_ms: 120, trims: 1 }),
            ...avSyncSnapshotEvents(entries),
        ];
        const { body } = buildDiagnosticReport(base('call_audio', { callEvents, scrub: { sensitiveTerms: ['Mira Okafor', 'nightowl42'] } }));
        const out = body.payload.call_events!;
        expect(out.map(e => e.event)).toEqual(['av_sync_playback_path', 'av_sync_ss_audio_trim', 'av_sync_estimate', 'av_sync_estimate']);
        expect(out[3].detail).toEqual({
            slot: 'remote-av-2', stream: 'screen_share', path: 'webaudio', verdict: 'audio-late',
            offset_ms: 210, uncertainty_ms: 30, audio_path_ms: 330, video_path_ms: 120,
        });
        expect(out[0].detail).toEqual({ slot: 'remote-av-1', chain: 'mic', path: 'webaudio', reason: 'volume-or-ns', web_audio_extra_ms: 46 });
        expect(JSON.stringify(out)).not.toContain('<');
        // and an API-style re-scrub is a no-op
        expect(scrubDeep(out, createScrubber(), DEFAULT_DEEP_LIMITS, DIAGNOSTIC_VERBATIM_KEYS)).toEqual(out);
    });
});

describe('callEventsSource', () => {
    it('is wired to the call event log (utils/callEventLog.ts) by default', () => {
        clearCallEvents();
        expect(readCallEvents()).toEqual([]);
        logCallEvent('ice_route', { type: 'relay', turn: true });
        expect(readCallEvents()).toEqual([{ t: expect.any(Number), kind: 'ice_route', detail: { type: 'relay', turn: true } }]);
        clearCallEvents();
    });
    it('reads whatever the injected getter returns, as a copy', () => {
        const src = [ev(1, 'join')];
        setCallEventsSource(() => src);
        const out = readCallEvents();
        expect(out).toEqual(src);
        expect(out).not.toBe(src);
    });
    it('a throwing or non-array producer yields [] — a broken log must never block a report', () => {
        setCallEventsSource(() => { throw new Error('boom'); });
        expect(readCallEvents()).toEqual([]);
        setCallEventsSource((() => 'nope') as never);
        expect(readCallEvents()).toEqual([]);
    });
    it('setCallEventsSource(null) restores the call-event-log default', () => {
        clearCallEvents();
        setCallEventsSource(() => [ev(1, 'join')]);
        setCallEventsSource(null);
        expect(readCallEvents()).toEqual([]);
        logCallEvent('reconnecting');
        expect(readCallEvents().map(e => e.kind)).toEqual(['reconnecting']);
        clearCallEvents();
    });
});

describe('wire-contract constants', () => {
    it('limits and verbatim keys', () => {
        expect(DIAGNOSTIC_LIMITS.maxCallEvents).toBe(300);
        expect(DIAGNOSTIC_VERBATIM_KEYS.event.test('quality_limitation')).toBe(true);
        expect(DIAGNOSTIC_VERBATIM_KEYS.event.test('Quality')).toBe(false);
        expect(DIAGNOSTIC_VERBATIM_KEYS.event.test('has space')).toBe(false);
        expect(DIAGNOSTIC_VERBATIM_KEYS.track.test('self-screen-audio')).toBe(true);
        expect(DIAGNOSTIC_VERBATIM_KEYS.track.test('self-bob')).toBe(false);
    });
});

describe('report preview', () => {
    const render = (callEvents: CallEventInput[]) =>
        renderToStaticMarkup(React.createElement(ReportPreview, { body: buildDiagnosticReport(base('screen_share', { callEvents })).body, trimmed: [] }));

    it('renders a Call events table: when, event, details — newest first, with colour cues', () => {
        const html = render([
            ev(50, 'join', { participants: 2 }),
            ev(49, 'ice_selected', { type: 'relay', turn: true }),
            ev(30, 'codec_fallback', { track: 'self-camera', from: 'H264', to: 'VP8' }),
            ev(20, 'quality_limitation', { to: 'cpu' }),
            ev(9, 'freeze', { track: 'remote-video-1', ms: 840 }),
        ]);
        expect(html).toContain('aria-label="Call events"');
        expect(html).toContain('<th>When</th><th>Event</th><th>Details</th>');
        expect(html.indexOf('Freeze')).toBeLessThan(html.indexOf('Ice selected'));
        expect(html).toContain('type: relay · turn: yes');
        expect(html).toMatch(/<td class="rp-bad">Freeze<\/td>/);
        expect(html).toMatch(/<td class="rp-warn">Codec fallback<\/td>/);
        expect(html).toMatch(/<td class="rp-bad">Quality limitation<\/td>/);
        expect(html).toMatch(/<td class="">Join<\/td>/);
        expect(html).toContain('9 s ago');
    });

    it('long logs show the newest 15 and point at Raw JSON for the rest', () => {
        const html = render(Array.from({ length: 40 }, (_, i) => ev(40 - i, 'freeze', { n: i })));
        expect(html).toContain('Plus 25 older events');
        expect((html.match(/<td class="rp-bad">Freeze<\/td>/g) ?? []).length).toBe(15);
    });

    it('an empty log says so', () => {
        expect(render([])).toContain('No call events recorded');
    });

    it('a crash report has no Call events section', () => {
        const body = buildDiagnosticReport(base('crash', { callEvents: [ev(1, 'join')] })).body;
        expect(renderToStaticMarkup(React.createElement(ReportPreview, { body, trimmed: [] }))).not.toContain('Call events');
    });

    it('formatting helpers', () => {
        expect(callEventLabel('av_sync')).toBe('Av sync');
        expect(callEventDetailText({ a: 1, b: true, c: false, d: 'x' })).toBe('a: 1 · b: yes · c: no · d: x');
        expect(callEventDetailText(undefined)).toBe('');
        expect(callEventTone({ t_s: 0, event: 'quality_limitation', detail: { to: 'none' } })).toBe('');
        expect(callEventTone({ t_s: 0, event: 'quality_limitation', detail: { to: 'bandwidth' } })).toBe('rp-warn');
        expect(callEventTone({ t_s: 0, event: 'codec_decision', detail: { fallback: true } })).toBe('rp-warn');
        expect(callEventTone({ t_s: 0, event: 'join' })).toBe('');
    });
});
