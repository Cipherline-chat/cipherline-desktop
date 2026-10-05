import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    FlaskConical, AlertTriangle, ClipboardList, Copy, Trash2,
    RefreshCw, CheckCircle2, AlertCircle, Download, MonitorUp, Activity, LockOpen,
} from 'lucide-react';
import { APP_VERSION, BUILD_COMMIT } from '../constants';
import { counts as diagnosticCounts, clear as clearDiagnostics, formatReport } from '../utils/deliveryDiagnostics';
import { fetchFreezeLog, clearFreezeLog, formatFreezeReport, isStall, LONG_TASK_MS, type FreezeEntry } from '../utils/freezeLog';
import { useUpdate } from '../contexts/UpdateContext';
import { ClButton, ClToggle, ClModal, ClConfirm } from './cl';
import { StagingPasswordForm } from './StagingPasswordForm';
import { isStagingLockedError, type StagingLockStatusLike } from '../utils/stagingLock';
import {
    useStreamStatsHudEnabled, setStreamStatsHudEnabled,
    useScreenShareCodecPref, setScreenShareCodecPref,
} from '../utils/streamDiagnosticsPrefs';
import type { ScreenShareCodecPref } from '../utils/screenShare';
import {
    parseStartupFlagsState, restartPending,
    type StartupFlagsState, type StartupFlagValues, type ScreenCapturerChoice,
} from '../utils/startupFlags';
import {
    beginCheck, observeUpdaterState, settleCheck, failCheck, dismissResult, describeManualCheck,
    SETTLE_GRACE_MS, CHECK_TIMEOUT_MS, RESULT_LINGER_MS,
    type ManualCheckState,
} from '../utils/manualUpdateCheck';

/**
 * Settings → Advanced
 *
 * The headline setting is the **update channel**:
 *   - "Stable" (default) — fetches latest.yml / latest-mac.yml. What real
 *     users get on every push to main.
 *   - "Staging"           — fetches staging.yml / staging-mac.yml. Pre-release
 *     builds from the `staging` branch. Useful for testing release candidates
 *     end-to-end against a packaged installer before they ship to everyone.
 *
 * Switching channels writes to secureStore via the `updater:set-channel` IPC
 * (defined in main.ts) and triggers an immediate update check on the new
 * channel. If a different version is available the auto-updater downloads
 * and installs on next quit, identical to a normal update.
 *
 * This page is intentionally hidden behind an "Advanced" tab — most users
 * should stick with Stable. Surfacing the toggle lets internal testers opt
 * in without rebuilding the app or fiddling with command-line flags.
 *
 * The "This build" card below also carries the manual **Check for updates**
 * control (CheckForUpdatesRow). Note that channel-switching triggering a check
 * is a SIDE EFFECT of switching streams, not an update-check mechanism — it
 * used to be the only way to force one, which is exactly the confusion that
 * row exists to end.
 */
