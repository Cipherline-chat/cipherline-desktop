import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Check, ChevronDown, Monitor, ArrowRight, ArrowLeft, Loader2, AlertTriangle, Settings, ShieldAlert } from 'lucide-react';
import { ClButton, ClCheckbox, ClModal } from './cl';
import {
    screenSourcesVerdict,
    isScreenAccessRefused,
    type ScreenCaptureAccess,
} from '../utils/screenCapturePermission';

export interface ScreenShareOptions {
    sourceId: string;
    resolution: 'source' | '1440p' | '1080p' | '720p' | '480p';
    frameRate: 15 | 30 | 60 | 90;
    audio: boolean;
}
// Screenshares are always encoded for motion (games, video, UI with animation).
// We hardcode contentHint='motion' + degradationPreference='maintain-framerate'
// everywhere the sender is configured — no user-facing toggle.

interface ScreenSharePickerModalProps {
    onSelect: (options: ScreenShareOptions | null) => void;
}

type SourceType = 'screen' | 'window';
type Source = { id: string; name: string; thumbnailDataUrl: string };

type Preset = 'low' | 'default' | 'high' | null;

const PRESETS: Record<'low' | 'default' | 'high', { resolution: ScreenShareOptions['resolution']; frameRate: ScreenShareOptions['frameRate']; label: string; desc: string }> = {
    low:     { resolution: '720p',  frameRate: 30, label: 'Low',     desc: '720p · 30fps'  },
    default: { resolution: '1080p', frameRate: 30, label: 'Default', desc: '1080p · 30fps' },
    high:    { resolution: '1080p', frameRate: 60, label: 'High',    desc: '1080p · 60fps' },
};

const RESOLUTION_LABELS: Record<ScreenShareOptions['resolution'], string> = {
    source: 'Source (Native)',
    '1440p': '2560×1440',
    '1080p': '1920×1080',
    '720p':  '1280×720',
    '480p':  '854×480',
};

function detectPreset(
    resolution: ScreenShareOptions['resolution'],
    frameRate: ScreenShareOptions['frameRate'],
): Preset {
    for (const [key, p] of Object.entries(PRESETS)) {
        if (p.resolution === resolution && p.frameRate === frameRate) return key as Preset;
    }
    return null;
}

