/**
 * Chromium media switches for screen capture + hardware encode, and the
 * diagnostics the stream-stats overlay shows about them.
 *
 * Deliberately free of any `electron` import so every decision here is unit
 * testable (capture-flags.test.ts); main.ts applies the result.
 *
 * Everything below was read out of the exact Chromium this app ships
 * (Electron 43.2.0 = Chromium 150.0.7871.129). File references are to that
 * tag of chromium/src.
 *
 * ── Why screen capture tops out well below 90 fps ──────────────────────────
 * content/browser/media/capture/desktop_capture_device.cc schedules every
 * capture as
 *
 *     capture_period = max(last_capture_duration * 100 / max_cpu_consumption_percentage_,
 *                          requested_frame_duration_)
 *
 * with `max_cpu_consumption_percentage_` initialised from the file-local
 * constant kDefaultMaximumCpuConsumptionPercentage = 50 and never written
 * again. There is NO switch for it in this Chromium: content_switches.cc has
 * no `webrtc-max-cpu-consumption-percentage`, and Electron 43 carries no patch
 * to that file. `last_capture_duration` is wall time from starting the grab to
 * handing the frame on — the OS capturer's GPU→CPU readback and copy, the
 * cursor composite, and the BGRA→I420 conversion. So a capture that takes
 * ~9.5 ms is scheduled every ~19 ms: ~52 fps, whatever frame rate was asked
 * for and whatever the encoder does. Measured on this repo's harness with
 * Chromium's own VLOG(2) output (the only place those two numbers are
 * visible): `max_cpu_consumption_percentage=50` with AND without the switch,
 * and `capture_period` = 2× `last_capture_duration` whenever that exceeded
 * the requested 11 ms.
 *
 * The app used to append `webrtc-max-cpu-consumption-percentage=100` believing
 * it lifted exactly this. It did nothing in this Chromium; it is gone.
 *
 * What CAN be changed from Electron is WHICH OS capturer does the grab (it is
 * most of `last_capture_duration`, and the two have different frame-delivery
 * behaviour at high refresh rates) — see ScreenCapturerPref — and whether we
 * can SEE the per-frame cost — see captureLogSwitches / parseCaptureTimingLog.
 *
 * ── Which Windows screen capturer Chromium 150 uses ─────────────────────────
 * desktop_capture_device.cc IsWgcEnabledForScreenCapture(): Windows.Graphics.
 * Capture (WGC) for screens iff the `AllowWgcScreenCapturer` feature is
 * explicitly enabled, or — when nobody overrode the feature — the OS is
 * Windows 11 24H2 (build 26100) or newer. Otherwise the screen capturer is
 * DXGI Desktop Duplication with GDI as fallback (content/public/browser/
 * desktop_capture.cc CreateDesktopCaptureOptions → set_allow_directx_capturer).
 * WINDOW sources always use WGC (set_allow_wgc_window_capturer(true)).
 * With WGC on a screen, "0 Hz" mode follows it (IsWgcZeroHzEnabledForScreen
 * Capture): a poll that finds no new frame delivers nothing, so the delivered
 * rate is also bounded by how often WGC hands over a new frame.
 *
 * ── Why "Auto" never found hardware H.264 on Windows ───────────────────────
 * LiveKit's SFU (livekit/protocol codecs.go) accepts only two H.264 variants:
 * Constrained Baseline `profile-level-id=42e01f` and High `640032`. Chromium
 * lists its software (OpenH264) formats first (blink video_codec_factory.cc
 * MergeFormats(software, hardware)), so the negotiated send codec is the
 * Constrained Baseline one. And on Windows Chromium does NOT advertise
 * hardware Constrained Baseline unless the `PlatformH264CbpEncoding` feature
 * is on — blink webrtc_util.cc: FEATURE_DISABLED_BY_DEFAULT on Windows only
 * (enabled on Linux/ChromeOS/Android). So a LiveKit H.264 share on Windows
 * was OpenH264 in software, and MediaCapabilities (which answers for that
 * same profile) truthfully said "not power efficient". We enable the feature.
 * One exception survives it: media_foundation_video_encode_accelerator_win.cc
 * skips NVIDIA's encoder for Constrained Baseline (crbug.com/1088650) and
 * moves on to the next hardware encoder (e.g. an Intel iGPU), so an
 * NVIDIA-only machine still has no hardware path for the profile LiveKit
 * negotiates — see src/utils/screenShare.ts chooseScreenShareCodec.
 */