export const AdvancedSettings: React.FC = () => {
    const [channel, setChannel] = useState<'latest' | 'staging' | null>(null);
    const [saving, setSaving] = useState(false);
    // Staging lock (electron/staging-lock.ts). Main owns it: it verifies the
    // password, remembers the unlock, and refuses the staging channel while
    // locked. Here we only decide WHEN to ask, and ask once — after that the
    // device stays unlocked and the toggle never prompts again.
    const [lock, setLock] = useState<StagingLockStatusLike | null>(null);
    const [promptOpen, setPromptOpen] = useState(false);
    const [confirmRelock, setConfirmRelock] = useState(false);
    const [relocking, setRelocking] = useState(false);

    const refreshLock = useCallback(async (): Promise<StagingLockStatusLike | null> => {
        const api = window.electronAPI;
        if (!api?.getStagingLockStatus) return null;
        try {
            const s = await api.getStagingLockStatus();
            setLock(s);
            return s;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => {
        const api = window.electronAPI;
        void refreshLock();
        if (!api?.getUpdateChannel) {
            // Browser preview / dev-server case where the bridge isn't wired.
            setChannel('latest');
            return;
        }
        api.getUpdateChannel().then(setChannel).catch(() => setChannel('latest'));
    }, [refreshLock]);

    const applyChannel = async (next: 'latest' | 'staging') => {
        const api = window.electronAPI;
        if (!api?.setUpdateChannel) {
            setChannel(next);
            return;
        }
        setSaving(true);
        try {
            const applied = await api.setUpdateChannel(next);
            setChannel(applied);
        } catch (e) {
            // Main refused: this device is not unlocked (e.g. it was re-locked
            // from elsewhere since we last asked). Ask for the password.
            if (isStagingLockedError(e)) {
                await refreshLock();
                setPromptOpen(true);
            } else {
                console.error('[AdvancedSettings] could not change the update channel', e);
            }
        } finally {
            setSaving(false);
        }
    };

    const change = async (next: 'latest' | 'staging') => {
        if (saving || channel === next) return;
        // Choosing Stable never asks. Choosing Staging asks only while locked.
        if (next === 'staging' && lock?.enforced && !lock.unlocked) {
            setPromptOpen(true);
            return;
        }
        await applyChannel(next);
    };

    const onPromptUnlocked = async () => {
        setPromptOpen(false);
        await refreshLock();
        await applyChannel('staging');
    };

    const relock = async () => {
        const api = window.electronAPI;
        if (!api?.relockStaging) return;
        setRelocking(true);
        try {
            const s = await api.relockStaging();
            setLock(s);
            setConfirmRelock(false);
            // A staging build must lock right now, not only on next launch.
            if (s.isStagingBuild) { window.location.reload(); return; }
            const ch = await api.getUpdateChannel?.();
            if (ch) setChannel(ch);
        } catch (e) {
            console.error('[AdvancedSettings] could not re-lock staging access', e);
        } finally {
            setRelocking(false);
        }
    };

    return (
        <>
            <div className="sd-card">
                <div className="flex items-center gap-3">
                    <span className="sd-tile"><FlaskConical size={16} /></span>
                    <div>
                        <h3 style={{ margin: 0 }}>Update channel</h3>
                        <p className="sd-sub" style={{ margin: 0 }}>Which release stream this client follows. Most people belong on Stable.</p>
                    </div>
                </div>

                <div className="sd-opts mt-4">
                    <ChannelCard
                        active={channel === 'latest'}
                        disabled={saving}
                        onClick={() => change('latest')}
                        title="Stable"
                        description="Default. What real users see. Updated on every push to main."
                    />
                    <ChannelCard
                        active={channel === 'staging'}
                        disabled={saving}
                        onClick={() => change('staging')}
                        title="Staging"
                        description="Pre-release builds from the staging branch. Opt in to test before shipping."
                    />
                </div>

                {channel === 'staging' && (
                    <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(255,201,77,.08)', border: '1px solid rgba(255,201,77,.2)' }}>
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--cl-glow)' }} />
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--cl-glow)' }}>
                            You'll receive pre-release builds. To go back to stable updates,
                            switch to <strong>Stable</strong> here — the next stable release
                            will replace your staging build automatically.
                        </p>
                    </div>
                )}

                {lock?.enforced && lock.unlocked && (
                    <div className="mt-3 flex items-center gap-2" style={{ fontSize: 12, color: 'var(--cl-faint)' }}>
                        <LockOpen size={13} className="shrink-0" />
                        <span style={{ flex: 1 }}>Staging access unlocked on this device</span>
                        <ClButton variant="ghost" size="sm" disabled={relocking} onClick={() => setConfirmRelock(true)}>
                            Lock again
                        </ClButton>
                    </div>
                )}
            </div>

            <ClModal open={promptOpen} onClose={() => setPromptOpen(false)} width={400} label="Unlock staging builds">
                <h4>Unlock staging builds</h4>
                <p>
                    Staging builds are for testers. Enter the staging password once and this
                    device will remember it.
                </p>
                {promptOpen && (
                    <StagingPasswordForm
                        onUnlocked={() => { void onPromptUnlocked(); }}
                        initialRetryAfterMs={lock?.retryAfterMs ?? 0}
                        submitLabel="Unlock"
                        secondary={
                            <ClButton variant="ghost" onClick={() => setPromptOpen(false)}>Cancel</ClButton>
                        }
                    />
                )}
            </ClModal>

            <ClConfirm
                open={confirmRelock}
                onClose={() => setConfirmRelock(false)}
                onConfirm={() => { void relock(); }}
                loading={relocking}
                title="Lock staging access again?"
                message={
                    lock?.isStagingBuild
                        ? 'This is a staging build, so it will lock right away and ask for the staging password. Your update channel goes back to Stable.'
                        : channel === 'staging'
                            ? 'This device will forget the staging password and switch back to the Stable channel.'
                            : 'This device will forget the staging password. Switching to Staging will ask for it again.'
                }
                confirmLabel="Lock again"
            />

            <StreamDiagnosticsCard />

            <DeliveryDiagnosticsCard />
            <PerformanceLogCard />

            <div className="sd-card">
                <h3>This build</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <div className="sd-rl">
                        <b>App version</b>
                        <span>Auto-updates in the background; installs on next quit.</span>
                    </div>
                    <div className="sd-rc">
                        <span className="sd-mono" style={{ fontSize: 12.5, color: 'var(--cl-muted)' }}>v{APP_VERSION}</span>
                    </div>
                </div>
                {/* The commit the running bundle was actually compiled from.
                    Deliberately next to the version: the version alone can't
                    tell you WHICH build you're on, and during development the
                    dev stack can silently serve a different worktree's code
                    entirely (CLAUDE.md, "Concurrent sessions & worktrees").
                    Click-to-copy so it can be pasted straight into a bug
                    report. */}
                <div className="sd-row">
                    <div className="sd-rl">
                        <b>Source commit</b>
                        <span>The exact code this build was compiled from. Handy in bug reports.</span>
                    </div>
                    <div className="sd-rc">
                        <BuildCommit />
                    </div>
                </div>
                <CheckForUpdatesRow />
            </div>
        </>
    );
};

