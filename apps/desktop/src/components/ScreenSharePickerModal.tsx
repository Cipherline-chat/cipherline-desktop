import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { chooseDropUp } from '../utils/dropdownPlacement';
import { useEscape } from '../hooks/useEscape';
import { bestAppForWindow, type AudioApp } from '../utils/appAudioMatch';
import { shareAudioEventDetail } from '../utils/shareAudioEvent';
import { PRESETS, detectPreset, type PresetKey } from '../utils/sharePresets';
import { clampShareFps, maxShareFps, probeHardwareEncoders, decideScreenShareCodec, type ScreenShareCodec } from '../utils/screenShare';
import { nativeShareLikely, useChromiumFpsCap } from '../utils/linuxShareCaps';
import { capFrameRate, expectSoftwareEncode, planSoftwareStart } from '../utils/linuxShareDefaults';
import { getScreenShareCodecPref } from '../utils/streamDiagnosticsPrefs';
import { shortOption } from '../utils/shareEncoderOverload';
import { shareAudioUnavailableReason, windowAudioBlockedReason, windowAudioPicksApp } from '../utils/sharePlatformSupport';
import { RefreshCw, Check, ChevronDown, Monitor, ArrowRight, ArrowLeft, Loader2, AlertTriangle, Settings, ShieldAlert } from 'lucide-react';
import { ClButton, ClCheckbox, ClModal, ClSegment } from './cl';
import { ShareFpsDisclaimer } from './ShareFpsNote';
import { ClNote } from './cl/ClNote';
import { getCachedSources, storeNames, refreshDesktopSources, cancelDesktopSourceRefresh, hasPreview, pickerRequestedAt } from '../utils/desktopSourceCache';
import { logCallEvent } from '../utils/callEventLog';
import { captureViaPortal } from '../utils/sharePlatformSupport';
import { newPortalSourceId } from '../utils/portalSource';
import {
    aspectOf, defaultLayoutFor, layoutChoices, layoutsEqual, sliceLabel, WHOLE_LAYOUT, type ShareLayout,
} from '../utils/shareLayout';
import {
    screenSourcesVerdict,
    isScreenAccessRefused,
    showMacPickerBypassNote,
    type ScreenCaptureAccess,
} from '../utils/screenCapturePermission';

export interface ScreenShareOptions {
    sourceId: string;
    resolution: 'source' | '1440p' | '1080p' | '720p' | '480p';
    frameRate: 15 | 30 | 60 | 90;
    audio: boolean;
    /**
     * Linux Wayland window shares only: the app whose audio is shared (the portal gives a window no
     * process, so the picker names the app instead). `handle` is an opaque value main issued for the
     * app (electron/app-audio.ts) and the only thing the capture is started from; `name` is for display.
     */
    appAudio?: { handle: string; name: string } | null;
    /**
     * Ultra-wide displays only (shareLayout.ts): the whole display scaled to fit
     * the encoder, or one screen of it cropped at native resolution. Absent =
     * the whole display.
     */
    layout?: ShareLayout;
}
// Screenshares are always encoded for motion (games, video, UI with animation).
// We hardcode contentHint='motion' + degradationPreference='maintain-framerate'
// everywhere the sender is configured — no user-facing toggle.

interface ScreenSharePickerModalProps {
    onSelect: (options: ScreenShareOptions | null) => void;
    /**
     * Opened mid-share (Change source): whether the running share has system audio. The box starts
     * ticked then, so picking another source keeps the audio instead of silently dropping it - every
     * source swap restarts the audio capture, and an unticked box meant "turn audio off" (a Linux
     * tester lost a six-minute audio share at the first swap, 2026-11-04). A fresh share starts off.
     */
    initialAudio?: boolean;
    /**
     * Opened mid-share on Linux: the app the running share takes its audio from, so Change source keeps the
     * choice (the same reason as initialAudio). The choice is kept even if the new window's title names
     * another app - it was made on purpose; the dropdown is one click from changing it.
     */
    initialAppAudio?: { handle: string; name: string } | null;
    /**
     * Opened mid-share through the Wayland portal: the running share's placeholder id. The portal picker
     * offers "Apply to current share" (new quality / audio, same capture, no chooser) next to "Choose what
     * to share…" (a new capture, one chooser).
     */
    liveSourceId?: string | null;
    /**
     * Opened mid-share (Change source): the running share's quality, so picking another source keeps what the
     * user chose instead of snapping back to 1080p / 30 (owner, 2026-11-11, every platform). A fresh share
     * starts at the defaults. A frame rate the new source cannot do is still clamped (clampShareFps below).
     */
    initialResolution?: ScreenShareOptions['resolution'];
    initialFrameRate?: ScreenShareOptions['frameRate'];
}

type SourceType = 'screen' | 'window';
type Source = { id: string; name: string; thumbnailDataUrl: string };

type Preset = PresetKey | null;

const RESOLUTION_LABELS: Record<ScreenShareOptions['resolution'], string> = {
    source: 'Source (Native)',
    '1440p': '2560×1440',
    '1080p': '1920×1080',
    '720p':  '1280×720',
    '480p':  '854×480',
};

function dropdownOpensUp(el: HTMLElement, optionCount: number): boolean {
    const r = el.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(o.overflowY + o.overflow)) {
            const pr = p.getBoundingClientRect();
            top = Math.max(top, pr.top);
            bottom = Math.min(bottom, pr.bottom);
            break;
        }
    }
    return chooseDropUp(r.top - top, bottom - r.bottom, optionCount);
}