export type ScreenCapturerPref = 'auto' | 'dxgi' | 'wgc';

/** `CIPHERLINE_SCREEN_CAPTURER` → pref (Settings → Advanced goes through
 *  ./startup-flags.ts instead, which accepts only the exact values). Anything unrecognised is 'auto'
 *  (Chromium's own choice), never an error: this is a test knob. */
export function parseScreenCapturerPref(v: string | undefined): ScreenCapturerPref {
    const s = (v ?? '').trim().toLowerCase();
    return s === 'dxgi' || s === 'wgc' ? s : 'auto';
}

/** Windows build number from `os.release()` ("10.0.26100" → 26100). */
export function windowsBuildFromRelease(release: string | undefined): number | null {
    // Windows 10 and 11 both report "10.0.<build>".
    const m = /^10\.0\.(\d+)$/.exec((release ?? '').trim());
    return m ? Number(m[1]) : null;
}

/** First Windows build where Chromium 150 defaults screens to WGC. */
export const WIN11_24H2_BUILD = 26100;

export interface ChromiumMediaSwitches {
    enableFeatures: string[];
    disableFeatures: string[];
}

/**
 * The `--enable-features` / `--disable-features` lists for media. Built in one
 * place because Chromium keeps only the LAST value of a repeated switch: two
 * separate appendSwitch('enable-features', …) calls would silently drop the
 * first list.
 */
export function buildChromiumMediaSwitches(
    platform: string,
    capturerPref: ScreenCapturerPref,
    /** What 'auto' resolved to (decideAutoScreenCapturer); only 'dxgi' changes anything. */
    autoBackend: AutoCapturerDecision['backend'] = 'chromium-default',
): ChromiumMediaSwitches {
    const enableFeatures: string[] = [];
    const disableFeatures: string[] = [];
    if (platform === 'linux') {
        // See main.ts: routes Wayland capture through PipeWire and our picker.
        enableFeatures.push('WebRTCPipeWireCapturer');
    }
    if (platform === 'win32') {
        // Hardware H.264 for the profile LiveKit negotiates (see header).
        enableFeatures.push('PlatformH264CbpEncoding');
        // Explicitly overriding AllowWgcScreenCapturer either way wins over
        // Chromium's Win11-24H2 default (IsFeatureOverridden check).
        if (capturerPref === 'wgc') enableFeatures.push('AllowWgcScreenCapturer');
        if (capturerPref === 'dxgi' || (capturerPref === 'auto' && autoBackend === 'dxgi')) {
            disableFeatures.push('AllowWgcScreenCapturer');
        }
    }
    return { enableFeatures, disableFeatures };
}

// ── What "Automatic" means on Windows ───────────────────────────────────────
//
// Chromium 150 picks WGC for screens on Windows 11 24H2+ only because WGC's
// "0 Hz" mode hands over nothing when the screen is unchanged
// (desktop_capture_device.cc IsWgcEnabledForScreenCapture: "the Capture API
// returns empty frame when the captured content is unchanged, helping to
// maintain performance for 0Hz capture scenarios") — an idle-desktop
// efficiency choice, not a DXGI defect. For a game share it costs frame rate:
// on the owner's Win11 26200 box (RTX 2080 Ti + Radeon Pro WX 2100) a
// 2560×1440 grab takes ≈9.7 ms with WGC — Chromium's 2×-grab CPU rule then
// caps capture at ~52 fps — and 3.6 ms with DXGI (≥138 fps possible, 82–83
// measured before capture pacing).
//
// DXGI Desktop Duplication failure modes, and what Chromium does about them
// (webrtc modules/desktop_capture at Chromium 150's pin 1f975dfd):
//   • ANY DXGI failure falls back automatically: CreateRawScreenCapturer
//     wraps ScreenCapturerWinDirectx (itself behind a blank-frame detector)
//     in FallbackDesktopCapturerWrapper(dxgi, GDI). The fallback is GDI —
//     slow, but a share never dies. It is NOT WGC.
//   • Multi-adapter desktops: DxgiDuplicatorController creates one D3D11
//     device per adapter and duplicates each adapter's own outputs, skipping
//     adapters that fail — so NVIDIA + a second card (this machine) works.
//   • Hybrid laptops (NVIDIA Optimus / AMD switchable): when the process is
//     put on the discrete GPU but the panel hangs off the iGPU,
//     DuplicateOutput fails (DXGI_ERROR_UNSUPPORTED, Microsoft KB3019314) →
//     GDI. That is the one layout where WGC is the faster safe choice.
//   • HDR, protected (DRM) video, the secure desktop (UAC/lock): WGC has the
//     same class of limits (8-bit SDR capture, black protected regions,
//     access lost on the secure desktop) — no reason to prefer either.
//   • Chromium used DXGI for every Windows screen share before 24H2, on
//     every laptop and desktop, for years — it is the well-trodden path.
// Hence: DXGI unless the GPU layout is hybrid (or not known yet).