const CODEC_OPTIONS: { value: ScreenShareCodecPref; title: string; description: string }[] = [
    { value: 'auto', title: 'Auto', description: 'Recommended. Uses your GPU’s hardware encoder when it has one (H.264 on almost every GPU — High profile on NVIDIA), otherwise the cheapest software encoder.' },
    { value: 'h264', title: 'H.264', description: 'Hardware-encoded on NVIDIA, AMD and Intel GPUs (in the profile your GPU encodes). Needs more bandwidth for the same picture.' },
    { value: 'vp9', title: 'VP9', description: 'Best picture per bit, but only Intel GPUs encode it in hardware — elsewhere it is software and CPU-heavy.' },
    { value: 'vp8', title: 'VP8', description: 'Software encoder that keeps up best without a GPU encoder.' },
];

/**
 * Screen share & stream diagnostics — the stats overlay and the codec
 * override. Both exist so a frame-rate problem can be located and A/B tested
 * on the machine that has it; see utils/streamDiagnosticsPrefs.ts.
 */
const StreamDiagnosticsCard: React.FC = () => {
    const hud = useStreamStatsHudEnabled();
    const codec = useScreenShareCodecPref();
    return (
        <div className="sd-card">
            <div className="flex items-center gap-3">
                <span className="sd-tile"><MonitorUp size={16} /></span>
                <div>
                    <h3 style={{ margin: 0 }}>Screen share &amp; stream stats</h3>
                    <p className="sd-sub" style={{ margin: 0 }}>For testing call video quality on this device. Not included in backups.</p>
                </div>
            </div>

            <div className="sd-row mt-3" style={{ borderTop: 'none' }}>
                <div className="sd-rl">
                    <b>Show stream stats</b>
                    <span>
                        Live overlay on focused and grid video: capture, encode and decode frame rate and
                        resolution, encoder (hardware or software), bitrate, and what is limiting quality.
                    </span>
                </div>
                <div className="sd-rc">
                    <ClToggle checked={hud} onChange={setStreamStatsHudEnabled} />
                </div>
            </div>

            <div className="sd-row">
                <div className="sd-rl">
                    <b>Screen share encoder</b>
                    <span>Applies to the next screen share you start.</span>
                </div>
            </div>
            <div className="sd-opts mt-2" role="radiogroup" aria-label="Screen share encoder">
                {CODEC_OPTIONS.map(o => (
                    <ChannelCard
                        key={o.value}
                        active={codec === o.value}
                        disabled={false}
                        onClick={() => setScreenShareCodecPref(o.value)}
                        title={o.title}
                        description={o.description}
                    />
                ))}
            </div>

            <CaptureStartupSettings />
        </div>
    );
};