/** Custom dropdown — no native <select>, no double arrows */
const CustomDropdown = <T extends string | number>({
    value, onChange, options, className = '', onOpen, groupLabel,
}: {
    value: T;
    onChange: (v: T) => void;
    options: { value: T; label: string }[];
    className?: string;
    /** Called each time the list opens (the app list refreshes then). */
    onOpen?: () => void;
    /** Accessible name of the control. */
    groupLabel?: string;
}) => {
    const [open, setOpen] = useState(false);
    // Opened from the keyboard: move focus into the list so Arrow keys / Enter work without a mouse.
    const openedByKey = useRef(false);
    // Which way the list opens: toward the side with room inside whatever clips
    // it (the dialog body scrolls). It always opened upward, and with the
    // settings row near the top of the body the first options were cut off.
    const [dropUp, setDropUp] = useState(true);
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

    // Escape closes the list (and only the list: the dialog keeps its place in the Escape stack).
    useEscape(() => {
        setOpen(false);
        containerRef.current?.querySelector('button')?.focus();
    }, open);

    const buttons = () => Array.from(containerRef.current?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
    useEffect(() => {
        if (!open || !openedByKey.current) return;
        openedByKey.current = false;
        const list = buttons().slice(1);   // [0] is the trigger
        const idx = Math.max(0, options.findIndex(o => o.value === value));
        list[idx]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per open
    }, [open]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const all = buttons();
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) {
                if (containerRef.current) setDropUp(dropdownOpensUp(containerRef.current, options.length));
                openedByKey.current = true;
                setOpen(true);
                onOpen?.();
                return;
            }
            const next = e.key === 'ArrowDown' ? Math.min(all.length - 1, at + 1) : Math.max(1, at - 1);
            all[next < 1 ? 1 : next]?.focus();
        } else if (open && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            all[e.key === 'Home' ? 1 : all.length - 1]?.focus();
        } else if (open && e.key === 'Tab') {
            setOpen(false);
        }
    };

    const selectedLabel = options.find(o => o.value === value)?.label ?? String(value);

    return (
        <div ref={containerRef} className={`relative ${className}`} role="group" aria-label={groupLabel} onKeyDown={onKeyDown}>
            <ClButton
                type="button"
                variant="ghost"
                onClick={() => {
                    if (!open && containerRef.current) setDropUp(dropdownOpensUp(containerRef.current, options.length));
                    if (!open) onOpen?.();
                    setOpen(v => !v);
                }}
                fullWidth
                row
            >
                <span className="text-xs text-cl-text">{selectedLabel}</span>
                <ChevronDown className={`ml-auto w-3 h-3 text-cl-faint shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </ClButton>
            {open && (
                <div data-dropdown-list="" className={`absolute ${dropUp ? 'bottom-full mb-1.5 shadow-[0_-8px_32px_rgba(0,0,0,0.7)]' : 'top-full mt-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.7)]'} left-0 min-w-full bg-cl-deep border border-white/[0.12] rounded-xl py-1.5 z-[200]`}>
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
                                {hasPreview(source) ? (
                                    <img
                                        src={source.thumbnailDataUrl}
                                        alt={source.name}
                                        draggable={false}
                                        className="w-full h-full object-contain transition-transform duration-200 pointer-events-none"
                                        style={{ transform: selected ? 'scale(1.04)' : 'scale(1)' }}
                                    />
                                ) : (
                                    // Preview still loading (or the window has none, e.g. minimised).
                                    <div className="w-full h-full bg-white/[0.03] animate-pulse flex items-center justify-center" data-testid="thumb-pending">
                                        <Monitor className="w-6 h-6 text-cl-faint opacity-60" />
                                    </div>
                                )}
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

/**
 * The aspect ratio of a source's preview thumbnail. Electron scales a
 * thumbnail to fit its box PRESERVING the source's aspect, so for a screen it
 * is the display's own aspect - enough to tell a Surround / Eyefinity display
 * (one 7680x1440 "monitor" to the OS) from an ordinary one without another
 * round trip to the main process. null until the image has loaded.
 */
function useThumbAspect(dataUrl: string | undefined): number | null {
    const [loaded, setLoaded] = useState<{ url: string; aspect: number | null } | null>(null);
    useEffect(() => {
        if (!dataUrl) return;
        let alive = true;
        const img = new Image();
        img.onload = () => { if (alive) setLoaded({ url: dataUrl, aspect: aspectOf(img.naturalWidth, img.naturalHeight) }); };
        img.onerror = () => { if (alive) setLoaded({ url: dataUrl, aspect: null }); };
        img.src = dataUrl;
        return () => { alive = false; img.onload = null; img.onerror = null; };
    }, [dataUrl]);
    return dataUrl && loaded?.url === dataUrl ? loaded.aspect : null;
}

/**
 * "Whole display (scaled) / Left / Center / Right screen" - shown only when the
 * chosen screen is ultra-wide (aspect > 2.4, shareLayout.ts). Why a choice: the
 * whole of a 7680x1440 display fits an encoder only at 3840x720, a sliver;
 * one screen of it is a native 2560x1440.
 */
const LayoutChooser = ({
    choices, value, onChange, aspect,
}: {
    choices: Array<{ layout: ShareLayout; label: string }>;
    value: ShareLayout;
    onChange: (l: ShareLayout) => void;
    aspect: number | null;
}) => (
    <div className="mb-3 rounded-xl px-4 py-3 border border-white/[0.08] bg-white/[0.02]" data-testid="share-layout-choice">
        <div className="text-[12px] font-semibold text-cl-text mb-2.5">Ultra-wide display</div>
        <div role="group" aria-label="What to share from this display">
            <ClSegment
                options={choices.map((c, i) => ({ value: String(i), label: c.label }))}
                value={String(Math.max(0, choices.findIndex(c => layoutsEqual(c.layout, value))))}
                onChange={v => { const c = choices[Number(v)]; if (c) onChange(c.layout); }}
            />
        </div>
        <div className="text-[12px] text-cl-muted mt-2.5 leading-[1.45]">
            {value.kind === 'slice'
                ? `Shares the ${sliceLabel(value.count, value.index).toLowerCase()} at full size. You can switch screens while sharing.`
                : `Shares everything${aspect ? ` (${aspect.toFixed(1)}:1)` : ''}, scaled down to fit the video encoder, so text will be small.`}
        </div>
    </div>
);

const QualityControls = ({
    resolution, setResolution, frameRate, setFrameRate, has1440p, audio, setAudio, activePreset, applyPreset, maxFps = 90, audioBlockedWhy = null, audioSlot,
}: {
    resolution: ScreenShareOptions['resolution'];
    setResolution: (v: ScreenShareOptions['resolution']) => void;
    frameRate: ScreenShareOptions['frameRate'];
    setFrameRate: (v: ScreenShareOptions['frameRate']) => void;
    /** 90 is for an entire screen only (screenShare.maxShareFps). */
    maxFps?: 60 | 90;
    has1440p: boolean;
    audio: boolean;
    setAudio: (v: boolean) => void;
    /** Why audio cannot be shared from THIS source (a Wayland window), or null. */
    audioBlockedWhy?: string | null;
    /** Replaces the "Share system audio" box: the "Share audio from: [app]" chooser of a Wayland window. */
    audioSlot?: React.ReactNode;
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
                    ...(maxFps >= 90 ? [{ value: 90 as const, label: 'Up to 90 fps' }] : []),
                    { value: 60 as const, label: '60 fps' },
                    { value: 30 as const, label: '30 fps' },
                    { value: 15 as const, label: '15 fps' },
                ]}
            />
        </div>

        <div className="w-px h-5 bg-white/[0.08]" />

        {/* Audio checkbox - off, and says why, where there is no system-audio share (Linux without PipeWire). */}
        {audioSlot ?? <ShareAudioToggle audio={audio} setAudio={setAudio} blockedWhy={audioBlockedWhy} />}
    </div>
);

const ShareAudioToggle = ({ audio, setAudio, blockedWhy = null }: { audio: boolean; setAudio: (v: boolean) => void; blockedWhy?: string | null }) => {
    // Linux shares audio through the native PipeWire addon, so whether the box can be ticked is
    // what main says about it (audio:is-capture-supported). Until it answers it stays off, never on.
    const platform = window.electronAPI?.platform;
    const [native, setNative] = useState(false);
    useEffect(() => {
        if (platform !== 'linux') return;
        let live = true;
        window.electronAPI?.isAudioCaptureSupported?.().then(v => { if (live) setNative(!!v); }, () => { /* stays off */ });
        return () => { live = false; };
    }, [platform]);
    const why = shareAudioUnavailableReason(platform, native) ?? blockedWhy;
    return (
        <span className="flex items-center gap-2" data-testid="share-audio-toggle">
            <ClCheckbox
                checked={audio && !why}
                onChange={v => setAudio(v)}
                label="Share system audio"
                disabled={!!why}
            />
            {why && <span className="text-[11px] text-cl-faint leading-snug">{why}</span>}
        </span>
    );
};

/**
 * The apps playing audio right now (main's audio:list-apps), refreshed while the picker is on a Wayland
 * window. null = not answered yet. Main turns each into an opaque handle; the names are for display only
 * and are never logged from here.
 */
function useAudioApps(enabled: boolean): { apps: AudioApp[] | null; refresh: () => void } {
    const [apps, setApps] = useState<AudioApp[] | null>(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const refresh = useCallback(() => {
        // Only asked while the chooser applies, which needs listAudioApps (see appPickerApplies).
        window.electronAPI?.listAudioApps?.().then(
            r => { if (alive.current) setApps(Array.isArray(r) ? r : []); },
            () => { if (alive.current) setApps(prev => prev ?? []); },
        );
    }, []);
    useEffect(() => {
        if (!enabled) return;
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
    }, [enabled, refresh]);
    return { apps, refresh };
}

type AppPick = { handle: string; name: string; how: 'auto' | 'manual' };

/** "Share audio from: [app]" - replaces the system-audio box for a window picked through the Wayland portal. */
const AppAudioSelect = ({ apps, pick, onPick, onOpen }: {
    apps: AudioApp[] | null;
    pick: AppPick | null;
    onPick: (a: { handle: string; name: string } | null) => void;
    onOpen: () => void;
}) => {
    const list = apps ?? [];
    // Two apps with the same display name are told apart by their program name.
    const dup = (n: string) => list.filter(a => a.name === n).length > 1;
    const options: { value: string; label: string }[] = [
        { value: '', label: 'None' },
        ...list.map(a => ({ value: a.handle, label: dup(a.name) && a.binary ? `${a.name} (${a.binary})` : a.name })),
    ];
    // The chosen app may have gone quiet since it was picked (its stream ends between songs): keep showing it.
    if (pick && !list.some(a => a.handle === pick.handle)) {
        options.push({ value: pick.handle, label: `${pick.name} (not playing right now)` });
    }
    let hint: string | null = null;
    if (apps === null) hint = 'Looking for apps that play audio…';
    else if (pick?.how === 'auto') hint = 'Matched to this window. Change it if it’s wrong.';
    else if (!pick && list.length === 0) hint = 'No app is playing audio right now. Start it, then open this list.';
    else if (!pick) hint = 'Pick the app whose audio to share.';
    return (
        <span className="flex items-center gap-2" data-testid="share-audio-app">
            <span className="text-[11px] text-cl-faint font-medium whitespace-nowrap">Share audio from</span>
            <CustomDropdown
                value={pick?.handle ?? ''}
                onChange={v => {
                    const a = list.find(x => x.handle === v) ?? (pick && pick.handle === v ? pick : null);
                    onPick(v === '' || !a ? null : { handle: a.handle, name: a.name });
                }}
                className="w-48"
                options={options}
                onOpen={onOpen}
                groupLabel="Share audio from"
            />
            {hint && <span className="text-[11px] text-cl-faint leading-snug" data-testid="share-audio-app-hint">{hint}</span>}
        </span>
    );
};

/**
 * Through the portal the picker cannot tell a window from a screen (the desktop's dialog has not been answered
 * yet), so the audio is chosen by what it IS: nothing, everything except Cipherline, or one app's.
 */
const PortalAudioChoice = ({ mode, setMode, canPickApp, appSelect }: {
    mode: PortalAudioMode;
    setMode: (m: PortalAudioMode) => void;
    canPickApp: boolean;
    appSelect: React.ReactNode;
}) => {
    const options: { value: PortalAudioMode; label: string }[] = [
        { value: 'none', label: 'None' },
        { value: 'system', label: 'Everything except Cipherline' },
        ...(canPickApp ? [{ value: 'app' as const, label: 'One app' }] : []),
    ];
    return (
        <span className="flex items-center gap-2 flex-wrap" data-testid="share-audio-portal">
            <span className="text-[11px] text-cl-faint font-medium whitespace-nowrap">Share audio</span>
            <CustomDropdown value={mode} onChange={setMode} className="w-56" options={options} groupLabel="Share audio" />
            {mode === 'app' && appSelect}
        </span>
    );
};

const QualitySummary = ({
    resolution, frameRate, activePreset, audio, maxRefreshHz, captureCeiling = 0, softwareNote = null,
}: {
    resolution: ScreenShareOptions['resolution'];
    frameRate: ScreenShareOptions['frameRate'];
    activePreset: Preset;
    audio: boolean;
    /** Highest display refresh rate available, or 0 when unknown. */
    maxRefreshHz: number;
    /** The OS capturer's own fixed frame-rate limit (Wayland/PipeWire: 60), or 0. */
    captureCeiling?: number;
    /** Up-front warning when the picked quality is more than software encoding can carry (see SoftwareStartNote). */
    softwareNote?: React.ReactNode;
}) => {
    // The frame-rate disclaimer (hard cap vs. "up to" 90) is decided in
    // ShareFpsNote.tsx so its tests can mount it. The summary line is a <div>,
    // not a <p>: the kit modal's `.mcard p` rule (22px bottom margin, 14px
    // font) outranks Tailwind's utilities on a <p> in here.
    return (
        <div>
            <div className="text-[10px] leading-snug text-cl-faint mt-2">
                {RESOLUTION_LABELS[resolution]} · {frameRate} fps
                {activePreset ? ` · ${PRESETS[activePreset].label} preset` : ' · Custom'}
                {audio ? ' · Audio on' : ''}
            </div>
            <ShareFpsDisclaimer
                frameRate={frameRate}
                maxRefreshHz={maxRefreshHz}
                captureCeiling={captureCeiling}
                className="mt-2"
            />
            {softwareNote}
        </div>
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
//
// UPDATE (2026-11-04, measured on Electron 43.8.1): that dialog opens ONCE PER ScreenCast.Start, and a
// listing and the capture that follows each make one - so listing here and then capturing was TWO
// dialogs ("I select the window and it asks again"), and a held selection is not carried from a
// listing to a later capture. Through the portal this picker therefore lists nothing: it takes the
// quality and the audio, and "Choose what to share…" starts the capture, whose own dialog is the
// one and only (step 'portal'; electron/portal-source.ts). Every other Linux session (X11) still
// enumerates, as before.
type LinuxStep = 'waiting' | 'error' | 'grid' | 'settings' | 'portal';

type PortalAudioMode = 'none' | 'system' | 'app';

export const ScreenSharePickerModal: React.FC<ScreenSharePickerModalProps> = ({ onSelect, initialAudio = false, initialAppAudio = null, liveSourceId = null, initialResolution, initialFrameRate }) => {
    const platform = window.electronAPI?.platform ?? 'windows';
    const isLinux = platform === 'linux';
    const bypassNote = showMacPickerBypassNote(platform, window.electronAPI?.macOSMajor);

    // Sources are fetched PER TYPE, not both up front (classic/non-Linux
    // tabs only — the Linux flow below uses its own single combined-request
    // state instead).
    //
    // Seeded from the last open (utils/desktopSourceCache.ts): a reopen — or
    // a first open after hovering the share button — paints the whole grid
    // on its first frame, and each tab is refreshed underneath.
    const [sourcesByType, setSourcesByType] = useState<Partial<Record<SourceType, Source[]>>>(() => {
        const seed: Partial<Record<SourceType, Source[]>> = {};
        const sc = getCachedSources('screen');
        const wi = getCachedSources('window');
        if (sc) seed.screen = sc;
        if (wi) seed.window = wi;
        return seed;
    });
    const [loading, setLoading] = useState(() => !getCachedSources('screen'));
    // Entire-screen first (classic/non-Linux tabs only): it is the first tab
    // shown, a handful of sources rather than dozens of windows, so it also
    // paints fastest.
    const [selectedTab, setSelectedTab] = useState<SourceType>('screen');
    const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
    const [resolution, setResolution] = useState<ScreenShareOptions['resolution']>(initialResolution ?? '1080p');
    const [frameRate, setFrameRate] = useState<ScreenShareOptions['frameRate']>(initialFrameRate ?? 30);
    // Quality counts as CHOSEN once the user touches a control / preset, or when it is carried over from a running share.
    const qualityTouchedRef = useRef(initialResolution !== undefined || initialFrameRate !== undefined);
    const pickResolution = (v: ScreenShareOptions['resolution']) => { qualityTouchedRef.current = true; setResolution(v); };
    const pickFrameRate = (v: ScreenShareOptions['frameRate']) => { qualityTouchedRef.current = true; setFrameRate(v); };
    const [audio, setAudio] = useState(initialAudio);
    // Linux Wayland window: the app the USER chose for the share's audio (carried over from the running share
    // on Change source counts as chosen). Until the chooser has been touched, the app is the one the window's
    // title names, worked out below - never stored here.
    const [userApp, setUserApp] = useState<{ handle: string; name: string } | null>(initialAppAudio);
    const [appTouched, setAppTouched] = useState(() => !!initialAppAudio);
    // The user's pick for ONE source (ultra-wide displays only); anything else
    // - another source, no pick - falls back to defaultLayoutFor(aspect).
    const [layoutPick, setLayoutPick] = useState<{ sourceId: string; layout: ShareLayout } | null>(null);
    const [closing, setClosing] = useState(false);   // drives the kit modal's exit animation

    // Highest display refresh rate on this machine — the hard ceiling on how
    // many distinct frames screen capture can ever produce. 0 = unknown (older
    // preload without the IPC, or a platform that doesn't report a frequency),
    // in which case we say nothing rather than guess.
    const [maxRefreshHz, setMaxRefreshHz] = useState(0);
    // A fixed frame-rate limit of the OS capturer itself (Linux Wayland/PipeWire:
    // 60), reported by main; 0 = none. Independent of any display's refresh rate.
    const [captureCeiling, setCaptureCeiling] = useState(0);
    useEffect(() => {
        let cancelled = false;
        window.electronAPI?.getDisplayRefreshRates?.()
            .then(displays => {
                if (cancelled || !displays?.length) return;
                setMaxRefreshHz(Math.max(0, ...displays.map(d => d.displayFrequency || 0)));
                setCaptureCeiling(Math.max(0, ...displays.map(d => d.captureFpsCeiling || 0)));
            })
            .catch(() => { /* stay at 0 — advisory only */ });
        return () => { cancelled = true; };
    }, []);

    // Linux only: is there a desktop chooser (Wayland portal) to wait for, or is this X11,
    // where the list is just enumerated? null = not known yet (treated as the portal).
    const [viaPortal, setViaPortal] = useState<boolean | null>(null);
    useEffect(() => {
        if (!isLinux) return;
        let alive = true;
        void captureViaPortal().then(v => { if (alive) setViaPortal(v); });
        return () => { alive = false; };
    }, [isLinux]);
    const [linuxStep, setLinuxStep] = useState<LinuxStep>('waiting');
    const [linuxSources, setLinuxSources] = useState<Source[]>([]);
    // Through the portal: what the share's audio is (nothing can be listed, so the kind of source is not known here).
    const portalMode = isLinux && viaPortal === true;
    const [portalAudio, setPortalAudio] = useState<PortalAudioMode>(() => (initialAppAudio ? 'app' : initialAudio ? 'system' : 'none'));

    // Detect if primary screen is 1440p+
    const has1440p = typeof window !== 'undefined' && window.screen.height >= 1440;

    // False once the picker is closing or gone: no more source enumerations
    // are started for it (each one is real capture work in the main process —
    // see electron/desktop-sources.ts), and a late answer is dropped.
    const openRef = useRef(true);
    useEffect(() => {
        openRef.current = true;
        return () => {
            openRef.current = false;
            cancelDesktopSourceRefresh('screen');
            cancelDesktopSourceRefresh('window');
        };
    }, []);

    // Animate out before calling onSelect — ClModal unmounts 260 ms after `open` flips.
    const dismiss = useCallback((result: ScreenShareOptions | null) => {
        openRef.current = false;
        cancelDesktopSourceRefresh('screen');
        cancelDesktopSourceRefresh('window');
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

    // Latest request per type: a slow thumbnail pass that finishes after a
    // refresh (or a newer request for the same tab) must not overwrite it.
    const fetchSeq = useRef<Record<SourceType, number>>({ screen: 0, window: 0 });

    // Click → first painted frame, → names, → first preview: the "does the
    // picker feel instant" numbers, in the call event log (diagnostics
    // report) and the console. Durations only.
    const [clickAt] = useState(() => pickerRequestedAt());
    const timing = useRef<{ click: number | null; names?: number; preview?: number; previewCached?: boolean; logged: boolean }>({ click: clickAt, logged: false });
    const fetchSourcesFor = useCallback(async (type: SourceType) => {
        const seq = ++fetchSeq.current[type];
        const current = () => openRef.current && fetchSeq.current[type] === seq;
        // A cached grid stays up (and clickable) while it is refreshed.
        if (!getCachedSources(type)) setLoading(true);
        if (window.electronAPI) {
            // Two passes, because capturing a thumbnail of every window is the
            // slow part of enumerating them (it scales with the number of
            // windows; the names do not). Pass 1 asks for names only and the
            // grid appears at once (cached previews where the source is still
            // there, placeholders otherwise); pass 2 asks for the previews and
            // fills them in. Same main-process handler, same admission list
            // (each call replaces the other's result for this type, so what
            // the user can pick is always what was last offered).
            //
            // The run is shared (utils/desktopSourceCache.refreshDesktopSources):
            // the click already started one before this modal mounted, and
            // this joins it rather than queueing a second enumeration behind
            // it in the main process.
            const api = window.electronAPI;
            const run = refreshDesktopSources(type, (t, o) => api.getDesktopSources(t, o));
            try {
                const list = await run.names;
                if (!current()) return;
                setSourcesByType(prev => ({ ...prev, [type]: list }));
                // A tile picked from the cached grid whose source has gone.
                setSelectedSourceId(id => (id && !list.some(x => x.id === id) ? null : id));
                setFetchFailed(false);
                setLoading(false);
                timing.current.names ??= performance.now();
                // The previews, in the background. A failure here leaves the
                // names (and placeholders) in place: the list is still usable.
                // The main process runs these one at a time, so this waits for
                // the names call rather than stacking on top of it.
                void run.previews.then(merged => {
                    if (!current()) return;
                    setSourcesByType(prev => ({ ...prev, [type]: merged }));
                    setSelectedSourceId(id => (id && !merged.some(x => x.id === id) ? null : id));
                    // Warm the other tab's NAMES (cheap) so switching to it is
                    // instant; its previews wait until it is actually opened.
                    const other: SourceType = type === 'screen' ? 'window' : 'screen';
                    if (!getCachedSources(other) && openRef.current) {
                        void window.electronAPI?.getDesktopSources([other], { thumbnails: false }).then(names => {
                            if (!openRef.current || getCachedSources(other)) return;
                            const l = storeNames(other, names);
                            setSourcesByType(prev => (prev[other] ? prev : { ...prev, [other]: l }));
                        }).catch(() => { /* fetched normally when the tab opens */ });
                    }
                }).catch(err => console.warn('Desktop source previews failed:', err));
            } catch (err) {
                if (!current()) return;
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
        if (current()) setLoading(false);
    }, [refreshScreenAccess]);

    // Classic (non-Linux) tabs: refresh the active tab's sources the first
    // time it is shown in this open (a cached grid is already on screen);
    // switching back to an already-refreshed tab neither re-hits the IPC call
    // nor re-prompts anything.
    const refreshed = useRef<Set<SourceType>>(new Set());
    useEffect(() => {
        if (isLinux) return;
        if (refreshed.current.has(selectedTab)) { setSelectedSourceId(null); return; }
        refreshed.current.add(selectedTab);
        void fetchSourcesFor(selectedTab);
    }, [isLinux, selectedTab, fetchSourcesFor]);

    const [openPaintMs, setOpenPaintMs] = useState<number | null>(null);
    useLayoutEffect(() => {
        const click = timing.current.click;
        if (click === null) return;
        const raf = requestAnimationFrame(() => setOpenPaintMs(performance.now() - click));
        return () => cancelAnimationFrame(raf);
    }, []);
    const firstPreviewShown = !isLinux && (sourcesByType[selectedTab] ?? []).some(hasPreview);
    useEffect(() => {
        const t = timing.current;
        if (!firstPreviewShown || t.preview !== undefined) return;
        t.preview = performance.now();
        // cached = this preview came from the last open / the hover warm-up,
        // on screen before this open's own names pass returned.
        t.previewCached = t.names === undefined;
    }, [firstPreviewShown]);
    useEffect(() => {
        const t = timing.current;
        if (t.logged || t.click === null || openPaintMs === null || t.preview === undefined) return;
        t.logged = true;
        const preview = Math.max(Math.round(t.preview - t.click), Math.round(openPaintMs));
        const names = t.names !== undefined ? Math.round(t.names - t.click) : undefined;
        logCallEvent('share_picker', {
            open_ms: Math.round(openPaintMs), preview_ms: preview, cached: !!t.previewCached, tab: selectedTab,
            ...(names !== undefined ? { list_ms: names } : {}),
        });
        console.info(`[ScreenShare] picker: painted ${Math.round(openPaintMs)} ms after click, list ${names ?? '-'} ms, first preview ${preview} ms${t.previewCached ? ' (cached)' : ''} (${selectedTab})`);
    }, [openPaintMs, firstPreviewShown, selectedTab]);

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
            // `loading` starts true (there is no cached list on Linux) and only the classic tabs ever cleared it, so
            // the grid below - the NORMAL result on X11, where the list is every screen and window - showed skeleton
            // tiles for ever: no previews, nothing to pick (Debian 13 / KDE on Xorg, 2026-11-04).
            setLoading(false);
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
            setLoading(false);
            setLinuxStep('error');
        }
    }, []);

    // Open the OS picker once, the moment the modal mounts on Linux. Same
    // fetch-on-mount shape (and same accepted synchronous-setState-before-
    // the-await lint tradeoff) as the classic tab effect above.
    // Not on the portal: there the listing would be a dialog of its own, in front of a capture that
    // opens another (the 'portal' step lists nothing). Waits for the capture path to be known.
    useEffect(() => {
        if (!isLinux || viaPortal === null) return;
        if (viaPortal) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- the capture path is only known after an async probe
            setLinuxStep('portal');
            return;
        }
        void fetchLinuxSources(); // (sets the loading state before its await, as the classic tab effect above)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLinux, viaPortal]);

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
    const canListApps = typeof window.electronAPI?.listAudioApps === 'function';
    const appPickerApplies = canListApps && windowAudioPicksApp(platform, viaPortal, chosenIsWindow);
    const audioBlockedWhy = windowAudioBlockedReason(platform, viaPortal, chosenIsWindow, canListApps);
    const { apps: audioApps, refresh: refreshAudioApps } = useAudioApps(appPickerApplies || (portalMode && canListApps && portalAudio === 'app'));
    // Default to the app that clearly belongs to this window (its title / app id names it) - and to None
    // when nothing does or two do equally: never a silent guess. A choice the user made is left alone.
    const windowTitle = chosenSource?.name;
    const autoApp = (appPickerApplies && audioApps !== null && !appTouched) ? bestAppForWindow(windowTitle, audioApps) : null;
    const appPick: AppPick | null = appTouched
        ? (userApp ? { ...userApp, how: 'manual' } : null)
        : (autoApp ? { handle: autoApp.handle, name: autoApp.name, how: 'auto' } : null);
    const appAudioSlot = appPickerApplies
        ? <AppAudioSelect
            apps={audioApps}
            pick={appPick}
            onPick={a => { setAppTouched(true); setUserApp(a); }}
            onOpen={refreshAudioApps}
        />
        : undefined;
    // What the share will carry: the chosen app on a Wayland window, else the box (minus what cannot be offered).
    const effectiveAudio = appPickerApplies ? !!appPick : audio && !audioBlockedWhy;
    // Linux, Chromium/PipeWire path: 90 is not delivered there (linuxShareDefaults.ts), so it is not offered.
    const chromiumCap = useChromiumFpsCap();
    const maxFps: 60 | 90 = chromiumCap !== null && chromiumCap < 90 ? 60 : maxShareFps(selectedSourceId);
    const clampFps = (f: ScreenShareOptions['frameRate'], id: string | null | undefined) => capFrameRate(clampShareFps(f, id), chromiumCap);
    // Picking a window while "90" was selected: it isn't offered there, so show what it will really use.
    useEffect(() => { setFrameRate(f => clampFps(f, selectedSourceId)); }, [selectedSourceId, chromiumCap]); // eslint-disable-line react-hooks/exhaustive-deps

    // Software encoding (Linux, no hardware encoder for the codec): a quality that is more than the CPU can carry is
    // fitted when it is only the untouched default, and WARNED about up front when the user chose it.
    const [softwareCodec, setSoftwareCodec] = useState<ScreenShareCodec | null>(null);
    useEffect(() => {
        if (platform !== 'linux') return;
        let alive = true;
        void (async () => {
            const [native, hw] = await Promise.all([nativeShareLikely(), probeHardwareEncoders(1920, 1080, 60)]);
            const codec = decideScreenShareCodec(getScreenShareCodecPref(), hw).codec;
            if (alive && expectSoftwareEncode({ platform, nativeLikely: native, hw, codec })) setSoftwareCodec(codec);
        })().catch(() => { /* no estimate: no warning */ });
        return () => { alive = false; };
    }, [platform]);
    const softwarePlan = softwareCodec && typeof window !== 'undefined'
        ? planSoftwareStart({
            setting: { resolution, frameRate },
            codec: softwareCodec,
            source: {
                width: Math.round(window.screen.width * (window.devicePixelRatio || 1)),
                height: Math.round(window.screen.height * (window.devicePixelRatio || 1)),
            },
            maxFps,
        })
        : null;
    useEffect(() => {
        if (!softwarePlan?.overBudget || !softwarePlan.suggested || qualityTouchedRef.current) return;
        setResolution(softwarePlan.setting.resolution);
        setFrameRate(softwarePlan.setting.frameRate as ScreenShareOptions['frameRate']);
    }, [softwarePlan?.overBudget, softwarePlan?.setting.resolution, softwarePlan?.setting.frameRate]); // eslint-disable-line react-hooks/exhaustive-deps
    const softwareNote = softwarePlan?.overBudget && softwarePlan.suggested && qualityTouchedRef.current ? (
        <ClNote tone="warn" className="mt-2" data-testid="share-software-note">
            <strong className="font-semibold text-cl-text">{shortOption({ resolution, frameRate })} is more than this PC can encode smoothly.</strong>{' '}
            Without a hardware video encoder it runs on the CPU, and this setting will likely drop frames or get lowered after about 30 seconds.{' '}
            <button type="button" className="underline font-medium" data-testid="share-software-use"
                onClick={() => { setResolution(softwarePlan.suggested!.resolution); setFrameRate(softwarePlan.suggested!.frameRate as ScreenShareOptions['frameRate']); }}>
                Use {shortOption(softwarePlan.suggested)}
            </button>
        </ClNote>
    ) : null;
    const activePreset = detectPreset(resolution, frameRate);

    // Ultra-wide handling: only whole screens, only once the preview has loaded.
    const thumbAspect = useThumbAspect(!chosenIsWindow && chosenSource && hasPreview(chosenSource) ? chosenSource.thumbnailDataUrl : undefined);
    const layoutOptions = chosenIsWindow ? [] : layoutChoices(thumbAspect);
    const layout: ShareLayout = layoutOptions.length === 0
        ? WHOLE_LAYOUT
        : (layoutPick && layoutPick.sourceId === selectedSourceId ? layoutPick.layout : defaultLayoutFor(thumbAspect));
    const layoutRow = layoutOptions.length > 0
        ? (
            <LayoutChooser
                choices={layoutOptions}
                value={layout}
                aspect={thumbAspect}
                onChange={l => { if (selectedSourceId) setLayoutPick({ sourceId: selectedSourceId, layout: l }); }}
            />
        )
        : null;

    const applyPreset = (key: 'low' | 'default' | 'high') => {
        pickResolution(PRESETS[key].resolution);
        pickFrameRate(PRESETS[key].frameRate);
    };

    const handleShare = (sourceId?: string) => {
        const id = sourceId ?? selectedSourceId;
        if (!id) return;
        // The layout only travels for the source it was chosen on (a double-click
        // on another tile passes its id without selecting it first).
        const useLayout = id === selectedSourceId && layout.kind === 'slice';
        const isWindow = id.startsWith('window:');
        if (canListApps && windowAudioPicksApp(platform, viaPortal, isWindow)) {
            // A Wayland window: the audio is the app chosen in the list (or none). Counts only in the log.
            logCallEvent('share_audio', shareAudioEventDetail({
                platform, step: 'picked', mode: 'app', apps: audioApps?.length ?? 0, how: appPick ? appPick.how : 'none',
            }));
            dismiss({
                sourceId: id, resolution, frameRate: clampFps(frameRate, id), audio: !!appPick,
                ...(appPick ? { appAudio: { handle: appPick.handle, name: appPick.name } } : {}),
                ...(useLayout ? { layout } : {}),
            });
            return;
        }
        // A source whose audio cannot be picked out is shared without it, as the box said.
        const withAudio = audio && !windowAudioBlockedReason(platform, viaPortal, isWindow, canListApps);
        dismiss({ sourceId: id, resolution, frameRate: clampFps(frameRate, id), audio: withAudio, ...(useLayout ? { layout } : {}) });
    };

    // ── Through the portal (nothing is listed) ───────────────────────────────────────────────────
    // The app picked for the audio, if the audio is "one app" and one is picked; the share's audio flag.
    const portalApp = portalMode && portalAudio === 'app' && userApp ? userApp : null;
    const portalAudioOn = portalMode && (portalAudio === 'system' || !!portalApp);
    /** The selection as the share takes it, for `sourceId`. */
    const portalOptions = (sourceId: string): ScreenShareOptions => ({
        sourceId, resolution, frameRate: clampFps(frameRate, sourceId), audio: portalAudioOn,
        ...(portalApp ? { appAudio: { handle: portalApp.handle, name: portalApp.name } } : {}),
    });
    const logPortalAudioPick = () => {
        if (portalAudio !== 'app') return;
        logCallEvent('share_audio', shareAudioEventDetail({
            platform, step: 'picked', mode: 'app', apps: audioApps?.length ?? 0, how: portalApp ? 'manual' : 'none',
        }));
    };
    /** "Choose what to share…": a NEW placeholder, so the share code takes it for another capture (one dialog). */
    const handleChoosePortal = () => {
        logPortalAudioPick();
        dismiss(portalOptions(newPortalSourceId()));
    };
    /** Mid-share: new quality / audio on the capture that is already running - the same placeholder, no dialog. */
    const handleApplyToLive = () => {
        if (!liveSourceId) return;
        logPortalAudioPick();
        dismiss(portalOptions(liveSourceId));
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

                    {/* macOS 15+: explain the system's periodic "bypass the private
                        window picker" consent before it appears (see
                        showMacPickerBypassNote). Not while the Screen Recording
                        notice owns the body — that one comes first. */}
                    {bypassNote && verdict !== 'macos-permission-required' && verdict !== 'macos-relaunch-required' && (
                        <ClNote className="mx-6 mt-3 shrink-0" data-testid="share-mac-bypass-note">
                            macOS may ask whether Cipherline can <span className="text-cl-text">bypass the system private window picker</span>.
                            Choose <span className="font-semibold text-cl-text">Allow</span>: Cipherline uses its own picker so it can share
                            a window&apos;s sound and show annotations over what you share. macOS asks again about once a month.
                        </ClNote>
                    )}

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
                        {layoutRow}
                        <div className="flex items-center gap-4 flex-wrap">
                            <QualityControls
                                resolution={resolution} setResolution={pickResolution}
                                frameRate={frameRate} setFrameRate={pickFrameRate} maxFps={maxFps}
                                has1440p={has1440p} audio={audio} setAudio={setAudio} audioBlockedWhy={audioBlockedWhy} audioSlot={appAudioSlot}
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
                        <QualitySummary resolution={resolution} frameRate={frameRate} activePreset={activePreset} audio={effectiveAudio} maxRefreshHz={maxRefreshHz} captureCeiling={captureCeiling} softwareNote={softwareNote} />
                    </div>
                </>
            ) : (
                <>
                    {linuxStep === 'portal' && (
                        <>
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 flex flex-col gap-5" data-testid="share-portal-step">
                                <div className="flex items-start gap-3 rounded-xl bg-cl-surface border border-white/[0.06] p-3">
                                    <div className="w-10 h-10 rounded-lg bg-cl-lume/15 flex items-center justify-center shrink-0">
                                        <Monitor className="w-5 h-5 text-cl-lume" />
                                    </div>
                                    <div className="min-w-0">
                                        {/* <div>s, not <p>s: the kit modal's `.mcard p` rule beats these utilities (see ClNote). */}
                                        <div className="text-sm font-semibold text-cl-text">Your desktop picks what to share</div>
                                        <div className="text-xs text-cl-faint leading-snug mt-0.5">
                                            On Wayland the choice of window or screen is made in your desktop&apos;s own dialog, once.
                                            Set the quality and audio here, then choose.
                                        </div>
                                    </div>
                                </div>
                                <QualityControls
                                    resolution={resolution} setResolution={pickResolution}
                                    frameRate={frameRate} setFrameRate={pickFrameRate} maxFps={maxFps}
                                    has1440p={has1440p} audio={portalAudioOn} setAudio={() => {}} audioBlockedWhy={null}
                                    activePreset={activePreset} applyPreset={applyPreset}
                                    audioSlot={
                                        <PortalAudioChoice
                                            mode={portalAudio} setMode={setPortalAudio} canPickApp={canListApps}
                                            appSelect={
                                                <AppAudioSelect
                                                    apps={audioApps}
                                                    pick={portalApp ? { ...portalApp, how: 'manual' } : null}
                                                    onPick={a => { setAppTouched(true); setUserApp(a); }}
                                                    onOpen={refreshAudioApps}
                                                />
                                            }
                                        />
                                    }
                                />
                                <QualitySummary resolution={resolution} frameRate={frameRate} activePreset={activePreset} audio={portalAudioOn} maxRefreshHz={maxRefreshHz} captureCeiling={captureCeiling} softwareNote={softwareNote} />
                            </div>
                            <div className="shrink-0 border-t border-white/[0.06] bg-cl-abyss rounded-b-2xl px-6 py-3.5 flex items-center justify-end gap-2">
                                <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                                {liveSourceId && (
                                    <ClButton variant="ghost" size="sm" onClick={handleApplyToLive}>
                                        Apply to current share
                                    </ClButton>
                                )}
                                <ClButton variant="primary" size="sm" onClick={handleChoosePortal} pressAnim="send">
                                    Choose what to share…
                                    <ArrowRight className="w-3 h-3" />
                                </ClButton>
                            </div>
                        </>
                    )}

                    {linuxStep === 'waiting' && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
                            <Loader2 className="w-8 h-8 text-cl-lume animate-spin" />
                            <p className="text-cl-faint text-sm m-0 text-center max-w-[320px] leading-snug">
                                Looking for windows and screens…
                            </p>
                            <ClButton variant="ghost" size="sm" onClick={handleCancel}>Cancel</ClButton>
                        </div>
                    )}

                    {linuxStep === 'error' && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
                            <AlertTriangle className="w-8 h-8 text-amber-400" />
                            <p className="text-cl-faint text-sm m-0 text-center max-w-[340px] leading-snug">
                                {viaPortal === false ? (
                                    <>Cipherline couldn&apos;t find a screen or window to share on this display.</>
                                ) : (
                                    <>
                                        The system's picker closed without a selection —
                                        that's your desktop's own dialog, not Cipherline's, and on
                                        some Wayland setups it can close itself before you can act.
                                        If no dialog appeared at all, Wayland screen sharing needs
                                        xdg-desktop-portal (with your desktop&apos;s portal backend)
                                        and PipeWire to be installed and running.
                                    </>
                                )}
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
                                        {/* <div>s, not <p>s: the kit modal's `.mcard p` rule beats these utilities (see ClNote). */}
                                        <div className="text-[10px] uppercase tracking-wide text-cl-faint font-semibold mb-0.5">
                                            {chosenIsWindow ? 'Application Window' : 'Entire Screen'}
                                        </div>
                                        <div className="text-sm font-semibold text-cl-text truncate">
                                            {chosenSource?.name ?? 'Selected source'}
                                        </div>
                                    </div>
                                </div>

                                {layoutRow}
                                <QualityControls
                                    resolution={resolution} setResolution={pickResolution}
                                    frameRate={frameRate} setFrameRate={pickFrameRate} maxFps={maxFps}
                                    has1440p={has1440p} audio={audio} setAudio={setAudio} audioBlockedWhy={audioBlockedWhy} audioSlot={appAudioSlot}
                                    activePreset={activePreset} applyPreset={applyPreset}
                                />
                                <QualitySummary resolution={resolution} frameRate={frameRate} activePreset={activePreset} audio={effectiveAudio} maxRefreshHz={maxRefreshHz} captureCeiling={captureCeiling} softwareNote={softwareNote} />
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