/**
 * The GPU layout seen on a previous launch, persisted because the capturer
 * switch must be appended BEFORE app.ready — before Chromium can tell us
 * anything about GPUs. Written after ready on every launch.
 */
export interface GpuTopologyHint {
    /** Chromium's own hybrid detection: auxAttributes.optimus || amdSwitchable. */
    hybrid: boolean;
    /** Vendor names, for the log and the overlay. */
    vendors: string[];
}

export const GPU_TOPOLOGY_FILENAME = 'gpu-topology.json';
export const GPU_TOPOLOGY_MAX_BYTES = 2 * 1024;

/** From app.getGPUInfo('basic'). null when it carries no GPU at all. */
export function gpuTopologyFromInfo(info: unknown): GpuTopologyHint | null {
    const gpus = summarizeGpuDevices(info);
    if (gpus.length === 0) return null;
    const aux = (info as { auxAttributes?: Record<string, unknown> } | null)?.auxAttributes ?? {};
    return {
        hybrid: aux.optimus === true || aux.amdSwitchable === true,
        vendors: gpus.map(g => g.vendor),
    };
}

/** Trust nothing read from disk: a malformed file is "unknown", never an error. */
export function parseGpuTopologyHint(text: string | null | undefined): GpuTopologyHint | null {
    if (!text || text.length > GPU_TOPOLOGY_MAX_BYTES) return null;
    try {
        const v = JSON.parse(text) as Record<string, unknown>;
        if (!v || typeof v !== 'object' || typeof v.hybrid !== 'boolean') return null;
        const vendors = Array.isArray(v.vendors)
            ? v.vendors.filter((x): x is string => typeof x === 'string').map(s => s.slice(0, 40)).slice(0, 8)
            : [];
        return { hybrid: v.hybrid, vendors };
    } catch {
        return null;
    }
}

export function serializeGpuTopologyHint(h: GpuTopologyHint): string {
    return JSON.stringify({ hybrid: h.hybrid, vendors: h.vendors.slice(0, 8) }) + '\n';
}

export interface AutoCapturerDecision {
    /** 'dxgi' = we disable AllowWgcScreenCapturer; 'chromium-default' = leave Chromium's choice. */
    backend: 'dxgi' | 'chromium-default';
    why: string;
}

/**
 * What Settings → Screen capture method → Automatic does. Only ever changes
 * Chromium's choice on Windows 11 24H2+ (where Chromium would pick WGC);
 * below that Chromium already uses DXGI.
 */
export function decideAutoScreenCapturer(opts: {
    platform: string;
    windowsBuild: number | null;
    gpu: GpuTopologyHint | null;
}): AutoCapturerDecision {
    if (opts.platform !== 'win32') return { backend: 'chromium-default', why: opts.platform };
    if (opts.windowsBuild === null) return { backend: 'chromium-default', why: 'Windows build unknown' };
    if (opts.windowsBuild < WIN11_24H2_BUILD) {
        return { backend: 'chromium-default', why: `auto: Windows build ${opts.windowsBuild} < 24H2` };
    }
    if (!opts.gpu) return { backend: 'chromium-default', why: 'auto: GPU layout not known yet (next launch)' };
    if (opts.gpu.hybrid) return { backend: 'chromium-default', why: 'auto: hybrid GPU — DXGI can fail there' };
    return { backend: 'dxgi', why: 'auto: DXGI (grabs ~2.7× faster than WGC)' };
}

/** How the captured display's refresh rate was found (shown in the overlay). */
export type DisplayHzSource = 'matched' | 'only-display' | 'primary';

export interface DisplayLike { id: number | string; displayFrequency?: number }