const CAPTURER_OPTIONS: { value: ScreenCapturerChoice; title: string; description: string }[] = [
    { value: 'auto', title: 'Automatic', description: 'Recommended. DXGI — the faster grab — except on hybrid-GPU laptops, where Windows Graphics Capture is the safe choice. Takes effect from the second launch, once the GPU layout is known.' },
    { value: 'dxgi', title: 'DXGI (Desktop Duplication)', description: 'The long-standing capturer. Try it if a screen share stutters or tops out at a low frame rate.' },
    { value: 'wgc', title: 'Windows Graphics Capture', description: 'The newer capturer. Only hands over a frame when something on screen changed.' },
];

const mib = (bytes: number | null): string => (bytes ? `${Math.round(bytes / (1024 * 1024))} MB` : 'a few MB');

/**
 * Screen capture method + capture timing log. Both are Chromium command-line
 * switches, so they apply on the NEXT launch: main stores them in
 * <userData>/startup-flags.json (the one source of truth — see
 * utils/startupFlags.ts and electron/startup-flags.ts) and this row offers the
 * restart. Renders nothing when the main process predates the IPC.
 */
const CaptureStartupSettings: React.FC = () => {
    const [state, setState] = useState<StartupFlagsState | null>(null);
    const [saving, setSaving] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const api = window.electronAPI;
        if (!api?.getStartupFlags) return;
        let live = true;
        api.getStartupFlags()
            .then(v => { if (live) setState(parseStartupFlagsState(v)); })
            .catch(() => { /* leave the rows hidden */ });
        return () => { live = false; };
    }, []);

    if (!state) return null;

    const save = async (patch: Partial<StartupFlagValues>) => {
        const api = window.electronAPI;
        if (!api?.setStartupFlags || saving) return;
        setSaving(true);
        setError(null);
        try {
            const next = parseStartupFlagsState(await api.setStartupFlags(patch));
            if (next) setState(next);
        } catch (err) {
            console.warn('[AdvancedSettings] setStartupFlags failed:', err);
            setError('Could not save this setting.');
        } finally {
            setSaving(false);
        }
    };

    const restart = async () => {
        const api = window.electronAPI;
        if (!api?.relaunchApp) {
            setError('Restart isn’t available in this build — quit and reopen Cipherline.');
            return;
        }
        setRestarting(true);
        setError(null);
        try {
            await api.relaunchApp();
        } catch (err) {
            console.warn('[AdvancedSettings] relaunchApp failed:', err);
            setRestarting(false);
            setError('Could not restart automatically — quit and reopen Cipherline.');
        }
    };

    const isWindows = state.platform === 'win32';
    const pending = restartPending(state);

    return (
        <>
            {isWindows && (
                <>
                    <div className="sd-row">
                        <div className="sd-rl">
                            <b>Screen capture method</b>
                            <span>
                                How Windows hands your screen to Cipherline when you share it. Takes effect after a restart.
                                {state.envOverride.screenCapturer && (
                                    <> This launch is using <code className="sd-mono">CIPHERLINE_SCREEN_CAPTURER={state.active.screenCapturer}</code>, which overrides this setting.</>
                                )}
                            </span>
                        </div>
                    </div>
                    <div className="sd-opts mt-2" role="radiogroup" aria-label="Screen capture method">
                        {CAPTURER_OPTIONS.map(o => (
                            <ChannelCard
                                key={o.value}
                                active={state.saved.screenCapturer === o.value}
                                disabled={saving}
                                onClick={() => { if (state.saved.screenCapturer !== o.value) void save({ screenCapturer: o.value }); }}
                                title={o.title}
                                description={o.description}
                            />
                        ))}
                    </div>
                </>
            )}

            <div className="sd-row">
                <div className="sd-rl">
                    <b>Capture timing log (for troubleshooting)</b>
                    <span>
                        Records how long each screen-capture frame takes, for the stream-stats overlay’s grab row.
                        Frame timings and sizes only — nothing you share, say or type. Kept in Cipherline’s app data folder
                        {state.captureLogPath && <> (<code className="sd-mono" style={{ wordBreak: 'break-all' }}>{state.captureLogPath}</code>)</>},
                        capped at {mib(state.captureLogMaxBytes)}, and deleted when this is off. Takes effect after a restart.
                        {state.envOverride.captureLog && (
                            <> This launch is using <code className="sd-mono">CIPHERLINE_CAPTURE_LOG</code>, which overrides this setting.</>
                        )}
                    </span>
                </div>
                <div className="sd-rc">
                    <ClToggle
                        checked={state.saved.captureLog}
                        disabled={saving}
                        onChange={v => { void save({ captureLog: v }); }}
                        aria-label="Capture timing log"
                    />
                </div>
            </div>

            {pending && (
                <div className="mt-3 flex items-center gap-2.5 px-3 py-2.5 rounded-xl" role="status" style={{ background: 'rgba(255,201,77,.08)', border: '1px solid rgba(255,201,77,.2)' }}>
                    <RefreshCw size={14} className="shrink-0" style={{ color: 'var(--cl-glow)' }} aria-hidden />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--cl-glow)', flex: 1, margin: 0 }}>
                        Restart Cipherline to apply.
                    </p>
                    <ClButton size="sm" variant="primary" loading={restarting} disabled={restarting} onClick={restart}>
                        Restart
                    </ClButton>
                </div>
            )}

            {error && (
                <p className="text-xs mt-2" role="alert" style={{ color: 'var(--cl-danger)', margin: 0 }}>{error}</p>
            )}
        </>
    );
};

