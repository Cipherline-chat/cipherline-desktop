import React from 'react';
import type {
    CallEvent, DiagnosticReportBody, InboundTrackStats, OutboundTrackStats, WebrtcSample,
} from '../../utils/diagnostics/reportTypes';
import { callEventDetailText, callEventLabel, callEventTone } from '../../utils/diagnostics/callEventsView';

/**
 * The readable half of the Preview step. Renders ONLY what is in `body` — the
 * exact object that is saved or sent — so what the user reads here and what
 * leaves the device cannot drift apart. The raw-JSON half (RawJson below) is
 * JSON.stringify of the same object.
 */

const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    return String(v);
};
const fps = (v?: number) => (v === undefined ? '—' : `${Math.round(v * 10) / 10}`);
const ago = (t: number) => (t === 0 ? 'now' : `${Math.abs(Math.round(t))} s ago`);

const KV: React.FC<{ rows: Array<[string, React.ReactNode]> }> = ({ rows }) => (
    <dl className="rp-kv">
        {rows.map(([k, v]) => (
            <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
            </React.Fragment>
        ))}
    </dl>
);

const Section: React.FC<{ title: string; count?: string; children: React.ReactNode }> = ({ title, count, children }) => (
    <section className="rp-sec" aria-label={title}>
        <h3>{title}{count && <span className="rp-count">{count}</span>}</h3>
        {children}
    </section>
);

const Hw: React.FC<{ hw?: boolean | null }> = ({ hw }) =>
    hw === undefined || hw === null ? null : <span className={`rp-hw ${hw ? 'rp-hw--hw' : 'rp-hw--sw'}`}>{hw ? 'HW' : 'SW'}</span>;

/** Colour a delivered frame rate against the target, like the stats overlay. */
function toneOf(v: number | undefined, target: number | undefined): string {
    if (v === undefined || !target) return '';
    if (v >= target * 0.95) return 'rp-ok';
    if (v >= target * 0.75) return 'rp-warn';
    return 'rp-bad';
}

const LIMIT_LABEL: Record<string, string> = { none: 'none', cpu: 'CPU', bandwidth: 'bandwidth', other: 'other' };