/**
 * Refresh rate of the display a share captures. A screen source carries its
 * display_id; match it against screen.getAllDisplays(). When that fails (no
 * display_id, or the source was not in the picker's cache — the Windows
 * "? Hz" report), fall back to the only display when there is one, else the
 * primary, and SAY it is a guess. A window share has no display id at all
 * (the picker offers no bounds), so it is always one of the fallbacks.
 * 0/missing displayFrequency (some Linux/virtual setups) is unknown, never a
 * limit.
 */
export function resolveCapturedDisplayHz(opts: {
    sourceKind: 'screen' | 'window' | 'unknown';
    displayId?: string | null;
    displays: readonly DisplayLike[];
    primaryId?: number | string | null;
}): { hz: number | null; how: DisplayHzSource | null } {
    const hzOf = (d: DisplayLike | undefined) =>
        d && typeof d.displayFrequency === 'number' && Number.isFinite(d.displayFrequency) && d.displayFrequency > 0
            ? d.displayFrequency : null;
    if (opts.sourceKind === 'screen' && opts.displayId) {
        const hz = hzOf(opts.displays.find(d => String(d.id) === opts.displayId));
        if (hz !== null) return { hz, how: 'matched' };
    }
    if (opts.sourceKind === 'unknown') return { hz: null, how: null };
    if (opts.displays.length === 1) {
        const hz = hzOf(opts.displays[0]);
        if (hz !== null) return { hz, how: 'only-display' };
    }
    if (opts.primaryId !== undefined && opts.primaryId !== null) {
        const hz = hzOf(opts.displays.find(d => String(d.id) === String(opts.primaryId)));
        if (hz !== null) return { hz, how: 'primary' };
    }
    return { hz: null, how: null };
}

export type CaptureBackend =
    | 'wgc'        // Windows.Graphics.Capture
    | 'dxgi'       // DXGI Desktop Duplication (GDI fallback)
    | 'pipewire'   // Linux Wayland via xdg-desktop-portal
    | 'x11'        // Linux X11 (XShm)
    | 'macos'      // ScreenCaptureKit / CGDisplayStream
    | 'unknown';

export interface ExpectedCapturer {
    backend: CaptureBackend;
    /** One short human reason, shown in the overlay. */
    why: string;
}

/**
 * Which OS capturer Chromium 150 will use for a source — derived from the
 * same inputs Chromium's own decision reads (see header). "Expected", not
 * observed: a capturer can still fail over at runtime (DXGI → GDI, WGC → the
 * next capturer). The capture log (captureLogSwitches) records the options
 * Chromium actually built.
 */
export function expectedScreenCapturer(opts: {
    platform: string;
    windowsBuild: number | null;
    pref: ScreenCapturerPref;
    sourceKind: 'screen' | 'window' | 'unknown';
    waylandSession?: boolean;
    /** Where a forced pref came from, for the one-line reason. Default 'env'. */
    prefSource?: 'env' | 'settings';
    /** What 'auto' was resolved to at startup (decideAutoScreenCapturer). */
    auto?: AutoCapturerDecision;
}): ExpectedCapturer {
    const { platform, windowsBuild, pref, sourceKind } = opts;
    const forced = (p: 'wgc' | 'dxgi'): string => opts.prefSource === 'settings'
        ? 'forced (Settings → Advanced)'
        : `forced (CIPHERLINE_SCREEN_CAPTURER=${p})`;
    if (platform === 'win32') {
        if (sourceKind === 'window') return { backend: 'wgc', why: 'window sources always use WGC' };
        if (pref === 'wgc') return { backend: 'wgc', why: forced('wgc') };
        if (pref === 'dxgi') return { backend: 'dxgi', why: forced('dxgi') };
        if (opts.auto?.backend === 'dxgi') return { backend: 'dxgi', why: opts.auto.why };
        if (opts.auto && windowsBuild !== null && windowsBuild >= WIN11_24H2_BUILD) {
            // Automatic left Chromium's WGC in place — say why.
            return { backend: 'wgc', why: opts.auto.why };
        }
        if (windowsBuild === null) return { backend: 'unknown', why: 'Windows build unknown' };
        return windowsBuild >= WIN11_24H2_BUILD
            ? { backend: 'wgc', why: `auto: Windows build ${windowsBuild} ≥ 24H2` }
            : { backend: 'dxgi', why: `auto: Windows build ${windowsBuild} < 24H2` };
    }
    if (platform === 'linux') {
        return opts.waylandSession
            ? { backend: 'pipewire', why: 'Wayland session' }
            : { backend: 'x11', why: 'X11 session' };
    }
    if (platform === 'darwin') return { backend: 'macos', why: 'macOS' };
    return { backend: 'unknown', why: platform };
}