/** Status-line colour and glyph per tone. Kept next to the row rather than in
 *  manualUpdateCheck.ts so that module stays pure presentation-free logic. */
const TONE_COLOR: Record<string, string> = {
    neutral: 'var(--cl-muted)',
    busy: 'var(--cl-muted)',
    ok: 'var(--cl-ok)',
    info: 'var(--cl-lume)',
    error: 'var(--cl-danger)',
};

/**
 * "Check for updates" — the manual counterpart to main.ts's startup + 4-hourly
 * background check. See src/utils/manualUpdateCheck.ts for the state machine
 * and why this exists (a support loop where nobody could tell whether the
 * running build predated the fix, and the only way to force a check was
 * toggling the update channel back and forth).
 *
 * The result is READ OFF the existing updater state stream (UpdateContext,
 * seeded from `updater:get-state`) rather than from a second source of truth:
 * `checkForUpdates()` resolves whether or not it found anything, so the honest
 * signal is whether the shared updater state left `idle` while we were asking.
 */
const CheckForUpdatesRow: React.FC = () => {
    const { state: updater, checkNow } = useUpdate();
    const [check, setCheck] = useState<ManualCheckState>({ kind: 'idle' });

    // The updater state is consulted at settle time — a second after the click
    // — so it can't come from the closure the click handler captured. A ref
    // written from an effect keeps the latest without re-creating the handler.
    const updaterRef = useRef(updater);
    useEffect(() => { updaterRef.current = updater; }, [updater]);

    // Every timer this row schedules, so a re-check (or unmount mid-check)
    // can't leave an older one behind to overwrite the newer result.
    const timers = useRef<number[]>([]);
    const clearTimers = useCallback(() => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
    }, []);
    useEffect(() => clearTimers, [clearTimers]);
    const later = useCallback((fn: () => void, ms: number) => {
        timers.current.push(window.setTimeout(fn, ms));
    }, []);

    // Belt-and-braces against a double-fire (the button is disabled while
    // busy, but a stacked check would strand the first one's timers).
    const inFlight = useRef(false);

    const run = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        clearTimers();
        setCheck(beginCheck);

        // Nothing came back at all — report that, never "you're up to date":
        // a hung request is not evidence there's no update.
        later(() => {
            setCheck(prev => failCheck(prev, new Error('The update check timed out.')));
            later(() => setCheck(dismissResult), RESULT_LINGER_MS);
        }, CHECK_TIMEOUT_MS);

        let dispatched = false;
        try {
            dispatched = await checkNow();
        } catch (err) {
            inFlight.current = false;
            clearTimers();
            setCheck(prev => failCheck(prev, err));
            later(() => setCheck(dismissResult), RESULT_LINGER_MS);
            return;
        }
        // Give the `update:state` push a beat to land — it and this IPC reply
        // are separate messages, and concluding "up to date" the instant the
        // reply arrives would race one already on its way.
        later(() => {
            inFlight.current = false;
            setCheck(prev => settleCheck(prev, dispatched, updaterRef.current));
            later(() => setCheck(dismissResult), RESULT_LINGER_MS);
        }, SETTLE_GRACE_MS);
    }, [checkNow, clearTimers, later]);

    // Derived at render rather than pushed from an effect: a live updater
    // transition arriving mid-check IS the answer, so folding it in here keeps
    // one source of truth and no duplicated state.
    const effective = observeUpdaterState(check, updater);
    const { label, detail, tone, busy } = describeManualCheck(effective);
    const ToneIcon = tone === 'ok' ? CheckCircle2 : tone === 'error' ? AlertCircle : tone === 'info' ? Download : null;

    return (
        <div className="sd-row">
            <div className="sd-rl">
                <b>Check for updates</b>
                <span>
                    Cipherline checks on its own at startup and every few hours. Ask now if you're
                    waiting on a specific fix.
                </span>
                {/* Always mounted so the live region exists before it changes —
                    a region created at the same moment as its content is
                    unreliably announced. */}
                <span
                    role="status"
                    aria-live="polite"
                    style={{
                        display: detail ? 'flex' : 'none',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 6,
                        color: TONE_COLOR[tone] ?? 'var(--cl-muted)',
                    }}
                >
                    {ToneIcon && <ToneIcon size={13} className="shrink-0" aria-hidden />}
                    {detail}
                </span>
            </div>
            <div className="sd-rc">
                <ClButton size="sm" variant="ghost" disabled={busy} onClick={run}>
                    <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} /> {label}
                </ClButton>
            </div>
        </div>
    );
};