const OutboundTable: React.FC<{ rows: OutboundTrackStats[] }> = ({ rows }) => (
    <div className="rp-tablewrap">
        <table className="rp-table">
            <thead>
                <tr>
                    <th>Track</th><th>Codec</th>
                    <th className="rp-num">Target</th><th className="rp-num">Capture</th><th className="rp-num">Encoded</th><th className="rp-num">Sent</th>
                    <th>Size</th><th>Limited by</th><th className="rp-num">kbps</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(o => (
                    <tr key={o.track}>
                        <td>{o.track}</td>
                        <td className="rp-codec">{o.codec ?? '—'}<Hw hw={o.hardware} />{o.encoder ? <span className="rp-impl" title={o.encoder}>{o.encoder}</span> : null}</td>
                        <td className="rp-num">{fps(o.target_fps)}</td>
                        <td className={`rp-num ${toneOf(o.capture_fps, o.target_fps)}`}>{fps(o.capture_fps)}</td>
                        <td className={`rp-num ${toneOf(o.encoded_fps, o.target_fps)}`}>{fps(o.encoded_fps)}</td>
                        <td className={`rp-num ${toneOf(o.sent_fps, o.target_fps)}`}>{fps(o.sent_fps)}</td>
                        <td>{o.width && o.height ? `${o.width}×${o.height}` : '—'}</td>
                        <td className={o.quality_limitation_reason && o.quality_limitation_reason !== 'none' ? 'rp-warn' : ''}>
                            {o.quality_limitation_reason ? LIMIT_LABEL[o.quality_limitation_reason] : '—'}
                        </td>
                        <td className="rp-num">
                            {o.bitrate_kbps ?? '—'}
                            {o.target_bitrate_kbps ? <span className="rp-impl">of {o.target_bitrate_kbps}</span> : null}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

const InboundTable: React.FC<{ rows: InboundTrackStats[] }> = ({ rows }) => (
    <div className="rp-tablewrap">
        <table className="rp-table">
            <thead>
                <tr>
                    <th>Track</th><th>Codec</th><th className="rp-num">FPS</th><th>Size</th>
                    <th className="rp-num">kbps</th><th className="rp-num">Loss</th><th className="rp-num">Jitter</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(i => (
                    <tr key={i.track}>
                        <td>{i.track}</td>
                        <td className="rp-codec">{i.codec ?? '—'}<Hw hw={i.hardware} />{i.decoder ? <span className="rp-impl" title={i.decoder}>{i.decoder}</span> : null}</td>
                        <td className="rp-num">{fps(i.fps)}</td>
                        <td>{i.width && i.height ? `${i.width}×${i.height}` : '—'}</td>
                        <td className="rp-num">{i.bitrate_kbps ?? '—'}</td>
                        <td className={`rp-num ${(i.packets_lost_pct ?? 0) >= 2 ? 'rp-warn' : ''}`}>{i.packets_lost_pct !== undefined ? `${i.packets_lost_pct}%` : '—'}</td>
                        <td className="rp-num">{i.jitter_ms !== undefined ? `${i.jitter_ms} ms` : '—'}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

/** The primary outbound video over time — the "is it really 90 fps?" view. */
const Timeline: React.FC<{ samples: WebrtcSample[] }> = ({ samples }) => {
    const pick = (s: WebrtcSample) =>
        s.outbound.find(o => o.source === 'screen_share' && o.kind === 'video') ?? s.outbound.find(o => o.kind === 'video');
    const rows = samples.map(s => ({ t: s.t_s, o: pick(s), rtt: s.transport?.rtt_ms, loss: s.transport?.packet_loss_pct })).filter(r => r.o);
    if (rows.length < 2) return null;
    const name = rows[rows.length - 1].o!.track;
    return (
        <>
            <div className="rp-help" style={{ margin: '12px 0 6px' }}>{name} over the last {Math.round(Math.abs(rows[0].t))} s</div>
            <div className="rp-tablewrap">
                <table className="rp-table">
                    <thead>
                        <tr>
                            <th>When</th><th className="rp-num">Target</th><th className="rp-num">Capture</th><th className="rp-num">Encoded</th>
                            <th className="rp-num">Sent</th><th>Limited by</th><th className="rp-num">kbps</th><th className="rp-num">RTT</th><th className="rp-num">Loss</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice().reverse().map(({ t, o, rtt, loss }) => (
                            <tr key={t}>
                                <td>{ago(t)}</td>
                                <td className="rp-num">{fps(o!.target_fps)}</td>
                                <td className={`rp-num ${toneOf(o!.capture_fps, o!.target_fps)}`}>{fps(o!.capture_fps)}</td>
                                <td className={`rp-num ${toneOf(o!.encoded_fps, o!.target_fps)}`}>{fps(o!.encoded_fps)}</td>
                                <td className={`rp-num ${toneOf(o!.sent_fps, o!.target_fps)}`}>{fps(o!.sent_fps)}</td>
                                <td>{o!.quality_limitation_reason ? LIMIT_LABEL[o!.quality_limitation_reason] : '—'}</td>
                                <td className="rp-num">{o!.bitrate_kbps ?? '—'}</td>
                                <td className="rp-num">{rtt !== undefined ? `${Math.round(rtt)} ms` : '—'}</td>
                                <td className="rp-num">{loss !== undefined ? `${loss}%` : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
};

const CALL_EVENT_ROWS_SHOWN = 15;

/** What the call engine decided — newest first, like the other logs; all of it is in Raw JSON. */
const CallEventsTable: React.FC<{ events: CallEvent[] }> = ({ events }) => (
    <div className="rp-tablewrap">
        <table className="rp-table">
            <thead>
                <tr><th>When</th><th>Event</th><th>Details</th></tr>
            </thead>
            <tbody>
                {events.slice(-CALL_EVENT_ROWS_SHOWN).reverse().map((e, i) => (
                    <tr key={i}>
                        <td>{ago(e.t_s)}</td>
                        <td className={callEventTone(e)}>{callEventLabel(e.event)}</td>
                        <td className="rp-wrap">{callEventDetailText(e.detail)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
        {events.length > CALL_EVENT_ROWS_SHOWN && (
            <div className="rp-help" style={{ marginTop: 6 }}>Plus {events.length - CALL_EVENT_ROWS_SHOWN} older events — all of them are in Raw JSON.</div>
        )}
    </div>
);

const SETTING_LABELS: Record<string, string> = {
    hardware_acceleration: 'Hardware acceleration', reduced_motion: 'Reduced motion',
    screen_share_fps: 'Share frame rate', screen_share_resolution: 'Share resolution', screen_share_codec: 'Codec preference',
    screen_share_codec_used: 'Codec used', screen_share_h264_profile: 'H.264 profile', screen_share_capture_request_fps: 'Capture asked for',
    screen_share_source_kind: 'Shared', captured_display_hz: 'Display refresh (Hz)', capture_backend: 'Capture method',
    screen_capturer: 'Capturer setting', capture_timing_log: 'Capture timing log', gpu_video_encode: 'GPU video encode',
    h264_cbp_hw_enabled: 'H.264 hardware path', hw_encoder_h264: 'HW encoder: H.264', hw_encoder_h264_high: 'HW encoder: H.264 High',
    hw_encoder_vp9: 'HW encoder: VP9', hw_encoder_vp8: 'HW encoder: VP8', stream_stats_hud: 'Stream stats overlay',
    noise_suppression: 'Noise suppression', volume_normalization: 'Volume normalization', voice_gate: 'Voice gate',
    voice_gate_threshold_db: 'Gate threshold (dB)', push_to_talk: 'Push to talk', mic_volume: 'Mic volume', speaker_volume: 'Speaker volume',
    eq_enabled: 'Equalizer', mic_device: 'Microphone', speaker_device: 'Speaker', audio_input_devices: 'Microphones found',
    audio_output_devices: 'Speakers found', camera_device: 'Camera', video_input_devices: 'Cameras found',
    camera_brightness: 'Brightness', camera_contrast: 'Contrast', camera_saturation: 'Saturation',
    os_notification_permission: 'OS permission', desktop_notifications: 'Desktop notifications', sounds: 'Sounds', master_volume: 'Volume',
    show_preview: 'Message preview', quick_reply: 'Quick reply', keyword_count: 'Keywords (count)', custom_sound_count: 'Custom sounds (count)',
    dnd_manual: 'Do not disturb', dnd_schedule: 'DND schedule', dnd_auto_in_call: 'Auto-DND in calls', dnd_auto_screensharing: 'Auto-DND sharing',
    dnd_auto_in_game: 'Auto-DND in games', dnd_auto_status_dnd: 'Auto-DND on DND status', dnd_auto_status_away: 'Auto-DND when away',
    dnd_let_mentions_through: 'Mentions through DND', suppress_when_active_conv: 'Quiet in open chat', suppress_when_window_focused: 'Quiet when focused',
    show_badge_count: 'Badge count', flash_taskbar: 'Flash taskbar', badge_only_mentions: 'Badge: mentions only', badge_includes_muted: 'Badge: include muted',
};

const CRASH_KIND: Record<string, string> = {
    renderer_gone: 'Window process stopped', child_process_gone: 'Helper process stopped', main_exception: 'App error (main process)',
    renderer_exception: 'App error (window)', unclean_exit: 'App didn’t shut down cleanly',
};

export const ReportPreview: React.FC<{ body: DiagnosticReportBody; trimmed: string[] }> = ({ body, trimmed }) => {
    const p = body.payload;
    const sys = p.system;
    const gpu = sys.gpu.devices.map(d => `${d.vendor_id}:${d.device_id}${d.driver_version ? ` · ${d.driver_version}` : ''}${d.active ? ' (active)' : ''}`).join(', ') || '—';
    const displays = sys.displays.map(d => `${d.width}×${d.height} @ ${d.refresh_hz} Hz${d.scale_factor !== 1 ? ` ×${d.scale_factor}` : ''}${d.primary ? ' (primary)' : ''}`).join(', ') || '—';
    const settings = Object.entries(p.settings);
    const latest = p.webrtc?.samples[p.webrtc.samples.length - 1];
    const perfRows = p.perf_log?.rows ?? [];

    return (
        <div>
            <Section title="Your description">
                {body.description
                    ? <div className="rp-desc">{body.description}</div>
                    : <div className="rp-empty">No description.</div>}
                {body.reply_email && (
                    <div className="rp-help" style={{ marginTop: 8 }}>Reply to: <span style={{ color: 'var(--cl-text)' }}>{body.reply_email}</span> (sent alongside, not in the diagnostic data)</div>
                )}
            </Section>

            {p.crash && (
                <Section title="Crash">
                    <KV rows={[
                        ['What', CRASH_KIND[p.crash.kind] ?? p.crash.kind],
                        ...(p.crash.process_type ? [['Process', p.crash.process_type] as [string, string]] : []),
                        ...(p.crash.reason ? [['Reason', p.crash.reason] as [string, string]] : []),
                        ...(p.crash.exit_code !== undefined ? [['Exit code', String(p.crash.exit_code)] as [string, string]] : []),
                        ...(p.crash.error_name ? [['Error', p.crash.error_name] as [string, string]] : []),
                        ...(p.crash.message ? [['Message', p.crash.message] as [string, string]] : []),
                        ['When', new Date(p.crash.occurred_at).toLocaleString()],
                        ...(p.crash.app_version_at_crash ? [['Version then', p.crash.app_version_at_crash] as [string, string]] : []),
                    ]} />
                    {p.crash.stack && <pre className="rp-pre" style={{ marginTop: 10 }}>{p.crash.stack}</pre>}
                </Section>
            )}

            {p.webrtc && (
                <Section
                    title="Call quality"
                    count={p.webrtc.call_active ? 'call in progress' : p.webrtc.seconds_since_call_end !== undefined ? `call ended ${p.webrtc.seconds_since_call_end} s ago` : undefined}
                >
                    {p.webrtc.capture && (
                        <KV rows={[
                            ['Capturing', p.webrtc.capture.kind],
                            ['Asked for', `${p.webrtc.capture.requested_fps ?? '—'} fps${p.webrtc.capture.requested_resolution ? ` · ${p.webrtc.capture.requested_resolution}` : ''}${p.webrtc.capture.codec_pref ? ` · codec ${p.webrtc.capture.codec_pref}` : ''}`],
                            ['Capture delivered', p.webrtc.capture.capture_fps !== undefined ? `${p.webrtc.capture.capture_fps} fps` : '—'],
                        ]} />
                    )}
                    {!latest
                        ? <div className="rp-empty">No call recorded in this session. Report while you’re in the call (or right after it) to include call-quality numbers.</div>
                        : (
                            <>
                                {latest.outbound.length > 0 && <div style={{ marginTop: p.webrtc.capture ? 12 : 0 }}><OutboundTable rows={latest.outbound} /></div>}
                                {latest.inbound.length > 0 && <div style={{ marginTop: 10 }}><InboundTable rows={latest.inbound} /></div>}
                                <Timeline samples={p.webrtc.samples} />
                            </>
                        )}
                </Section>
            )}

            {p.call_events && (
                <Section title="Call events" count={`${p.call_events.length}`}>
                    {p.call_events.length === 0
                        ? <div className="rp-empty">No call events recorded. They are logged while a call is running, so report during or right after the call.</div>
                        : <CallEventsTable events={p.call_events} />}
                </Section>
            )}

            {p.entitlement && (
                <Section title="Plan limits">
                    <KV rows={[
                        ['Plan', p.entitlement.is_paid ? 'Pro / trial' : 'Free'],
                        ['Video & screen share', p.entitlement.can_publish_video ? 'allowed' : 'not on this plan'],
                        ['Highest share frame rate', p.entitlement.max_screen_share_fps ? `${p.entitlement.max_screen_share_fps} fps` : '—'],
                        ['Upload limit', `${p.entitlement.max_upload_mb} MB`],
                    ]} />
                </Section>
            )}

            <Section title="This device">
                <KV rows={[
                    ['App', `${sys.app_version} (${sys.build_commit}) · ${sys.channel}`],
                    ['Runtime', `Electron ${sys.electron} · Chrome ${sys.chrome}`],
                    ['System', `${sys.platform} ${sys.os_version} · ${sys.arch}`],
                    ['CPU', `${sys.cpu_model} · ${sys.cpu_cores} threads`],
                    ['Memory', `${sys.ram_gb} GB`],
                    ['GPU', gpu],
                    ['GPU features', Object.entries(sys.gpu.feature_status).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'],
                    ['Displays', displays],
                    ['Hardware acceleration', fmt(sys.hardware_acceleration)],
                    ['Running for', `${Math.round(sys.uptime_s / 60)} min`],
                ]} />
            </Section>

            <Section title="Settings" count={`${settings.length}`}>
                {settings.length
                    ? <KV rows={settings.map(([k, v]) => [SETTING_LABELS[k] ?? k, fmt(v)])} />
                    : <div className="rp-empty">None for this category.</div>}
            </Section>

            {p.recent_errors && (
                <Section title="Recent app errors" count={`${p.recent_errors.length}`}>
                    {p.recent_errors.length === 0
                        ? <div className="rp-empty">None this session.</div>
                        : (
                            <div className="rp-tablewrap">
                                <table className="rp-table">
                                    <tbody>
                                        {p.recent_errors.slice().reverse().map((e, i) => (
                                            <tr key={i}>
                                                <td>{ago(e.t_s)}</td>
                                                <td>{e.name ?? e.kind}</td>
                                                <td className="rp-wrap">{e.message}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                </Section>
            )}

            {p.perf_log && (
                <Section title="Performance log" count={`${perfRows.length} of ${p.perf_log.total_rows} rows`}>
                    {perfRows.length === 0
                        ? <div className="rp-empty">No freezes or events recorded.</div>
                        : (
                            <div className="rp-tablewrap">
                                <table className="rp-table">
                                    <tbody>
                                        {perfRows.slice(-12).reverse().map((r, i) => (
                                            <tr key={i}>
                                                <td>{ago(r.t_s)}</td>
                                                <td>{r.source}</td>
                                                <td className="rp-num">{r.ms > 0 ? `${r.ms} ms` : ''}</td>
                                                <td className="rp-wrap">{r.activity}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {perfRows.length > 12 && <div className="rp-help" style={{ marginTop: 6 }}>Plus {perfRows.length - 12} older rows — all of them are in Raw JSON.</div>}
                            </div>
                        )}
                </Section>
            )}

            {trimmed.length > 0 && (
                <div className="rp-help" style={{ marginTop: 10 }}>
                    Trimmed to fit the size limit: the oldest {trimmed.join(', ').replace(/_/g, ' ')} entries were left out.
                </div>
            )}
        </div>
    );
};

/** Raw JSON view — the same object, pretty-printed, with light highlighting. */
export const RawJson: React.FC<{ body: DiagnosticReportBody }> = ({ body }) => {
    const text = React.useMemo(() => JSON.stringify(body, null, 2), [body]);
    const parts = React.useMemo(() => {
        const out: React.ReactNode[] = [];
        const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
        let last = 0;
        let m: RegExpExecArray | null;
        let i = 0;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push(text.slice(last, m.index));
            if (m[1]) {
                out.push(<span key={i++} className={m[2] ? 'k' : 's'}>{m[1]}</span>);
                if (m[2]) out.push(m[2]);
            } else if (m[3]) out.push(<span key={i++} className="b">{m[3]}</span>);
            else out.push(<span key={i++} className="n">{m[4]}</span>);
            last = re.lastIndex;
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
    }, [text]);
    return <pre className="rp-raw" tabIndex={0} aria-label="Raw JSON of the report">{parts}</pre>;
};