/**
 * Switches for the opt-in capture-timing log: Chromium's own per-frame
 * `last_capture_duration` / `capture_period` lines (VLOG 2 in
 * desktop_capture_device.cc) plus the one-off capturer options line, written
 * to `logFile`. Empty unless enabled.
 *
 * Enabled from Settings → Advanced (startup-flags.json, any build) or, in an
 * unpackaged build only, CIPHERLINE_CAPTURE_LOG=1 — see ./startup-flags.ts,
 * which also bounds the file's size and deletes it when the log is off.
 *
 * ── Keeping the file to frame timings ──────────────────────────────────────
 * `enable-logging=file` on its own turns on Chromium's GENERAL logging into
 * that file at INFO and above — including every renderer console message
 * with its source URL (`INFO:CONSOLE ... source: <url>`). A packaged build has
 * no business writing that to disk. `log-level=3` (FATAL-only — the same
 * minimum main.ts sets when the log is off) removes all of it, while
 * `--vmodule` VLOGs do not go through the minimum-severity check and still
 * land. Measured with this exact Electron (43.2.0) capturing an Xvfb screen
 * through getDisplayMedia, 2026-09-29:
 *   - no log-level: the file carried the page's console.log text and its
 *     file:// URL, plus Electron's own WARNING lines;
 *   - log-level=3 + vmodule=desktop_capture_device=2: 834 lines, EVERY one a
 *     VERBOSE line from desktop_capture_device.cc (CaptureFrame,
 *     OnCaptureResult [SUCCESS] / output_size, last_capture_duration,
 *     capture_period, delta_ms/frame_rate, Create(source=screen:N:N),
 *     AllocateAndStart) — no console output, no URLs.
 * `media_stream_manager=1` additionally logs capture-device setup including
 * `device.name = …`, which for a WINDOW share is that window's title — so it
 * is added only in unpackaged (dev) builds. parseCaptureTimingLog needs none
 * of it.
 */
export function captureLogSwitches(
    enabled: boolean,
    logFile: string | null,
    opts: { packaged: boolean } = { packaged: true },
): Array<[string, string]> {
    if (!enabled || !logFile) return [];
    return [
        ['enable-logging', 'file'],
        ['log-file', logFile],
        // FATAL-only for ordinary LOG()/console lines — see above.
        ['log-level', '3'],
        // desktop_capture_device=2: per-frame timing; =1 also gets the
        // AllocateAndStart line (requested fps) and the Windows capturer
        // options line. media_stream_manager=1 (dev only, see above) carries
        // the capture device's own OnLog messages (WebRTC capturer creation).
        ['vmodule', opts.packaged ? 'desktop_capture_device=2' : 'desktop_capture_device=2,media_stream_manager=1'],
    ];
}

export interface CaptureTiming {
    /** Frames in the summarised window. */
    samples: number;
    /** MEAN wall time of one grab+convert, ms, 1 decimal. Chromium logs whole
     *  ms rounded DOWN, so this reads up to ~0.5 ms low. Mean, not median:
     *  the delivered rate is 1000 / mean period, and the long outliers a
     *  median hides are exactly the frames that cost the rate. */
    captureMs: number;
    /** MEAN scheduled period between grabs, ms, 1 decimal. */
    periodMs: number;
    /** 1000 / periodMs — how many grabs per second the scheduler actually made. */
    pollFps: number;
    /** Share of polls that found no new frame (0 Hz skip: content not changing, or the capturer had nothing new). */
    unchangedRatio: number;
    /** From the most recent AllocateAndStart line, if still in the window. */
    requestedFps?: number;
    maxCpuPercent?: number;
    /** From the Windows capturer-options line, if present. */
    wgcScreenAllowed?: boolean;
    /** MEAN measured time between grabs (CaptureFrame's own `delta_ms`), ms.
     *  Differs from periodMs when the scheduling timer fires late — on
     *  Windows 1–2 ms every frame (owner's DXGI log: period 11, delta
     *  11.3–13.1 → ~83 fps from a 90 request). Absent in logs without it. */
    intervalMs?: number;
}