/**
 * The build's source commit, click-to-copy.
 *
 * Rendered even when it's 'unknown' (a build made without git available)
 * rather than hidden: "we don't know" is itself the answer to "which code is
 * this?", and a row that silently disappears would just recreate the guessing
 * this is meant to end.
 */
const BuildCommit: React.FC = () => {
    const [copied, setCopied] = useState(false);
    const known = BUILD_COMMIT !== 'unknown';

    const copy = async () => {
        if (!known) return;
        try {
            await navigator.clipboard.writeText(BUILD_COMMIT);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access denied — the value is on screen either way.
        }
    };

    return (
        <button
            type="button"
            onClick={copy}
            title={known ? 'Copy commit' : 'This build was compiled without git metadata'}
            className="sd-mono"
            style={{
                fontSize: 12.5,
                color: 'var(--cl-muted)',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: known ? 'pointer' : 'default',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
            }}
        >
            {copied ? 'Copied' : BUILD_COMMIT}
            {known && !copied && <Copy size={12} aria-hidden />}
        </button>
    );
};

/**
 * Delivery diagnostics — a session-local, non-persisted record of message and
 * channel-key delivery failures (see src/utils/deliveryDiagnostics.ts). Every
 * one of these failure paths used to end in a bare console line, gone the
 * moment DevTools wasn't open — this card is the first place any of it is
 * actually visible without opening the console.
 */
