import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    logCallEvent, getCallEvents, clearCallEvents, markCallStart, markCallEnd, trackPlaceholder, formatCallEvents,
    validateCallEvent, CALL_EVENT_KINDS, MAX_EVENTS, MAX_AGE_MS, COALESCE_MS, type CallEventKind,
} from './callEventLog';

let clock = 0;
const EPOCH = 1_791_000_000_000;
beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(Date, 'now').mockImplementation(() => EPOCH + clock);
    clearCallEvents();
});
afterEach(() => vi.restoreAllMocks());

describe('ring buffer', () => {
    it(`keeps at most ${MAX_EVENTS} events, oldest dropped first`, () => {
        for (let i = 0; i < MAX_EVENTS + 120; i++) { clock += COALESCE_MS + 1; logCallEvent('camera_codec', { n: i }); }
        const ev = getCallEvents();
        expect(ev).toHaveLength(MAX_EVENTS);
        expect(ev[0].detail?.n).toBe(120);
        expect(ev[ev.length - 1].detail?.n).toBe(MAX_EVENTS + 119);
    });

    it('drops events older than MAX_AGE_MS', () => {
        logCallEvent('call_join', { participants: 2 });
        clock += MAX_AGE_MS + 1;
        logCallEvent('call_leave', { participants: 1 });
        expect(getCallEvents().map(e => e.kind)).toEqual(['call_leave']);
    });

    it('clearCallEvents (sign-out) empties it', () => {
        logCallEvent('call_join', { participants: 2 });
        clearCallEvents();
        expect(getCallEvents()).toEqual([]);
    });
});

describe('shape and sanitising', () => {
    it('entries are exactly { t, kind, detail? } with t = epoch ms (Date.now)', () => {
        clock = 7_500;
        logCallEvent('call_join', { participants: 3 });
        logCallEvent('reconnecting');
        const [a, b] = getCallEvents();
        expect(a).toEqual({ t: EPOCH + 7500, kind: 'call_join', detail: { participants: 3 } });
        expect(b).toEqual({ t: EPOCH + 7500, kind: 'reconnecting' });
        expect(Object.keys(b)).toEqual(['t', 'kind']);
    });

    it('detail: scalars only, strings 1–64 chars, no NaN, snake_case keys, no reserved keys, ≤ 12 keys', () => {
        logCallEvent('camera_codec', {
            codec: 'h264', ok: true, kbps: 1234.567, bad: Number.NaN, empty: '',
            reason: 'x'.repeat(200), camelCase: 1, kind: 'x', source: 'camera',
            // @ts-expect-error objects are not allowed
            nested: { a: 1 },
        });
        const d = getCallEvents()[0].detail!;
        expect(d).toEqual({ codec: 'h264', ok: true, kbps: 1234.57, reason: 'x'.repeat(64) });
        const many: Record<string, number> = {};
        for (let i = 0; i < 20; i++) many[`k${i}`] = i;
        clock += COALESCE_MS + 1;
        logCallEvent('camera_codec', many);
        expect(Object.keys(getCallEvents()[1].detail!).length).toBeLessThanOrEqual(12);
        for (const e of getCallEvents()) expect(validateCallEvent(e)).toEqual([]);
    });

    it('validateCallEvent enforces the reporter contract', () => {
        const t = EPOCH;
        expect(validateCallEvent({ t, kind: 'ice_route', detail: { type: 'relay', turn: true } })).toEqual([]);
        expect(validateCallEvent({ t: 1234, kind: 'call_join' })).toContain('t is not epoch ms');
        expect(validateCallEvent({ t, kind: 'Bad-Kind' }).length).toBeGreaterThan(0);
        expect(validateCallEvent({ t, kind: 'quality_limitation', detail: { to: 'slow' } })).toContain('quality_limitation.to');
        expect(validateCallEvent({ t, kind: 'camera_fallback', detail: { to: 'vp8' } })).toContain('fallback from/to');
        expect(validateCallEvent({ t, kind: 'ice_route', detail: { turn: true } })).toContain('ice_route.type');
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-screen-1' } })).toContain('track ref remote-screen-1');
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-video-3' } })).toEqual([]);
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-share-3' } })).toEqual([]);
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-share-x' } })).toContain('track ref remote-share-x');
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { source: 'x' } })).toContain('reserved key source');
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { camelKey: 1 } })).toContain('key camelKey');
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { s: '' } })).toContain('value of s');
    });

    it('every kind satisfies the kind pattern; freeze kinds say freeze; H.265 kinds say h265', () => {
        for (const k of CALL_EVENT_KINDS) expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        expect(CALL_EVENT_KINDS.filter(k => k.startsWith('freeze'))).toEqual(['freeze_start', 'freeze_end']);
        expect(CALL_EVENT_KINDS.filter(k => k.startsWith('h265'))).toEqual(['h265_caps', 'h265_switch', 'h265_retry']);
    });

    it('unknown kinds are dropped (the kind list is the contract)', () => {
        logCallEvent('not_a_kind' as CallEventKind);
        expect(getCallEvents()).toEqual([]);
    });

    it('getCallEvents returns copies', () => {
        logCallEvent('camera_codec', { codec: 'vp8' });
        getCallEvents()[0].detail!.codec = 'tampered';
        expect(getCallEvents()[0].detail!.codec).toBe('vp8');
    });
});