/** Custom dropdown — no native <select>, no double arrows */
const CustomDropdown = <T extends string | number>({
    value, onChange, options, className = '',
}: {
    value: T;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
    className?: string;
}) => {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const selectedLabel = options.find(o => o.value === value)?.label ?? String(value);

    return (
        <div ref={containerRef} className={`relative ${className}`}>
            <ClButton
                type="button"
                variant="ghost"
                onClick={() => setOpen(v => !v)}
                fullWidth
                row
            >
                <span className="text-xs text-cl-text">{selectedLabel}</span>
                <ChevronDown className={`ml-auto w-3 h-3 text-cl-faint shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </ClButton>
            {open && (
                <div className="absolute bottom-full left-0 mb-1.5 min-w-full bg-cl-deep border border-white/[0.12] rounded-xl shadow-[0_-8px_32px_rgba(0,0,0,0.7)] py-1.5 z-[200]">
                    {options.map(opt => {
                        const isActive = opt.value === value;
                        return (
                            <ClButton
                                key={String(opt.value)}
                                type="button"
                                variant="ghost"
                                onClick={() => { onChange(opt.value); setOpen(false); }}
                                fullWidth
                                row
                                size="sm"
                            >
                                <span className={`text-xs ${isActive ? 'text-cl-lume' : 'text-cl-muted'}`}>{opt.label}</span>
                                {isActive && <Check className="ml-auto w-3 h-3 text-cl-lume shrink-0" />}
                            </ClButton>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

const SkeletonTile = ({ idx }: { idx: number }) => (
    <div
        className="rounded-xl bg-cl-surface border border-white/[0.04] overflow-hidden"
        style={{ animationDelay: `${idx * 40}ms` }}
    >
        <div className="w-full bg-white/[0.03] animate-pulse" style={{ height: 112 }} />
        <div className="p-2.5">
            <div className="h-2 bg-white/[0.06] rounded-full w-3/4 mb-1.5 animate-pulse" />
            <div className="h-2 bg-white/[0.04] rounded-full w-1/2 animate-pulse" />
        </div>
    </div>
);

export type MacPermissionMode =
    /** Never answered the prompt, or the status can't be read. */
    | 'ungranted'
    /** Actively denied, or blocked by policy — only Settings can undo it. */
    | 'refused'
    /** Toggle is already on, but this process launched before the grant. */
    | 'relaunch';

/** macOS-only empty state: nothing is listed because Screen Recording (TCC)
 *  isn't in effect, not because there's nothing to share.
 *
 *  There is no Electron API to request this permission (askForMediaAccess
 *  covers only microphone and camera), so the remedy is entirely manual: send
 *  the user to the right System Settings pane, then have them relaunch.
 *  The relaunch is not politeness — CGRequestScreenCaptureAccess caches its
 *  refusal for the life of the process, so a grant made while Cipherline is
 *  running cannot take effect until it is quit and reopened. That is the same
 *  reason macOS's own alert offers "Quit & Reopen". */
const MacScreenPermissionNotice = ({
    mode, onOpenSettings, onRecheck,
}: {
    mode: MacPermissionMode;
    onOpenSettings: () => void;
    onRecheck: () => void;
}) => (
    <div className="col-span-full flex flex-col items-center justify-center py-10 px-4 gap-3">
        <div className="w-11 h-11 rounded-xl bg-amber-400/10 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-amber-400" />
        </div>
        <p className="text-cl-text text-sm font-semibold m-0 text-center">
            {mode === 'relaunch'
                ? 'Reopen Cipherline to finish enabling screen sharing'
                : 'macOS needs permission to share your screen'}
        </p>
        <p className="text-cl-faint text-[13px] m-0 text-center max-w-[400px] leading-snug">
            {mode === 'relaunch'
                ? <>Screen Recording is switched on for Cipherline, but macOS only hands that permission to an app that was launched <em>after</em> it was granted. Quit Cipherline completely and open it again.</>
                : mode === 'refused'
                    ? <>Screen Recording is turned off for Cipherline, so macOS hides every window and display from this picker. Turn it on under <span className="text-cl-muted">Privacy &amp; Security → Screen Recording</span>.</>
                    : <>Until Cipherline is allowed to record the screen, macOS hides every window and display from this picker. Enable Cipherline under <span className="text-cl-muted">Privacy &amp; Security → Screen Recording</span>.</>}
        </p>
        {mode !== 'relaunch' && (
            <p className="text-cl-faint text-[12px] m-0 text-center max-w-[400px] leading-snug">
                After switching it on, quit Cipherline completely and open it again —
                macOS only applies the new permission to a fresh launch.
            </p>
        )}
        <div className="flex items-center gap-2 mt-1">
            {mode !== 'relaunch' && (
                <ClButton variant="primary" size="sm" onClick={onOpenSettings}>
                    <Settings className="w-3.5 h-3.5" />
                    Open System Settings
                </ClButton>
            )}
            <ClButton variant={mode === 'relaunch' ? 'primary' : 'ghost'} size="sm" onClick={onRecheck}>
                <RefreshCw className="w-3.5 h-3.5" />
                Check again
            </ClButton>
        </div>
    </div>
);

/** Thumbnail grid — used by the classic (non-Linux) tabbed layout and by the
 *  Linux window-picker step. `emptyType` drives the empty-state copy (and,
 *  for the classic screen tab, the OS-picker-closed explanation + retry);
 *  `macPermission`, when set, replaces all of that with the TCC notice. */
const SourceGrid = ({
    loading, sources, selectedSourceId, onSelect, onConfirm, emptyType, onRetryScreen, macPermission,
}: {
    loading: boolean;
    sources: Source[];
    selectedSourceId: string | null;
    onSelect: (id: string) => void;
    onConfirm: (id: string) => void;
    emptyType: SourceType;
    onRetryScreen?: () => void;
    macPermission?: { mode: MacPermissionMode; onOpenSettings: () => void; onRecheck: () => void };
}) => (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
        {loading
            ? Array.from({ length: 6 }).map((_, i) => <SkeletonTile key={i} idx={i} />)
            : sources.length === 0
                ? macPermission
                ? <MacScreenPermissionNotice {...macPermission} />
                : (
                    <div className="col-span-full flex flex-col items-center justify-center py-12 gap-3">
                        <Monitor className="w-10 h-10 text-cl-faint" />
                        {emptyType === 'screen' && onRetryScreen ? (
                            <>
                                <p className="text-cl-faint text-sm m-0 text-center max-w-[320px] leading-snug">
                                    The system's screen picker closed without a selection —
                                    this is your desktop's own dialog, not Cipherline's, and
                                    on some Wayland setups it can time out on its own.
                                </p>
                                <ClButton variant="ghost" onClick={onRetryScreen}>
                                    Try again
                                </ClButton>
                            </>
                        ) : (
                            <p className="text-cl-faint text-sm m-0">
                                No {emptyType === 'screen' ? 'screens' : 'windows'} found
                            </p>
                        )}
                    </div>
                )
                : sources.map(source => {
                    const selected = selectedSourceId === source.id;
                    return (
                        <div
                            key={source.id}
                            onClick={() => onSelect(source.id)}
                            onDoubleClick={() => onConfirm(source.id)}
                            title={source.name}
                            className="cursor-pointer rounded-xl overflow-hidden select-none transition-all duration-150"
                            style={{
                                transform: selected ? 'scale(1.02)' : 'scale(1)',
                                boxShadow: selected
                                    ? '0 0 0 2px #0ea5e9, 0 0 16px rgba(14,165,233,0.3)'
                                    : '0 0 0 1px rgba(255,255,255,0.06)',
                            }}
                        >
                            <div
                                className="w-full bg-black flex items-center justify-center overflow-hidden relative"
                                style={{ height: 112 }}
                            >
                                <img
                                    src={source.thumbnailDataUrl}
                                    alt={source.name}
                                    draggable={false}
                                    className="w-full h-full object-contain transition-transform duration-200 pointer-events-none"
                                    style={{ transform: selected ? 'scale(1.04)' : 'scale(1)' }}
                                />
                                {selected && (
                                    <div className="absolute inset-0 bg-cl-lume/10 flex items-center justify-center">
                                        <div className="w-6 h-6 rounded-full bg-cl-lume flex items-center justify-center shadow-lg">
                                            <Check className="w-3.5 h-3.5 text-cl-on-lume" strokeWidth={3} />
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className={`px-2.5 py-2 transition-colors duration-150 ${selected ? 'bg-cl-lume/10' : 'bg-cl-surface'}`}
                                 style={{ minHeight: 40 }}>
                                <p
                                    className="text-[13px] font-semibold m-0 break-words leading-[1.35]"
                                    style={{
                                        color: selected ? 'white' : 'rgba(255,255,255,0.82)',
                                        display: '-webkit-box',
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: 'vertical',
                                        overflow: 'hidden',
                                    }}
                                >
                                    {source.name}
                                </p>
                            </div>
                        </div>
                    );
                })
        }
    </div>
);

const QualityControls = ({
    resolution, setResolution, frameRate, setFrameRate, has1440p, audio, setAudio, activePreset, applyPreset,
}: {
    resolution: ScreenShareOptions['resolution'];
    setResolution: (v: ScreenShareOptions['resolution']) => void;
    frameRate: ScreenShareOptions['frameRate'];
    setFrameRate: (v: ScreenShareOptions['frameRate']) => void;
    has1440p: boolean;
    audio: boolean;
    setAudio: (v: boolean) => void;
    activePreset: Preset;
    applyPreset: (key: 'low' | 'default' | 'high') => void;
}) => (
    <div className="flex items-center gap-4 flex-wrap">
        {/* Preset pills */}
        <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-cl-faint font-medium mr-1 whitespace-nowrap">Preset</span>
            {(['low', 'default', 'high'] as const).map(key => {
                const isActive = activePreset === key;
                return (
                    <ClButton
                        key={key}
                        variant="ghost"
                        active={isActive}
                        size="sm"
                        onClick={() => applyPreset(key)}
                        tooltip={`${PRESETS[key].label}: ${PRESETS[key].desc}`}
                    >
                        {PRESETS[key].label}
                    </ClButton>
                );
            })}
        </div>

        <div className="w-px h-5 bg-white/[0.08]" />

        {/* Resolution */}
        <div className="flex items-center gap-2">
            <span className="text-[11px] text-cl-faint font-medium whitespace-nowrap">Resolution</span>
            <CustomDropdown
                value={resolution}
                onChange={v => setResolution(v as ScreenShareOptions['resolution'])}
                className="w-36"
                options={[
                    { value: 'source' as const, label: 'Source (Native)' },
                    ...(has1440p ? [{ value: '1440p' as const, label: '2560×1440' }] : []),
                    { value: '1080p' as const, label: '1920×1080' },
                    { value: '720p' as const, label: '1280×720' },
                    { value: '480p' as const, label: '854×480' },
                ]}
            />
        </div>

        {/* Frame rate */}
        <div className="flex items-center gap-2">
            <span className="text-[11px] text-cl-faint font-medium whitespace-nowrap">Frame Rate</span>
            <CustomDropdown
                value={frameRate}
                onChange={v => setFrameRate(Number(v) as ScreenShareOptions['frameRate'])}
                className="w-36"
                options={[
                    { value: 90 as const, label: 'Up to 90 fps' },
                    { value: 60 as const, label: '60 fps' },
                    { value: 30 as const, label: '30 fps' },
                    { value: 15 as const, label: '15 fps' },
                ]}
            />
        </div>

        <div className="w-px h-5 bg-white/[0.08]" />

        {/* Audio checkbox */}
        <ClCheckbox
            checked={audio}
            onChange={v => setAudio(v)}
            label="Share system audio"
        />
    </div>
);

const QualitySummary = ({
    resolution, frameRate, activePreset, audio, maxRefreshHz,
}: {
    resolution: ScreenShareOptions['resolution'];
    frameRate: ScreenShareOptions['frameRate'];
    activePreset: Preset;
    audio: boolean;
    /** Highest display refresh rate available, or 0 when unknown. */
    maxRefreshHz: number;
}) => {
    // Screen capture samples the compositor, so it can't produce more distinct
    // frames per second than the display actually generates. Requesting 90 on a
    // 60 Hz panel gets you 60 — this is a hardware ceiling, not a tuning
    // problem, so say so plainly instead of letting people chase it.
    const refreshCapped = maxRefreshHz > 0 && frameRate > maxRefreshHz;
    return (
        <>
            <p className="text-[10px] text-cl-faint mt-2 m-0">
                {RESOLUTION_LABELS[resolution]} · {frameRate} fps
                {activePreset ? ` · ${PRESETS[activePreset].label} preset` : ' · Custom'}
                {audio ? ' · Audio on' : ''}
            </p>

            {refreshCapped ? (
                <div
                    className="mt-2.5 flex items-start gap-2 rounded-lg px-3 py-2 border"
                    style={{
                        background:  'rgba(234,179,8,0.08)',
                        borderColor: 'rgba(234,179,8,0.35)',
                    }}
                >
                    <svg className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-[1px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                    <p className="text-[11px] text-amber-300/95 m-0 leading-snug">
                        <span className="font-semibold">Your display runs at {maxRefreshHz} Hz.</span>{' '}
                        Screen capture can&apos;t exceed the refresh rate of the screen it&apos;s
                        reading, so this will send about {maxRefreshHz} fps. A faster
                        monitor is the only way past this.
                    </p>
                </div>
            ) : frameRate === 90 && (
                <div
                    className="mt-2.5 flex items-start gap-2 rounded-lg px-3 py-2 border"
                    style={{
                        background:  'rgba(234,179,8,0.08)',
                        borderColor: 'rgba(234,179,8,0.35)',
                    }}
                >
                    <svg className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-[1px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                    <p className="text-[11px] text-amber-300/95 m-0 leading-snug">
                        <span className="font-semibold">Up to 90 fps.</span>{' '}
                        Actual frame rate depends on your hardware and network speed —
                        slower machines or constrained uploads may land closer to 60 fps.
                    </p>
                </div>
            )}
        </>
    );
};

// Linux: one combined request, one native OS picker, no in-app "what do you
// want to share" step and no second thumbnail grid to re-ask in.
//
// Everywhere else, `desktopCapturer.getSources()` is a cheap local
// enumeration with no OS involvement, so the classic tabs-plus-thumbnail-
// grid (below) is the best UX: instant previews, pick anything, no round
// trip.
//
// On Wayland, asking for 'screen' sources is different in kind, not just
// slower — it's what makes Chromium hand the request to the desktop's own
// ScreenCast portal (xdg-desktop-portal-kde/gnome/etc.), which pops a
// native OS dialog with its own live per-window and per-monitor previews.
// That dialog IS the actual capture grant, not a preview step — asking it
// for both 'window' and 'screen' together lets its own UI offer both, the
// same as Discord's Linux client, so there's nothing left for an in-app
// step to usefully ask before or after it.
type LinuxStep = 'waiting' | 'error' | 'grid' | 'settings';

export const ScreenSharePickerModal: React.FC<ScreenSharePickerModalProps> = ({ onSelect }) => {
    const platform = window.electronAPI?.platform ?? 'windows';
    const isLinux = platform === 'linux';

    // Sources are fetched PER TYPE, not both up front (classic/non-Linux
    // tabs only — the Linux flow below uses its own single combined-request
    // state instead).
    const [sourcesByType, setSourcesByType] = useState<Partial<Record<SourceType, Source[]>>>({});
    const [loading, setLoading] = useState(true);
    // Window-first: it's the fast, portal-free path, so it's what most people
    // should land on by default (classic/non-Linux tabs only).
    const [selectedTab, setSelectedTab] = useState<SourceType>('window');
    const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
    const [resolution, setResolution] = useState<ScreenShareOptions['resolution']>('1080p');
    const [frameRate, setFrameRate] = useState<ScreenShareOptions['frameRate']>(30);
    const [audio, setAudio] = useState(false);
    const [closing, setClosing] = useState(false);   // drives the kit modal's exit animation

    // Highest display refresh rate on this machine — the hard ceiling on how
    // many distinct frames screen capture can ever produce. 0 = unknown (older
    // preload without the IPC, or a platform that doesn't report a frequency),
    // in which case we say nothing rather than guess.
    const [maxRefreshHz, setMaxRefreshHz] = useState(0);
    useEffect(() => {
        let cancelled = false;
        window.electronAPI?.getDisplayRefreshRates?.()
            .then(displays => {
                if (cancelled || !displays?.length) return;
                setMaxRefreshHz(Math.max(0, ...displays.map(d => d.displayFrequency || 0)));
            })
            .catch(() => { /* stay at 0 — advisory only */ });
        return () => { cancelled = true; };
    }, []);

    const [linuxStep, setLinuxStep] = useState<LinuxStep>('waiting');
    const [linuxSources, setLinuxSources] = useState<Source[]>([]);

    // Detect if primary screen is 1440p+
    const has1440p = typeof window !== 'undefined' && window.screen.height >= 1440;

    // Animate out before calling onSelect — ClModal unmounts 260 ms after `open` flips.
    const dismiss = useCallback((result: ScreenShareOptions | null) => {
        setClosing(true);
        setTimeout(() => onSelect(result), 260);
    }, [onSelect]);

    // macOS Screen Recording (TCC). 'not-applicable' everywhere else, which is
    // also the safe default when an older preload doesn't expose the probe:
    // the verdict then falls back to the plain empty state exactly as before.
    const [screenAccess, setScreenAccess] = useState<ScreenCaptureAccess>('not-applicable');
    /** Did the last getDesktopSources call reject? (macOS's real TCC signal.) */
    const [fetchFailed, setFetchFailed] = useState(false);
    const refreshScreenAccess = useCallback(async () => {
        if (platform !== 'mac') return;
        try {
            const status = await window.electronAPI?.getScreenCaptureAccess?.();
            if (status) setScreenAccess(status);
        } catch { /* leave the last known value — this only picks the copy */ }
    }, [platform]);

    const fetchSourcesFor = useCallback(async (type: SourceType) => {
        setLoading(true);
        setSelectedSourceId(null);
        if (window.electronAPI) {
            try {
                const desktopSources = await window.electronAPI.getDesktopSources([type]);
                setSourcesByType(prev => ({ ...prev, [type]: desktopSources }));
                setFetchFailed(false);
            } catch (err) {
                // On macOS this is the NORMAL shape of a missing Screen
                // Recording grant: Electron rejects with "Failed to get
                // sources." rather than resolving with an empty list.
                console.error('Failed to fetch desktop sources:', err);
                setSourcesByType(prev => ({ ...prev, [type]: [] }));
                setFetchFailed(true);
            }
            // Read the status AFTER the enumeration: on a first run that call
            // is what gives macOS its chance to show the one-shot system
            // prompt, so asking first would report a staler answer.
            await refreshScreenAccess();
        }
        setLoading(false);
    }, [refreshScreenAccess]);

    // Classic (non-Linux) tabs: fetch the active tab's sources whenever it
    // changes, but only the first time — switching back to an already-
    // fetched tab neither re-hits the IPC call nor re-prompts anything.
    useEffect(() => {
        if (isLinux) return;
        if (sourcesByType[selectedTab] !== undefined) { setSelectedSourceId(null); return; }
        void fetchSourcesFor(selectedTab);
    }, [isLinux, selectedTab, sourcesByType, fetchSourcesFor]);

    // Linux: the ONE call to the OS. Requesting both types together lets the
    // native dialog's own UI offer windows and screens side by side, so
    // whatever the user picks there is the final answer — no second
    // selection step in our own UI. Always fetches fresh (never reused
    // across a Back/retry) since re-opening the picker exists precisely so
    // the user can choose something different than last time.
    const fetchLinuxSources = useCallback(async () => {
        setSelectedSourceId(null);
        setLinuxStep('waiting');
        if (!window.electronAPI) { setLinuxStep('error'); return; }
        try {
            const sources = await window.electronAPI.getDesktopSources(['screen', 'window']);
            setLinuxSources(sources);
            if (sources.length === 0) { setLinuxStep('error'); return; }
            if (sources.length === 1) {
                setSelectedSourceId(sources[0].id);
                setLinuxStep('settings');
                return;
            }
            // Rare: some portal configs hand back more than one grant, or
            // the picker allows picking without narrowing to one stream.
            // Fall back to letting the user pick from a small grid.
            setLinuxStep('grid');
        } catch (err) {
            console.error('Failed to fetch desktop sources:', err);
            setLinuxStep('error');
        }
    }, []);

    // Open the OS picker once, the moment the modal mounts on Linux. Same
    // fetch-on-mount shape (and same accepted synchronous-setState-before-
    // the-await lint tradeoff) as the classic tab effect above.
    useEffect(() => {
        if (!isLinux) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- loading state must flip before the await starts
        void fetchLinuxSources();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLinux]);

    const filteredSources = isLinux ? linuxSources : (sourcesByType[selectedTab] ?? []);

    // Only ever set on macOS when there is nothing to share AND the Screen
    // Recording grant is the reason — Windows and Linux, and a macOS machine
    // that simply has nothing open, keep the existing empty state untouched.
    const verdict = screenSourcesVerdict({
        platform,
        access: screenAccess,
        sourceCount: filteredSources.length,
        fetchFailed,
    });
    const macPermission = (verdict === 'macos-permission-required' || verdict === 'macos-relaunch-required')
        ? {
            mode: verdict === 'macos-relaunch-required'
                ? 'relaunch' as const
                : isScreenAccessRefused(screenAccess) ? 'refused' as const : 'ungranted' as const,
            onOpenSettings: () => { void window.electronAPI?.openScreenRecordingSettings?.(); },
            onRecheck: () => { void fetchSourcesFor(selectedTab); },
        }
        : undefined;

    const chosenSource = filteredSources.find(s => s.id === selectedSourceId) ?? null;
    const chosenIsWindow = !!selectedSourceId?.startsWith('window:');
    const activePreset = detectPreset(resolution, frameRate);

    const applyPreset = (key: 'low' | 'default' | 'high') => {
        setResolution(PRESETS[key].resolution);
        setFrameRate(PRESETS[key].frameRate);
    };

    const handleShare = (sourceId?: string) => {
        const id = sourceId ?? selectedSourceId;
        if (!id) return;
        dismiss({ sourceId: id, resolution, frameRate, audio });
    };

    const handleCancel = () => { dismiss(null); };

    return (
        // Mid-call surface: must layer above the fullscreen call chrome, hence
        // the raised overlay z-index (the kit default is 1000).
        <ClModal
            open={!closing}
            onClose={handleCancel}
            label="Share Your Screen"
            overlayStyle={{ zIndex: 99999, paddingTop: 32 }}
            cardClassName="flex flex-col select-none"
            cardStyle={{ width: 860, maxWidth: '95vw', height: 'min(88vh, 720px)', padding: 0, overflow: 'hidden' }}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-0 shrink-0">
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-cl-lume/15 flex items-center justify-center">
                        <Monitor className="w-3.5 h-3.5 text-cl-lume" />
                    </div>
                    <h2 className="m-0 text-cl-text text-lg font-bold tracking-tight">Share Your Screen</h2>
                </div>
                {!isLinux && (
                    <ClButton
                        icon
                        variant="ghost"
                        onClick={() => void fetchSourcesFor(selectedTab)}
                        tooltip="Refresh sources"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </ClButton>
                )}
            </div>

            {!isLinux ? (
                <>
                    {/* Tabs */}
                    <div className="flex gap-1 px-6 mt-4 shrink-0 border-b border-white/[0.06]">
                        {(['screen', 'window'] as SourceType[]).map(tab => {
                            const active = selectedTab === tab;
                            return (
                                <ClButton
                                    key={tab}
                                    variant="ghost"
                                    active={active}
                                    onClick={() => setSelectedTab(tab)}
                                    className="relative pb-2.5 px-1 text-sm font-medium"
                                    style={{ color: active ? 'white' : 'rgba(156,163,175,1)' }}
                                >
                                    {tab === 'screen' ? 'Entire Screen' : 'Application Window'}
                                    {active && (
                                        <span
                                            className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-cl-lume"
                                            style={{ boxShadow: '0 0 8px rgba(14,165,233,0.6)' }}
                                        />
                                    )}
                                </ClButton>
                            );
                        })}
                    </div>

                    {/* Source grid */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
                        <SourceGrid
                            loading={loading}
                            sources={filteredSources}
                            selectedSourceId={selectedSourceId}
                            onSelect={setSelectedSourceId}
                            onConfirm={handleShare}
                            emptyType={selectedTab}
                            onRetryScreen={selectedTab === 'screen' ? () => void fetchSourcesFor('screen') : undefined}
                            macPermission={macPermission}
                        />
                    </div>

                    {/* Settings bar */}
                    <div className="shrink-0 border-t border-white/[0.06] bg-cl-abyss rounded-b-2xl px-6 py-3.5">
                        <div className="flex items-center gap-4 flex-wrap">
                            <QualityControls
                                resolution={resolution} setResolution={setResolution}
                                frameRate={frameRate} setFrameRate={setFrameRate}
                                has1440p={has1440p} audio={audio} setAudio={setAudio}
                                activePreset={activePreset} applyPreset={applyPreset}
                            />
                            <div className="flex-1" />
                            <div className="flex items-center gap-2">
                                <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                                <ClButton
                                    variant="primary"
                                    size="sm"
                                    disabled={!selectedSourceId}
                                    onClick={() => handleShare()}
                                    pressAnim="send"
                                >
                                    Share
                                    <ArrowRight className="w-3 h-3" />
                                </ClButton>
                            </div>
                        </div>
                        <QualitySummary resolution={resolution} frameRate={frameRate} activePreset={activePreset} audio={audio} maxRefreshHz={maxRefreshHz} />
                    </div>
                </>
            ) : (
                <>
                    {linuxStep === 'waiting' && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
                            <Loader2 className="w-8 h-8 text-cl-lume animate-spin" />
                            <p className="text-cl-faint text-sm m-0 text-center max-w-[320px] leading-snug">
                                Waiting for you to choose a window or screen in the system dialog…
                            </p>
                            <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                        </div>
                    )}

                    {linuxStep === 'error' && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
                            <AlertTriangle className="w-8 h-8 text-amber-400" />
                            <p className="text-cl-faint text-sm m-0 text-center max-w-[340px] leading-snug">
                                The system's picker closed without a selection —
                                that's your desktop's own dialog, not Cipherline's, and on
                                some Wayland setups it can close itself before you can act.
                            </p>
                            <div className="flex items-center gap-2">
                                <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                                <ClButton variant="primary" size="sm" onClick={() => void fetchLinuxSources()}>
                                    Try again
                                </ClButton>
                            </div>
                        </div>
                    )}

                    {linuxStep === 'grid' && (
                        <>
                            <div className="flex items-center gap-2 px-6 pt-4 shrink-0">
                                <span className="text-sm font-medium text-cl-text">Choose what to share</span>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
                                <SourceGrid
                                    loading={loading}
                                    sources={filteredSources}
                                    selectedSourceId={selectedSourceId}
                                    onSelect={setSelectedSourceId}
                                    onConfirm={(id) => { setSelectedSourceId(id); setLinuxStep('settings'); }}
                                    emptyType="window"
                                />
                            </div>
                            <div className="shrink-0 border-t border-white/[0.06] bg-cl-abyss rounded-b-2xl px-6 py-3.5 flex items-center justify-end gap-2">
                                <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                                <ClButton
                                    variant="primary"
                                    size="sm"
                                    disabled={!selectedSourceId}
                                    onClick={() => setLinuxStep('settings')}
                                    pressAnim="send"
                                >
                                    Next
                                    <ArrowRight className="w-3 h-3" />
                                </ClButton>
                            </div>
                        </>
                    )}

                    {linuxStep === 'settings' && (
                        <>
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 flex flex-col gap-5">
                                {/* Chosen source preview */}
                                <div className="flex items-center gap-3 rounded-xl bg-cl-surface border border-white/[0.06] p-3">
                                    <div className="w-28 h-16 rounded-lg overflow-hidden bg-black shrink-0 flex items-center justify-center">
                                        {chosenSource?.thumbnailDataUrl
                                            ? <img src={chosenSource.thumbnailDataUrl} alt={chosenSource.name} className="w-full h-full object-contain" />
                                            : <Monitor className="w-6 h-6 text-cl-faint" />}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-0.5">
                                            {chosenIsWindow ? 'Application Window' : 'Entire Screen'}
                                        </p>
                                        <p className="text-sm font-semibold text-cl-text m-0 truncate">
                                            {chosenSource?.name ?? 'Selected source'}
                                        </p>
                                    </div>
                                </div>

                                <QualityControls
                                    resolution={resolution} setResolution={setResolution}
                                    frameRate={frameRate} setFrameRate={setFrameRate}
                                    has1440p={has1440p} audio={audio} setAudio={setAudio}
                                    activePreset={activePreset} applyPreset={applyPreset}
                                />
                                <QualitySummary resolution={resolution} frameRate={frameRate} activePreset={activePreset} audio={audio} maxRefreshHz={maxRefreshHz} />
                            </div>
                            <div className="shrink-0 border-t border-white/[0.06] bg-cl-abyss rounded-b-2xl px-6 py-3.5 flex items-center justify-between gap-2">
                                <ClButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => linuxSources.length > 1 ? setLinuxStep('grid') : void fetchLinuxSources()}
                                >
                                    <ArrowLeft className="w-3.5 h-3.5" /> Back
                                </ClButton>
                                <div className="flex items-center gap-2">
                                    <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                                    <ClButton
                                        variant="primary"
                                        size="sm"
                                        disabled={!selectedSourceId}
                                        onClick={() => handleShare()}
                                        pressAnim="send"
                                    >
                                        Share
                                        <ArrowRight className="w-3 h-3" />
                                    </ClButton>
                                </div>
                            </div>
                        </>
                    )}
                </>
            )}
        </ClModal>
    );
};