const DeliveryDiagnosticsCard: React.FC = () => {
    const [summary, setSummary] = useState<Record<string, number>>({});
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read must happen before the poll interval starts
        setSummary(diagnosticCounts());
        const id = setInterval(() => setSummary(diagnosticCounts()), 3000);
        return () => clearInterval(id);
    }, []);

    const total = Object.values(summary).reduce((a, b) => a + b, 0);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(formatReport());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access denied — nothing more we can do here.
        }
    };

    return (
        <div className="sd-card">
            <div className="flex items-center gap-3">
                <span className="sd-tile"><ClipboardList size={16} /></span>
                <div>
                    <h3 style={{ margin: 0 }}>Delivery diagnostics</h3>
                    <p className="sd-sub" style={{ margin: 0 }}>
                        Message and channel-key delivery failures recorded this session. Not saved to disk.
                    </p>
                </div>
            </div>

            {total === 0 ? (
                <p className="sd-sub mt-4" style={{ margin: 0 }}>No delivery failures recorded this session.</p>
            ) : (
                <div className="mt-4 flex flex-col gap-1.5">
                    {Object.entries(summary).sort((a, b) => b[1] - a[1]).map(([key, n]) => (
                        <div key={key} className="sd-row" style={{ borderTop: 'none', padding: '2px 0' }}>
                            <span className="sd-mono" style={{ fontSize: 12.5, color: 'var(--cl-muted)' }}>{key}</span>
                            <span className="sd-mono" style={{ fontSize: 12.5 }}>{n}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex gap-2 mt-4">
                <button type="button" className="sd-opt" style={{ flex: 1, cursor: total === 0 ? 'default' : 'pointer' }} disabled={total === 0} onClick={copy}>
                    <span className="sd-opt-head"><Copy size={13} /><b>{copied ? 'Copied' : 'Copy report'}</b></span>
                </button>
                <button type="button" className="sd-opt" style={{ flex: 1, cursor: total === 0 ? 'default' : 'pointer' }} disabled={total === 0} onClick={() => { clearDiagnostics(); setSummary({}); }}>
                    <span className="sd-opt-head"><Trash2 size={13} /><b>Clear</b></span>
                </button>
            </div>
        </div>
    );
};

/**
 * Performance log — the freeze diagnostic. Every moment the app stopped
 * responding for LONG_TASK_MS or more this session: renderer long tasks and
 * main-process stalls, each with the activity that was running (see
 * utils/freezeLog.ts and electron/freeze-monitor.ts). Timestamps, durations
 * and static phase names only — no message content, ids or names — so the
 * copied report is safe to paste into a bug report.
 */
const PerformanceLogCard: React.FC = () => {
    const [rows, setRows] = useState<FreezeEntry[]>([]);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let live = true;
        const load = () => { void fetchFreezeLog().then(r => { if (live) setRows(r); }); };
        load();
        const id = setInterval(load, 3000);
        return () => { live = false; clearInterval(id); };
    }, []);

    const stalls = rows.filter(isStall);
    const worst = stalls.reduce((m, r) => Math.max(m, r.ms), 0);
    const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';
    // "Run a 60-second freeze capture": main logs stalls from 100 ms and
    // per-process CPU/memory every 2 s, so a freeze you can make happen on
    // purpose (restore the window, open a channel) gets caught in detail.
    const captureApi = typeof window !== 'undefined' ? window.electronAPI?.perfStartCapture : undefined;
    const [captureLeft, setCaptureLeft] = useState(0);
    useEffect(() => {
        if (captureLeft <= 0) return;
        const id = setTimeout(() => setCaptureLeft(s => Math.max(0, s - 1)), 1000);
        return () => clearTimeout(id);
    }, [captureLeft]);
    const startCapture = () => {
        if (!captureApi || captureLeft > 0) return;
        void captureApi(60_000).then(() => setCaptureLeft(60)).catch(() => { /* older build */ });
    };
    const rowLabel = (r: FreezeEntry) => r.source === 'main' ? 'main' : r.source === 'renderer' ? 'ui' : r.source === 'event' ? 'event' : 'cpu/mem';

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(formatFreezeReport(rows, { version: APP_VERSION, platform, commit: BUILD_COMMIT }));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access denied — nothing more we can do here.
        }
    };

    return (
        <div className="sd-card">
            <div className="flex items-center gap-3">
                <span className="sd-tile"><Activity size={16} /></span>
                <div>
                    <h3 style={{ margin: 0 }}>Performance log</h3>
                    <p className="sd-sub" style={{ margin: 0 }}>
                        Every time the app stopped responding for {LONG_TASK_MS} ms or more this session, and what it was doing.
                        Times and phase names only — no messages or names. Not saved to disk.
                    </p>
                </div>
            </div>

            {rows.length === 0 ? (
                <p className="sd-sub mt-4" style={{ margin: 0 }}>No freezes recorded this session.</p>
            ) : (
                <div className="mt-4 flex flex-col gap-1.5" style={{ maxHeight: 220, overflowY: 'auto' }}>
                    <p className="sd-sub" style={{ margin: 0 }}>
                        {stalls.length === 0 ? 'No freezes recorded' : `${stalls.length} freezes, longest ${worst} ms`}
                        {rows.length > stalls.length ? `, plus ${rows.length - stalls.length} window, power and resource rows` : ''}. Newest first.
                    </p>
                    {rows.slice(0, 60).map((r, i) => (
                        <div key={`${r.at}-${r.source}-${i}`} className="sd-row" style={{ borderTop: 'none', padding: '2px 0', gap: 10, opacity: isStall(r) ? 1 : 0.75 }}>
                            <span className="sd-mono" style={{ fontSize: 12, color: 'var(--cl-muted)', flex: 'none' }}>
                                {new Date(r.at).toLocaleTimeString()} {rowLabel(r)}
                            </span>
                            <span className="sd-mono" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.activity}>{r.activity}</span>
                            {(isStall(r) || r.ms > 0) && <span className="sd-mono" style={{ fontSize: 12, flex: 'none' }}>{r.ms} ms</span>}
                        </div>
                    ))}
                </div>
            )}

            {captureApi && (
                <div className="flex gap-2 mt-4">
                    <button type="button" className="sd-opt" style={{ flex: 1, cursor: captureLeft > 0 ? 'default' : 'pointer' }} disabled={captureLeft > 0} onClick={startCapture}>
                        <span className="sd-opt-head"><Activity size={13} /><b>{captureLeft > 0 ? `Capturing… ${captureLeft} s` : 'Run a 60-second freeze capture'}</b></span>
                        <p>Start it, then do whatever freezes (restore the window, open a channel). Copy the log when it finishes.</p>
                    </button>
                </div>
            )}

            <div className="flex gap-2 mt-4">
                <button type="button" className="sd-opt" style={{ flex: 1, cursor: rows.length === 0 ? 'default' : 'pointer' }} disabled={rows.length === 0} onClick={copy}>
                    <span className="sd-opt-head"><Copy size={13} /><b>{copied ? 'Copied' : 'Copy log'}</b></span>
                </button>
                <button type="button" className="sd-opt" style={{ flex: 1, cursor: rows.length === 0 ? 'default' : 'pointer' }} disabled={rows.length === 0} onClick={() => { void clearFreezeLog().then(() => setRows([])); }}>
                    <span className="sd-opt-head"><Trash2 size={13} /><b>Clear</b></span>
                </button>
            </div>
        </div>
    );
};

/** Selectable option card — kit-radio face on a card, springs on select. */
const ChannelCard: React.FC<{
    active: boolean;
    disabled: boolean;
    title: string;
    description: string;
    onClick: () => void;
}> = ({ active, disabled, title, description, onClick }) => (
    <button
        type="button"
        role="radio"
        aria-checked={active}
        className={`sd-opt${active ? ' sd-on' : ''}`}
        disabled={disabled}
        onClick={onClick}
    >
        <span className="sd-opt-head">
            <span className="sd-opt-dot" />
            <b>{title}</b>
        </span>
        <p>{description}</p>
    </button>
);

export default AdvancedSettings;