const mean1 = (xs: number[]): number => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

/**
 * Summarise the tail of the capture log. Only lines AFTER the most recent
 * capture start are used, so a previous share in the same log does not
 * pollute the numbers. `window` bounds it to the newest N frames.
 */
export function parseCaptureTimingLog(text: string, window = 300): CaptureTiming | null {
    const lines = text.split('\n');
    let start = 0;
    let requestedFps: number | undefined;
    let maxCpuPercent: number | undefined;
    let wgcScreenAllowed: boolean | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /AllocateAndStart \(requested_frame_rate=([\d.]+).*max_cpu_consumption_percentage=(\d+)/.exec(lines[i]);
        if (m) {
            start = i + 1;
            requestedFps = Number(m[1]);
            maxCpuPercent = Number(m[2]);
            break;
        }
    }
    // The options line is logged by Create(), just BEFORE AllocateAndStart.
    for (let i = start - 1; i >= 0 && i >= start - 400; i--) {
        const m = /allow_wgc_screen_capturer: (\d)/.exec(lines[i]);
        if (m) { wgcScreenAllowed = m[1] === '1'; break; }
    }
    const durations: number[] = [];
    const periods: number[] = [];
    const deltas: number[] = [];
    let results = 0;
    let unchanged = 0;
    for (let i = start; i < lines.length; i++) {
        const l = lines[i];
        let m: RegExpExecArray | null;
        if ((m = /last_capture_duration=(\d+)/.exec(l))) durations.push(Number(m[1]));
        else if ((m = /\scapture_period=(\d+)/.exec(l))) periods.push(Number(m[1]));
        else if ((m = /\sdelta_ms=([\d.]+)/.exec(l))) deltas.push(Number(m[1]));
        else if (/OnCaptureResult \[SUCCESS\]/.test(l) && !/\[RRF\]/.test(l)) {
            results++;
            if (/\[0Hz\]/.test(l)) unchanged++;
        }
    }
    const d = durations.slice(-window);
    const p = periods.slice(-window);
    if (d.length < 10 || p.length < 10) return null;
    const periodMs = mean1(p);
    const dl = deltas.slice(-window).filter(x => Number.isFinite(x) && x > 0);
    return {
        ...(dl.length >= 10 ? { intervalMs: mean1(dl) } : {}),
        samples: Math.min(d.length, p.length),
        captureMs: mean1(d),
        periodMs,
        pollFps: periodMs > 0 ? 1000 / periodMs : 0,
        unchangedRatio: results > 0 ? unchanged / results : 0,
        requestedFps,
        maxCpuPercent,
        wgcScreenAllowed,
    };
}

const GPU_VENDORS: Record<number, string> = {
    0x10de: 'NVIDIA',
    0x1002: 'AMD',
    0x1022: 'AMD',
    0x8086: 'Intel',
    0x5143: 'Qualcomm',
    0x4d4f4351: 'Qualcomm',
    0x106b: 'Apple',
    0x1414: 'Microsoft (software)',
};

export interface GpuDeviceSummary {
    vendor: string;
    vendorId: number;
    deviceId: number;
    /** Adapter name when Chromium's basic info carries one (Windows usually does). */
    name?: string;
    active: boolean;
}

/**
 * Names-and-ids-only view of `app.getGPUInfo('basic').gpuDevice`. Driver
 * strings, LUIDs and everything else are dropped: the overlay needs to know
 * WHICH vendor's encoder Chromium can reach, nothing more.
 */
export function summarizeGpuDevices(info: unknown): GpuDeviceSummary[] {
    const list = (info as { gpuDevice?: unknown } | null)?.gpuDevice;
    if (!Array.isArray(list)) return [];
    const out: GpuDeviceSummary[] = [];
    for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        const r = d as Record<string, unknown>;
        const vendorId = typeof r.vendorId === 'number' ? r.vendorId : 0;
        const deviceId = typeof r.deviceId === 'number' ? r.deviceId : 0;
        if (!vendorId && !deviceId) continue;
        const name = typeof r.deviceString === 'string' && r.deviceString.trim()
            ? r.deviceString.trim().slice(0, 80)
            : undefined;
        out.push({
            vendor: GPU_VENDORS[vendorId] ?? `0x${vendorId.toString(16)}`,
            vendorId,
            deviceId,
            name,
            active: r.active === true,
        });
    }
    return out;
}