describe('coalescing', () => {
    it('identical repeats within 2 s collapse into one entry with a repeat count', () => {
        for (let i = 0; i < 5; i++) { logCallEvent('freeze_start', { track: 'remote-video-1' }); clock += 300; }
        const ev = getCallEvents();
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ track: 'remote-video-1', repeat: 5 });
    });

    it('noisy kinds coalesce even with changing detail (latest wins)', () => {
        logCallEvent('participants', { count: 3 });
        clock += 500;
        logCallEvent('participants', { count: 4 });
        expect(getCallEvents()).toEqual([{ t: expect.any(Number), kind: 'participants', detail: { count: 4, repeat: 2 } }]);
    });

    it('non-noisy kinds with different detail stay separate; anything after 2 s is new', () => {
        logCallEvent('camera_codec', { codec: 'h264' });
        logCallEvent('camera_codec', { codec: 'vp8' });
        clock += COALESCE_MS + 1;
        logCallEvent('camera_codec', { codec: 'vp8' });
        expect(getCallEvents()).toHaveLength(3);
    });
});

describe('placeholders', () => {
    it('stable per call, numbered per kind, never the key', () => {
        markCallStart();
        expect(trackPlaceholder('TR_abc', 'remote-video')).toBe('remote-video-1');
        expect(trackPlaceholder('TR_def', 'remote-video')).toBe('remote-video-2');
        expect(trackPlaceholder('TR_abc', 'remote-video')).toBe('remote-video-1');
        // Shares have their own namespace: remote-video-N is always a camera, remote-share-N always a share.
        expect(trackPlaceholder('TR_xyz', 'remote-screen')).toBe('remote-share-1');
        expect(trackPlaceholder('TR_uvw', 'remote-screen')).toBe('remote-share-2');
        expect(trackPlaceholder('TR_xyz', 'remote-screen')).toBe('remote-share-1');
        expect(trackPlaceholder('TR_ghi', 'remote-video')).toBe('remote-video-3');
        expect(trackPlaceholder('anything', 'self-camera')).toBe('self-camera');
        markCallEnd();
        markCallStart();
        expect(trackPlaceholder('TR_def', 'remote-video')).toBe('remote-video-1');
        expect(trackPlaceholder('TR_xyz', 'remote-screen')).toBe('remote-share-1'); // numbering restarts per call
    });

    it('a placeholder never contains the key it was made from', () => {
        markCallStart();
        const p = trackPlaceholder('TR_SECRETSID', 'remote-screen');
        expect(p).not.toContain('SECRET');
        expect(validateCallEvent({ t: EPOCH, kind: 'freeze_start', detail: { track: p } })).toEqual([]);
    });

    it('formatCallEvents renders one line per event (UTC clock time)', () => {
        logCallEvent('camera_codec', { codec: 'h264', hardware: true });
        expect(formatCallEvents(getCallEvents())).toMatch(/^\d\d:\d\d:\d\d\.\d{3} camera_codec codec=h264 hardware=true$/);
    });
});

/**
 * Privacy guard: every logCallEvent call site in the app must pass a LITERAL
 * kind from the list and a literal detail object whose keys are all on this
 * allowlist. Anything that could identify a person (identity, sid, name,
 * label, device, room, user, email, ip, address, text…) fails the build.
 */
const ALLOWED_KEYS = new Set([
    // Linux hardware (NVENC) screen share: which path/why, the GPU model + driver version (a hardware fact, not a person), sizes and rates.
    'backend', 'gpu', 'driver', 'api', 'sustained', 'w', 'h', 'src_w', 'src_h', 'detail', 'phase', 'latched', 'encoder', 'enc_fps', 'eff_fps', 'enc_ms_p95', 'requested', 'started', 'code', 'msg', 'kbps', 'dropped',
    'speech_db', 'gain_db',
    // mic_level / rx_level (micLevelLog.ts, useParticipantAudio): dBFS levels, percentages and a
    // clipped-sample count - never audio. (`slot` above is the remote-av-N placeholder.)
    'raw_db', 'ns_db', 'out_db', 'peak_db', 'clip', 'lim_pct', 'talk_pct', 'gate_pct', 'mic_gain_db', 'wire_db', 'rx_gain_db', 'heard_db', 'src_pct', 'fresh_pct', 'vf_fps', 'pres_fps', 'gap_p95_ms', 'gap_max_ms', 'late_pct',
    'after_s',
    'participants', 'count', 'pc', 'type', 'local', 'remote', 'turn', 'protocol',
    'width', 'height', 'fps', 'tier', 'cap_tier', 'why',
    'codec', 'profile', 'hardware', 'reason', 'verdict', 'kept', 'from', 'to',
    'layers', 'top', 'top_kbps', 'low', 'mode',
    // share_clamp (phase pre): the kept capture was re-used for a fresh publication (Wayland portal).
    'reused',
    'res', 'lighter_copy', 'on', 'viewers',
    // share_codec: which OS capturer is in use and its fixed frame-rate ceiling (0 = none).
    'backend', 'ceiling',
    // h265_caps: whether H.265 may be used, and a reason enum when not.
    'allowed', 'blocked',
    // e2ee_audio_lag: direction enum, worst lag ms, re-base count (frames/dropped listed elsewhere).
    'dir', 'max_ms', 'rebases', 'windows',
    'track', 'prev_seconds', 'ms', 'quality', 'role', 'size',
    'cap', 'decoded', 'avatars',
    'encode', 'decode', 'network', 'sources', 'decoding', 'drop_pct', 'decode_ms',
    'offer', 'answer',
    'capable', 'total', 'self_encode',
    // Share picker timings (ScreenSharePickerModal): durations and a cache flag only.
    'open_ms', 'list_ms', 'preview_ms', 'cached', 'tab',
    // Share start stages (SidebarConference.startScreenShareFrom): durations only.
    'probe_ms', 'publish_ms',
    // A/V sync (avSyncMonitor.ts, SidebarConference share-audio ring). `slot`
    // is a per-call placeholder (remote-av-N) built in avSyncMonitor, never an identity.
    'slot', 'stream', 'path', 'chain', 'offset_ms', 'uncertainty_ms', 'audio_path_ms', 'video_path_ms',
    // av_sync_applied: the share-video jitter-buffer target set to meet the share audio.
    'target_ms',
    'web_audio_extra_ms', 'base_latency_ms', 'output_latency_ms', 'sample_rate', 'dropped_ms', 'trims',
    // E2EE frame health (e2eeWorkerStats.ts): frame counts only.
    'frames', 'rewritten', 'short_sc', 'leading', 'key_rewritten', 'delta_rewritten',
    // Annotation overlay / transport health (desktopAnnotationOverlay.ts,
    // useAnnotationTransport.ts, e2eeWorkerStats.ts): outcome + reason enums,
    // share KIND (screen|window), a display COUNT, booleans.
    'result', 'how', 'share', 'captured', 'displays', 'addon',
    // Mic re-acquire (micDeviceSync.ts): followed the system default? (boolean).
    'to_default',
    // Mic capture-flag enforcement (micDeviceSync.applyCapture -> mic_echo_cancellation):
    // `on` (wanted echo cancellation) and `changed` (it was among the differing flags), booleans.
    'changed',
    // Output-device routing (audioOutput.ts -> audio_output_sink): which kind of
    // target, did the read-back match, and a closed DOMException-name enum.
    'target', 'landed', 'error',
    // GPU process restart + video recovery (gpuRecovery.ts): Chromium's exit
    // code, booleans, a step enum and counts; our own advertised H.265 decode
    // (h265_caps, SidebarConference).
    'step', 'ok', 'frozen', 'camera', 'exit_code', 'ctx_lost', 'in_call', 'self_decode',
    // Share in the background (shareBackgroundProbe.ts): a cause enum, a
    // boolean, frame rates and capture-log timings only.
    'cause', 'real', 'repeats', 'errors', 'fg_full', 'doc_hidden', 'target_fps', 'capture_before', 'sent_before', 'capture_after', 'sent_after',
    'grab_ms', 'interval_ms', 'unchanged_pct',
    // Share frame-rate instrumentation + encoder-size clamp (shareHealth.ts,
    // shareEncoderLimits.ts): rates, an encoder-implementation name, sizes as
    // "WxH", a scale factor, a layout enum, booleans.
    'cap_fps', 'src_fps', 'enc_fps', 'sent_fps', 'limit', 'enc', 'hw', 'focus', 'vis',
    'cap_res', 'scale', 'layout', 'over',
    // The capture-size handshake of a share start / hot swap (shareFirstFrame.ts),
    // on share_clamp: the box asked for, the size the track reported at publish,
    // the first real frame - all "WxH" - an outcome enum (ok / pinned / timeout /
    // ended / unsupported) and the wait in ms.
    'ask', 'pub_res', 'first_frame', 'settle', 'settle_ms',
    // audio_out_stall / audio_in_stall (SidebarConference, BetaCallMonitor): a
    // cause enum (reuses `cause`), the processing AudioContext's state enum,
    // and booleans only - never a device, track or participant reference.
    'ctx', 'resumed', 'sfu_hears', 'other_flowing',
    // HDR screen shares (SidebarConference tryStartHdrShare): the display's HDR
    // state, nits, a knee, an input-format enum, sizes as "WxH", a start
    // duration, and the tone map's GPU cost / frame counters.
    'hdr', 'bits', 'white', 'peak', 'knee', 'in_fmt', 'src', 'start_ms', 'stage',
    'dropped', 'gpu_us_avg', 'gpu_us_max', 'wait_us_avg', 'redup', 'written', 'enc_drop',
    // What had the screen during a share (foregroundInfo.ts -> share_fps, share_background):
    // a Windows notification-state enum, the foreground PROGRAM's basename (never a
    // window title or path), a boolean. Share power-throttling opt-out
    // (sharePowerEvent.ts -> share_power): a phase enum, counts, Win32 error codes,
    // a mask, a boolean.
    'fg_state', 'fg_exe', 'fg_cover',
    'phase', 'procs', 'ok_n', 'fail_n', 'main_err', 'gpu_err', 'ren_err', 'mask', 'timer',
    // GPU scheduling class (shareGpuSchedEvent.ts -> share_gpu_sched): class names
    // read back per process and NTSTATUS strings ("0", "0xc0000061", "err5", "na").
    'gpu_sched_main', 'gpu_sched_gpu', 'gpu_sched_main_rt', 'gpu_sched_gpu_rt', 'gpu_sched_main_st', 'gpu_sched_gpu_st',
    // Long renderer frames (freezeLog.ts → long_frame): durations, a script
    // count, and the top script's file basename / function name / char offset /
    // invoker kind — code identifiers reduced by longFrameAttribution.ts.
    'blocking_ms', 'render_ms', 'layout_ms', 'script_ms', 'scripts', 'file', 'fn', 'char', 'invoker', 'invoker_type',
    // Receive-side video health + share loss fallback (CallEventMonitor →
    // rx_layer / rx_video_health / share_rx_fallback): a direction enum,
    // loss %, RTCP counts, a hold and a window in seconds, a boolean.
    'action', 'loss_pct', 'hold_s', 'pli', 'kf', 'nack', 'window_s', 'capped',
    // Audio render-thread load (CallPane ← nsLoadGuard.ts → audio_render /
    // ns_load_fallback): underrun ms and event counts, an NS engine enum.
    'underrun_ms', 'underrun_events', 'ns',
    // Share codec drift (shareCodecDrift.ts → share_codec_drift): the codec the
    // share was published with and the one really sent (codec names only).
    'published', 'sent',
    // Capture stall / crop stage (shareHealth.diagnoseNoFrames, shareCrop.ts →
    // share_capture_stall, share_crop): which check, frame COUNTS, a boolean.
    'check', 'src_frames', 'crop_in', 'crop_out', 'crop_err', 'wk_err',
    // Receive side (CallEventMonitor → freeze_start, share_rx_dead): was
    // Cipherline in the background, did packets arrive (enum), frame counts.
    'bg', 'rx', 'packets',
    // Share rates at both ends (shareRxStats.ts / shareNetStats.ts / displayRefresh.ts →
    // share_rx_fps, share_rx_start, share_net, share_display): `share_ref` is an 8-hex
    // digest of the track SID (shareRef.ts), never the SID; frame rates, jitter-buffer /
    // encode / RTT ms, kbit/s, a requested-layer index, a tile size in px, a decoder
    // implementation name, a refresh rate in Hz and how it was found (enum), a role enum.
    'share_ref', 'role', 'hz', 'hz_src', 'rx_fps', 'dec_fps', 'drop_fps', 'disp_fps',
    'decoder', 'jb_ms', 'layer', 'tile', 'kbps', 'cap_kbps', 'avail_kbps', 'rtt_ms', 'enc_ms',
    // rx_decoder_lost (rxDecoderLost.ts): ms since the displayed <video> element last changed.
    'el_ms',
    // Per-second series around a freeze / a share_fps dip (shareSecondRing.ts → share_rx_ring,
    // share_tx_ring): "88/89/0/0" strings of whole numbers ("-" = not measured), oldest first -
    // frames received / decoded / presented and packets per second (viewer), frames captured /
    // encoded / sent and active layers per second (sharer). `act` is the number of active
    // layers on share_fps.
    'rx_s', 'dec_s', 'disp_s', 'pkt_s', 'src_s', 'enc_s', 'sent_s', 'act_s', 'act',
    // share_audio step "picked" (shareAudioEvent.ts, Wayland window share): how many apps were on
    // offer - a COUNT, never their names - next to `how` (an enum, allowed above) and mode=app.
    'apps',
]);
const FORBIDDEN = /[iI]dentity|^sid$|Sid|[nN]ame|[lL]abel|[dD]evice|[rR]oom|[uU]ser|[eE]mail|^ip$|^ip[A-Z]|IP|[aA]ddr|[tT]ext|[tT]itle|[mM]essage|[mM]etadata/;

/** Keys of a detail object literal: `key: value` and shorthand `key`. */
function detailKeys(body: string): string[] {
    const colon = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(k => k[1]);
    const shorthand = body.split(',').map(t => t.trim()).filter(t => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    return [...new Set([...colon, ...shorthand])];
}

const stripPlaceholders = (body: string) => body.replace(/trackPlaceholder\([^)]*\)/g, '');
const READS_IDENTITY = /\.(identity|name|sid|trackSid|metadata|attributes|label|deviceId)\b/;

function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
    }
    return out;
}

describe('call-site privacy scan', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = walk(src).filter(f => !f.endsWith('callEventLog.ts'));
    const sites: { file: string; kind: string; keys: string[]; body: string }[] = [];
    for (const f of files) {
        const text = readFileSync(f, 'utf8');
        const re = /logCallEvent\(\s*'([a-z0-9_]+)'\s*(?:,\s*\{([\s\S]*?)\}\s*)?\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const body = m[2] ?? '';
            // keys = identifiers before ':' at the top level of the literal
            sites.push({ file: relative(src, f), kind: m[1], keys: detailKeys(body), body });
        }
        // Every call must have a literal kind (no variables).
        const all = text.match(/logCallEvent\(/g)?.length ?? 0;
        const literal = text.match(/logCallEvent\(\s*'[a-z0-9_]+'/g)?.length ?? 0;
        expect({ file: relative(src, f), nonLiteral: all - literal }).toEqual({ file: relative(src, f), nonLiteral: 0 });
    }

    it('finds the call sites (positive control)', () => {
        expect(sites.length).toBeGreaterThan(20);
        expect(new Set(sites.map(s => s.file)).size).toBeGreaterThanOrEqual(6);
    });

    it('the A/V-sync call sites are part of the scan (merged from the av-sync stand-in log)', () => {
        const kinds = new Set(sites.map(s => s.kind));
        for (const k of ['av_sync_offset', 'av_sync_playback_path', 'av_sync_webaudio_latency', 'av_sync_ss_audio_trim']) expect(kinds).toContain(k);
    });

    it('every kind used is on the published list', () => {
        for (const s of sites) expect(CALL_EVENT_KINDS as readonly string[]).toContain(s.kind);
    });

    it('every detail key is snake_case per the reporter contract', () => {
        const bad = sites.flatMap(s => s.keys.filter(k => !/^[a-z][a-z0-9_]{0,31}$/.test(k) || ['kind', 'source', 'quality_limitation_reason'].includes(k)).map(k => `${s.file}: ${s.kind}.${k}`));
        expect(bad).toEqual([]);
    });

    it('literal track refs use only the reporter placeholders', () => {
        const refs = sites.flatMap(s => [...s.body.matchAll(/track:\s*'([^']+)'/g)].map(m => m[1]));
        expect(refs.length).toBeGreaterThan(0);
        for (const r of refs) expect(r).toMatch(/^(self-camera|self-screen|self-screen-audio|self-mic)(-\d+)?$|^remote-(video|share)-\d+$/);
    });

    it('every detail key is allowlisted and none looks identifying', () => {
        const bad = sites.flatMap(s => s.keys.filter(k => !ALLOWED_KEYS.has(k) || FORBIDDEN.test(k)).map(k => `${s.file}: ${s.kind}.${k}`));
        expect(bad).toEqual([]);
    });

    it('no detail VALUE reads an identity, name, sid or metadata (track refs only via trackPlaceholder)', () => {
        const bad = sites.filter(s => READS_IDENTITY.test(stripPlaceholders(s.body)));
        expect(bad.map(s => `${s.file}: ${s.kind}`)).toEqual([]);
    });

    it('the scan itself catches identifying keys and values (negative controls)', () => {
        const flagged = (b: string) => detailKeys(b).filter(k => !ALLOWED_KEYS.has(k) || FORBIDDEN.test(k));
        expect(flagged("identity: p.identity, codec: 'h264'")).toEqual(['identity']);
        expect(flagged('codec, deviceLabel')).toEqual(['deviceLabel']);
        expect(READS_IDENTITY.test(stripPlaceholders('track: pub.trackSid'))).toBe(true);
        expect(READS_IDENTITY.test(stripPlaceholders("track: trackPlaceholder(pub.trackSid, 'remote-video')"))).toBe(false);
    });
});
