import React from 'react';
import ReactDOM from 'react-dom';
import { PhoneCall, Mic, MicOff, Video, VideoOff, ScreenShare, X, ChevronDown, ChevronLeft, Headphones, HeadphoneOff, Maximize2, Minimize2, Monitor, Sliders, Check, Volume2, VolumeX } from 'lucide-react';
import { useCallContextSafe } from '../../contexts/CallContext';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useMediaDevices, buildDeviceRowModel } from '../../hooks/useMediaDevices';
import type { VoiceSettingsHook } from '../../hooks/useVoiceSettings';
import type { ContextMenuItem } from '../primitives/ContextMenu';
import type { ScreenShareOptions } from '../ScreenSharePickerModal';
import { ClButton } from '../cl';
import { ClSlider } from '../ClSlider';
import { playIco } from '../../utils/clPhysics';
import { bumpStreak, firesAt, type Streak } from '../../utils/eggStreak';
import { computeTooltipPlacement, type TooltipPlacement } from '../cl/tooltipPlacement';

interface ControlBarProps {
    localParticipant: any;
    isLocalDeafened: boolean;
    onToggleMic: () => void;
    onToggleDeafen: () => void;
    onToggleCamera: () => void;
    onToggleScreenshare: () => void;
    onOpenScreenSharePicker: () => void;
    onAdjustScreenShareQuality: (resolution: ScreenShareOptions['resolution'], frameRate: ScreenShareOptions['frameRate']) => void;
    /** Toggle share audio on/off for the currently-running share. */
    onToggleScreenShareAudio?: () => void;
    /** Currently-active share resolution — used to seed the Adjust Quality panel so
     *  it reflects what's actually running instead of a hardcoded default. */
    currentShareResolution?: ScreenShareOptions['resolution'];
    currentShareFrameRate?: ScreenShareOptions['frameRate'];
    currentShareAudio?: boolean;
    onLeave: () => void;
    showFullscreenButton?: boolean;
    compact?: boolean;
    /** P13: per-channel permission flags. Each defaults to true (permissive) when
     *  the parent passes undefined — DM/group calls have no per-channel concept,
     *  and LiveKit room rules are the authoritative enforcement layer. */
    canSpeak?: boolean;
    canVideo?: boolean;
    canScreenShare?: boolean;
    /** Server-moderation flags — set when a moderator has disabled the local
     *  participant's track via the call-mute API. The SFU enforces these via
     *  canPublishSources, but we also gray out the matching button so the user
     *  immediately sees they've been restricted rather than clicking a button
     *  that silently does nothing. Defaults false (permissive) when absent. */
    serverMutedAudio?: boolean;
    serverMutedVideo?: boolean;
    serverMutedScreenShare?: boolean;
    /** True when a moderator has server-deafened this participant (track_type='deafen').
     *  Grays out both the mic button (can't speak) and the deafen button (can't
     *  override the server deafen by toggling self-deafen). */
    isServerDeafened?: boolean;
    /** Optional — SidebarConference is the only renderer and always has this,
     *  but every right-click menu below no-ops without it (rather than being
     *  required and forcing every other future caller to thread it through). */
    voice?: VoiceSettingsHook;
}

const QUALITY_PRESETS = {
    low:     { resolution: '720p'  as const, frameRate: 30 as const, label: 'Low'     },
    default: { resolution: '1080p' as const, frameRate: 30 as const, label: 'Default' },
    high:    { resolution: '1080p' as const, frameRate: 60 as const, label: 'High'    },
} satisfies Record<string, { resolution: ScreenShareOptions['resolution']; frameRate: ScreenShareOptions['frameRate']; label: string }>;

const QUALITY_FPS: ScreenShareOptions['frameRate'][] = [90, 60, 30, 15];

function buildResolutionOptions(has1440p: boolean): { value: ScreenShareOptions['resolution']; label: string }[] {
    return [
        { value: 'source', label: 'Source' },
        ...(has1440p ? [{ value: '1440p' as const, label: '1440p' }] : []),
        { value: '1080p', label: '1080p' },
        { value: '720p',  label: '720p'  },
        { value: '480p',  label: '480p'  },
    ];
}

// Tone → inline colour. 'live' = active lume, 'off' = red (muted/deafened),
// 'danger' = solid red (leave), 'neutral' = calm translucent. Disabled wins.
// Module-scope (not inside ControlBar) for the same reason CtrlBtn below is:
// it's a pure constant, no reason to re-allocate it every render.
type Tone = 'neutral' | 'live' | 'off' | 'danger';
const toneStyle: Record<Tone, React.CSSProperties> = {
    // No fill at all — an idle control is a hairline ring over the blurred
    // backdrop, nothing more. The ring itself lives in CSS (.cl-ctrlbtn):
    // setting it inline here would outrank the :focus-visible rule and
    // silently swallow the focus indicator.
    neutral: { background: 'transparent', color: 'rgba(255,255,255,0.92)' },
    live:    { background: 'var(--cl-lume)', color: 'var(--cl-on-lume)' },
    off:     { background: 'rgba(255,107,94,0.16)', color: 'var(--cl-flash)' },
    // No drop shadow — it pooled under the button and read as a backing plate.
    danger:  { background: 'var(--cl-flash)', color: '#fff' },
};

// Stable component (NOT re-declared on every ControlBar render — that would
// change component identity and force React to unmount/remount the chip row
// on every state change, losing click events mid-reconciliation).
//
// Renders through ClButton's own `chip` pill styling (`.clb--chip .cap`:
// 5px/13px padding, 11px uppercase text — cl-kit-ext.css) rather than a
// hand-rolled `size="sm"` + Tailwind override. That override was the bug:
// `size="sm"` plus Tailwind utility classes (`px-2.5 py-1 text-[11px]`) put
// the shrink on the OUTER `.clb` wrapper span, but ClButton's compact sizing
// is driven by CSS rules targeting the INNER `.cap` surface (`.clb--sm .cap`
// — same specificity as `.clb--chip .cap`, so whichever wasn't present just
// lost outright). Every chip was silently rendering at full "small button"
// size (9px/18px padding, 13.5px font) instead of the intended tiny pill —
// that's what forced the Resolution row into three ragged lines and pushed
// Frame Rate's fourth chip off the panel's right edge. `fullWidth` stretches
// each chip to fill its CSS-grid cell, so a row reads as equal-width columns
// no matter how the label lengths vary ("Source" vs "480p").
const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <ClButton chip fullWidth variant="ghost" active={active} onClick={onClick}>
        {children}
    </ClButton>
);

// Stable component — same reasoning as Chip above, but this is the one that
// actually matters: mic/deafen/camera/screenshare/fullscreen/leave are ALL
// CtrlBtn. This used to be declared inside ControlBar's render body, so every
// re-render (which happens several times a second in an active call — any
// speaker starting/stopping talking bounces useParticipants(), plus the call
// stats poll) gave every single control button a brand-new component
// identity. React then unmounts and remounts the real <button> DOM nodes on
// every render. A click whose mousedown→mouseup straddles one of those
// remounts never reaches this onClick — the browser has nothing live to
// dispatch `click` to — so it's silently swallowed and the control appears
// to do nothing. That's the "have to press twice" bug. It also explains the
// sluggish feel even when a click *does* land: :active-driven press feedback
// and the tone/icon cross-fade transitions are bound to the DOM node, so a
// node that gets replaced mid-press or mid-transition just snaps instead of
// animating. `bumpSpam` (a stable useCallback from useSpamStreak) is passed
// in as a prop instead of closed over, since this no longer lives inside
// ControlBar's scope.
const CtrlBtn = ({ tone = 'neutral', disabled, title, onClick, onContextMenu, onMouseEnter, onMouseLeave, children, style, className = '', spamKey, pulse, bumpSpam }: {
    tone?: Tone; disabled?: boolean; title?: string;
    /** Standing state worth a slow glow: 'off' (muted/deafened, red) or
     *  'live' (publishing something, lume). Omitted = no glow. */
    pulse?: 'off' | 'live';
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Device/level picker for mic, deafen, camera — see the menu builders below. */
    onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void; onMouseLeave?: () => void;
    children: React.ReactNode; style?: React.CSSProperties; className?: string;
    /** Enables the spam easter egg for this control. Omitted on Leave. */
    spamKey?: string;
    /** Omitted on the mic button on purpose — see the bumpMicDizzy comment
     *  below, mic runs its own separate dizzy egg instead of the spam ladder. */
    bumpSpam?: (key: string, btn: HTMLElement | null) => void;
}) => (
    <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={e => {
            if (spamKey) bumpSpam?.(spamKey, e.currentTarget as HTMLElement);
            onClick?.(e);
        }}
        onContextMenu={onContextMenu}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        data-pulse={disabled ? undefined : pulse}
        data-tone={tone}
        className={`cl-ctrlbtn ${className}`}
        style={{
            ...(disabled
                ? { background: 'rgba(255,255,255,0.035)', color: 'rgba(255,255,255,0.28)', boxShadow: 'none' }
                : toneStyle[tone]),
            ...style,
        }}
    >
        {children}
    </button>
);

// ── Right-click device/level menus (mic, deafen, camera) ────────────────────
// Shared shape: a "Default …" row followed by real devices, each a checkbox row
// that flips the picked device without closing the menu — the caller re-derives
// the row list with the new id and calls ctx.updateItems.
//
// The row model itself (including the hasRealDeviceInfo gate that keeps a
// pre-permission placeholder list from rendering as a real device) lives in
// useMediaDevices.ts so it can be unit-tested — vitest here is node-env and only
// collects *.test.ts, so nothing in this .tsx is reachable from a test.
function buildDeviceRows(
    devices: MediaDeviceInfo[],
    currentId: string,
    defaultLabel: string,
    onPick: (id: string) => void,
): ContextMenuItem[] {
    return buildDeviceRowModel(devices, currentId, defaultLabel).map(r => ({
        label: r.label,
        checked: r.checked,
        onSelect: () => onPick(r.id),
    }));
}

// A slider row rendered via ContextMenu's custom-row escape hatch. No local
// numeric readout — ClSlider already shows a live value bubble while
// dragging, and a readout here would just go stale (the menu's item list is
// a snapshot in useContextMenu's state, not re-rendered on every ControlBar
// re-render, so a value we read from `voice.settings` at build time can't
// track the debounced write that lands ~120ms after release anyway).
function volumeRow(label: string, value: number, onChange: (v: number) => void): ContextMenuItem {
    return {
        custom: (
            <div className="ctxm-vol-row">
                <span className="ctxm-vol-label">{label}</span>
                <ClSlider min={0} max={300} step={1} value={value} onChange={onChange} resetValue={100} formatLabel={v => `${v}%`} />
            </div>
        ),
    };
}

const reducedMotion = () =>
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Spam easter eggs ─────────────────────────────────────────────────────────
// Escalating reward for mashing a control: wobble → barrel roll → rainbow, with
// a floating combo counter. Decorative only — the real toggle always runs, and
// the leave button is deliberately excluded (mashing hang-up is not a joke we
// want to make while someone is trying to leave).
/** Mic dizzy has its own, slower window than the spam ladder (catalog). */
const MIC_DIZZY_WINDOW_MS = 2500;
const MIC_DIZZY_AT = 5;

const SPAM_WINDOW_MS = 900;   // gap that keeps a streak alive
const SPAM_WOBBLE_AT = 4;
const SPAM_ROLL_AT   = 8;
const SPAM_PARTY_AT  = 14;
const COMBO_TAUNTS: Record<number, string> = {
    8:  'nice',
    12: 'ok chill',
    18: 'RSI warning',
    25: 'touch grass',
};

function useSpamStreak() {
    const lastAtRef = React.useRef<Record<string, number>>({});
    const countRef = React.useRef<Record<string, number>>({});

    return React.useCallback((key: string, btn: HTMLElement | null) => {
        if (!btn) return;
        const now = performance.now();
        const streak = now - (lastAtRef.current[key] ?? 0) < SPAM_WINDOW_MS
            ? (countRef.current[key] ?? 0) + 1
            : 1;
        lastAtRef.current[key] = now;
        countRef.current[key] = streak;

        if (streak < SPAM_WOBBLE_AT || reducedMotion()) return;

        const cls = streak >= SPAM_ROLL_AT ? 'ctrl-roll' : 'ctrl-wobble';
        btn.classList.remove('ctrl-wobble', 'ctrl-roll');
        void btn.offsetWidth;
        btn.classList.add(cls);
        btn.addEventListener('animationend', () => btn.classList.remove(cls), { once: true });

        if (streak >= SPAM_PARTY_AT && !btn.classList.contains('ctrl-party')) {
            btn.classList.add('ctrl-party');
            btn.addEventListener('animationend', () => btn.classList.remove('ctrl-party'), { once: true });
        }

        const badge = document.createElement('span');
        badge.className = 'ctrl-combo';
        badge.textContent = COMBO_TAUNTS[streak] ?? `×${streak}`;
        btn.appendChild(badge);
        badge.addEventListener('animationend', () => badge.remove(), { once: true });
    }, []);
}

export const ControlBar = ({
    localParticipant,
    isLocalDeafened,
    onToggleMic,
    onToggleDeafen,
    onToggleCamera,
    onToggleScreenshare,
    onOpenScreenSharePicker,
    onAdjustScreenShareQuality,
    onToggleScreenShareAudio,
    currentShareResolution,
    currentShareFrameRate,
    currentShareAudio,
    onLeave,
    showFullscreenButton,
    canSpeak = true,
    canVideo = true,
    canScreenShare = true,
    serverMutedAudio = false,
    serverMutedVideo = false,
    serverMutedScreenShare = false,
    isServerDeafened = false,
    voice,
}: ControlBarProps) => {
    // Combine role-permission gates (P13) with server-moderation flags.
    // Role gates: prevent un-mute/enable when the channel permission bit is absent.
    // Server-mute gates: a moderator explicitly restricted this track — disable
    //   the control entirely so it's visually clear and the user doesn't waste
    //   time clicking a button the SFU will silently reject anyway.
    const micDisabled    = (!canSpeak && !localParticipant?.isMicrophoneEnabled)
                           || serverMutedAudio || isServerDeafened;
    const cameraDisabled = (!canVideo && !localParticipant?.isCameraEnabled)
                           || serverMutedVideo;
    const shareDisabled  = (!canScreenShare && !localParticipant?.isScreenShareEnabled)
                           || serverMutedScreenShare;
    // Deafen button: disabled when the server has deafened this participant —
    // toggling self-deafen can't override the server restriction (isLocalDeafened
    // stays true via baseServerDeafened regardless of the self-deafen state).
    const deafenDisabled = isServerDeafened;
    // Free-tier gate: video + screen-share are Pro features. Free accounts can
    // still hear/see others (canSubscribe) — they just can't publish their own
    // camera/screen. The LiveKit token enforces this; here we make the buttons
    // route to the upgrade sheet instead of silently failing.
    const { canPublishVideo, promptUpgrade } = useSubscription();
    const videoLocked = !canPublishVideo;
    const callCtx = useCallContextSafe();
    const isScreensharing = !!localParticipant?.isScreenShareEnabled;
    const bumpSpam = useSpamStreak();

    // Mic dizzy (catalog: "mute toggled 5× in 2.5s → mic spins dizzy").
    //
    // The mic deliberately does NOT use spamKey/bumpSpam like every other
    // control. Both eggs would target the same `.cl-ico`, and the spam
    // ladder's `.cl-ctrlbtn.ctrl-wobble .cl-ico` (specificity 0,3,0) outranks
    // `.cl-ico.play-dizzy` (0,2,0) — so at streak 4 the wobble would swallow
    // the dizzy at streak 5, non-deterministically depending on whether the
    // wobble was still running. The other controls keep the combo ladder
    // untouched.
    const micStreakRef = React.useRef<Streak | undefined>(undefined);
    const micDizziedRef = React.useRef(false);
    const bumpMicDizzy = React.useCallback((btn: HTMLElement) => {
        const s = bumpStreak(micStreakRef.current, Date.now(), MIC_DIZZY_WINDOW_MS);
        micStreakRef.current = s;
        if (!firesAt(s, MIC_DIZZY_AT) || micDizziedRef.current) return;
        micDizziedRef.current = true;                       // once per mount (rule 6)
        // force: dizzy is in ICO_PAYOFFS, so it may interrupt the routine
        // mute/unmute icon swap — and nothing may interrupt it (rule 10).
        playIco(btn.querySelector<HTMLElement>('.cl-ico'), 'play-dizzy', true);
    }, []);

    // ── Right-click device/level menus ────────────────────────────────────────
    // Persistence + Settings-menu reflection come for free: every setter below
    // writes into useVoiceSettings' secureLocalStore-backed state, the same
    // hook VoiceVideoSettings.tsx reads. Live mid-call effect is handled where
    // that state is consumed (SidebarConference for mic/camera/speaker device,
    // the voice-processor gain node for mic/speaker volume) — not here.
    const { inputDevices, outputDevices, videoDevices } = useMediaDevices();
    const micMenu    = useContextMenu();
    const deafenMenu = useContextMenu();
    const cameraMenu = useContextMenu();

    const openMicMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (!voice) return;
        const build = (currentId: string): ContextMenuItem[] => [
            ...buildDeviceRows(inputDevices, currentId, 'Default Microphone', pickedId => {
                voice.setMicDeviceId(pickedId);
                micMenu.updateItems(build(pickedId));
            }),
            { divider: true },
            volumeRow('Mic Volume', voice.settings.micVolume, voice.setMicVolume),
        ];
        micMenu.open(e, build(voice.settings.micDeviceId), 'Microphone');
    };

    const openDeafenMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (!voice) return;
        const build = (currentId: string): ContextMenuItem[] => [
            ...buildDeviceRows(outputDevices, currentId, 'Default Speakers', pickedId => {
                voice.setSpeakerDeviceId(pickedId);
                deafenMenu.updateItems(build(pickedId));
            }),
            { divider: true },
            volumeRow('Output Volume', voice.settings.speakerVolume, voice.setSpeakerVolume),
        ];
        deafenMenu.open(e, build(voice.settings.speakerDeviceId), 'Speaker');
    };

    const openCameraMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        // Open whenever there's a voice session, regardless of camera count.
        //
        // This used to bail on `videoDevices.length <= 1`, on the theory that a
        // single-camera menu isn't "worth showing". The common case is exactly
        // one webcam, so the common case was a right-click that did literally
        // nothing — no menu, no feedback, indistinguishable from the feature
        // being broken. (The mic and speaker menus never had this guard, which
        // is why only the camera button felt dead.) A one-device menu is still
        // useful: it confirms the menu exists, names the camera, and shows
        // which entry is selected. The placeholder-list case it was also
        // covering is handled properly inside buildDeviceRowModel.
        if (!voice) return;
        const build = (currentId: string): ContextMenuItem[] =>
            buildDeviceRows(videoDevices, currentId, 'Default Camera', pickedId => {
                voice.setCameraDeviceId(pickedId);
                cameraMenu.updateItems(build(pickedId));
            });
        cameraMenu.open(e, build(voice.settings.cameraDeviceId), 'Camera');
    };

    // ── Screenshare button state ──────────────────────────────────────────────
    const [ssHovered, setSsHovered] = React.useState(false);
    const [ssMenuOpen, setSsMenuOpen] = React.useState(false);
    const [ssMenuMode, setSsMenuMode] = React.useState<'main' | 'quality'>('main');

    // Prevent CSS transitions from playing on the very first render (avoids X flashing)
    const [ssTransReady, setSsTransReady] = React.useState(false);
    React.useEffect(() => {
        if (isScreensharing) {
            const id = requestAnimationFrame(() => setSsTransReady(true));
            return () => cancelAnimationFrame(id);
        } else {
            setSsTransReady(false);
            setSsHovered(false);
        }
    }, [isScreensharing]);

    // Brief "just started" flash animation
    const [justStartedSharing, setJustStartedSharing] = React.useState(false);
    const prevSharingRef = React.useRef(false);
    React.useEffect(() => {
        if (isScreensharing && !prevSharingRef.current) {
            setJustStartedSharing(true);
            const t = setTimeout(() => setJustStartedSharing(false), 700);
            return () => clearTimeout(t);
        }
        prevSharingRef.current = isScreensharing;
    }, [isScreensharing]);

    // ── Portal-based menu (avoids overflow-hidden clipping) ───────────────────
    // Position is computed with `computeTooltipPlacement` — the same
    // viewport flip/clamp maths the portal tooltip primitive uses
    // (`cl/tooltipPlacement.ts`) — rather than a second hand-rolled
    // positioning implementation. The old version only ever anchored the
    // panel's bottom-right corner to the chevron's bottom-right corner with
    // no clamping: near a screen edge (chevron close to the left, or a
    // panel wider than the gap to that edge) `right` could exceed the
    // window width and push the panel's left edge off-screen. Reusing the
    // shared primitive gets edge-of-display clamping, and an automatic
    // top/bottom flip, for free.
    const chevronRef = React.useRef<HTMLDivElement>(null);
    const menuPanelRef = React.useRef<HTMLDivElement>(null);
    const [menuPlacement, setMenuPlacement] = React.useState<TooltipPlacement | null>(null);

    const positionMenu = React.useCallback(() => {
        if (!chevronRef.current || !menuPanelRef.current) return;
        const a = chevronRef.current.getBoundingClientRect();
        const t = menuPanelRef.current.getBoundingClientRect();
        setMenuPlacement(computeTooltipPlacement(
            { left: a.left, top: a.top, width: a.width, height: a.height },
            { width: t.width, height: t.height },
            { width: window.innerWidth, height: window.innerHeight },
            { preferred: 'top', gap: 8 },
        ));
    }, []);

    const openMenu = () => {
        // Cleared (not immediately recomputed) — the panel isn't in the DOM
        // yet on this same tick, so there's nothing to measure. The
        // layout effect below measures it the instant it mounts and the
        // panel stays `visibility:hidden` until then (see menuPortal).
        setMenuPlacement(null);
        setSsMenuMode('main');
        setSsMenuOpen(v => !v);
    };

    // Close on outside click. Both the chevron trigger and the portal panel
    // count as "inside" — predicate form so we can include both disjoint
    // DOM subtrees. Consuming the click prevents it from reaching the call
    // tile / control underneath when the user dismisses the menu.
    useDismissOnOutsideClick(
        React.useCallback(
            (t: Node) => !!menuPanelRef.current?.contains(t) || !!chevronRef.current?.contains(t),
            [],
        ),
        ssMenuOpen,
        () => setSsMenuOpen(false),
    );

    React.useEffect(() => {
        if (!isScreensharing) { setSsMenuOpen(false); setSsMenuMode('main'); }
    }, [isScreensharing]);

    // ── Quality sub-panel state ───────────────────────────────────────────────
    const has1440p = typeof window !== 'undefined' && window.screen.height >= 1440;
    const resolutionOptions = React.useMemo(() => buildResolutionOptions(has1440p), [has1440p]);
    const [qResolution, setQResolution] = React.useState<ScreenShareOptions['resolution']>(currentShareResolution ?? '1080p');
    const [qFps, setQFps] = React.useState<ScreenShareOptions['frameRate']>(currentShareFrameRate ?? 30);

    // (Re)measure and place the menu whenever it's open, whenever it
    // switches between the main and quality sub-views (their heights
    // differ), and whenever the 90fps footnote toggles on/off (also a
    // height change) — each of those needs a fresh clamp, not just the
    // initial open.
    React.useLayoutEffect(() => {
        if (!ssMenuOpen) return;
        positionMenu();
    }, [ssMenuOpen, ssMenuMode, qFps, positionMenu]);

    // Recalculate position on window resize while open.
    React.useEffect(() => {
        if (!ssMenuOpen) return;
        const handler = () => positionMenu();
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, [ssMenuOpen, positionMenu]);

    // Re-sync the panel whenever the active share's quality changes externally
    // (e.g. Change Source replaces the active resolution). We intentionally do
    // NOT listen on ssMenuMode here — doing so would reset the user's pending
    // chip selection the moment they navigate into the sub-panel in some
    // render orderings.
    React.useEffect(() => {
        if (currentShareResolution) setQResolution(currentShareResolution);
        if (currentShareFrameRate)  setQFps(currentShareFrameRate);
    }, [currentShareResolution, currentShareFrameRate]);

    const activePreset = (Object.entries(QUALITY_PRESETS) as [keyof typeof QUALITY_PRESETS, typeof QUALITY_PRESETS[keyof typeof QUALITY_PRESETS]][])
        .find(([, p]) => p.resolution === qResolution && p.frameRate === qFps)?.[0];

    const handleApplyQuality = () => {
        setSsMenuOpen(false);
        onAdjustScreenShareQuality(qResolution, qFps);
    };

    // ── Shared button styles ──────────────────────────────────────────────────
    const iconSize = 'w-4 h-4';

    const ssIconTransition = ssTransReady ? 'opacity 180ms ease, transform 220ms cubic-bezier(0.34,1.56,0.64,1)' : 'none';

    // ── Portal menu panel ─────────────────────────────────────────────────────
    // 336px (was 240px) — the Quality sub-panel's Frame Rate row needs 4
    // equal-width `chip`-styled columns in one line without truncating "90
    // fps*" (the longest label — the asterisk is what pushes it past "60/30/
    // 15 fps"); measuring the real rendered pill (13px horizontal padding +
    // 11px uppercase letter-spaced text, from cl-kit-ext.css's `.clb--chip
    // .cap`) against a harness of this exact markup is what pinned the
    // number — both 296px and 320px still ellipsis-clipped "90 fps*" by a
    // couple of px. Widened for both sub-views since they share one panel;
    // the Screen Share main view still reads comfortably, it just has more
    // breathing room.
    //
    // Rendered as soon as `ssMenuOpen` so `menuPanelRef` exists to measure —
    // `visibility: hidden` (via `menuPlacement` being null on the very first
    // render) keeps that unpositioned frame invisible, same technique
    // `useClTooltip` uses for the same reason.
    const menuPortal = ssMenuOpen && ReactDOM.createPortal(
        <div
            ref={menuPanelRef}
            className="bg-cl-deep border border-white/[0.1] rounded-2xl shadow-[0_-12px_40px_rgba(0,0,0,0.75)] overflow-hidden select-none"
            style={{
                position: 'fixed',
                left: menuPlacement ? menuPlacement.left : -9999,
                top: menuPlacement ? menuPlacement.top : -9999,
                visibility: menuPlacement ? 'visible' : 'hidden',
                width: 336,
                zIndex: 9999,
                animation: menuPlacement ? 'ss-gate-enter 0.22s cubic-bezier(0.34,1.56,0.64,1) forwards' : 'none',
            }}
        >
            {/* ── MAIN PANEL ── */}
            <div style={{ display: ssMenuMode === 'main' ? 'block' : 'none' }}>
                <div className="px-3.5 py-2.5 border-b border-white/[0.06] flex items-center gap-2">
                    <div className="w-5 h-5 rounded-md bg-cl-lume/15 flex items-center justify-center shrink-0">
                        <ScreenShare className="w-3 h-3 text-cl-lume" />
                    </div>
                    <span className="text-[13px] text-cl-text font-semibold">Screen Share</span>
                </div>

                <ClButton
                    variant="ghost"
                    fullWidth
                    row
                    onClick={() => { setSsMenuOpen(false); onOpenScreenSharePicker(); }}
                >
                    <Monitor className="w-4 h-4 text-cl-faint shrink-0" />
                    {/* flex-1 is not cosmetic padding — it is what makes this row
                        line up with its two siblings. `.clb--row .cap>span` is
                        width:100% + justify-content:flex-start, and the label text
                        inherits text-align:center, so the title is centred inside
                        THIS div rather than inside the row. Without flex-1 the div
                        collapses to its content width and "Change Source" centres
                        over a narrow box hard against the icon, while "Adjust
                        Quality" and "Enable Audio" (both flex-1) centre over the
                        full row. That mismatch was visible as the first row simply
                        being off-centre from the other two. */}
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold m-0 leading-none mb-1">Change Source</p>
                        <p className="text-[11px] text-cl-faint m-0 leading-none">Pick a different window or screen</p>
                    </div>
                </ClButton>

                <ClButton
                    variant="ghost"
                    fullWidth
                    row
                    onClick={() => setSsMenuMode('quality')}
                >
                    <Sliders className="w-4 h-4 text-cl-faint shrink-0" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold m-0 leading-none mb-1">Adjust Quality</p>
                        <p className="text-[11px] text-cl-faint m-0 leading-none">Change resolution or frame rate</p>
                    </div>
                    <ChevronDown className="w-3.5 h-3.5 text-cl-faint shrink-0 -rotate-90" />
                </ClButton>

                {/* Audio toggle — shown only if the parent wired a handler so we can
                    republish with audio on/off mid-share without re-picking a source. */}
                {onToggleScreenShareAudio && (
                    <ClButton
                        variant="ghost"
                        fullWidth
                        row
                        onClick={() => { setSsMenuOpen(false); onToggleScreenShareAudio(); }}
                        className="border-t border-white/[0.06]"
                    >
                        {currentShareAudio
                            ? <Volume2  className="w-4 h-4 text-cl-lume shrink-0" />
                            : <VolumeX className="w-4 h-4 text-cl-faint shrink-0" />
                        }
                        <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold m-0 leading-none mb-1">
                                {currentShareAudio ? 'Disable Audio' : 'Enable Audio'}
                            </p>
                            <p className="text-[11px] text-cl-faint m-0 leading-none">
                                {currentShareAudio ? 'Stop sharing system audio' : 'Share system or window audio'}
                            </p>
                        </div>
                    </ClButton>
                )}
            </div>

            {/* ── QUALITY PANEL ── */}
            <div style={{ display: ssMenuMode === 'quality' ? 'block' : 'none' }}>
                <div className="px-3.5 py-2.5 border-b border-white/[0.06] flex items-center gap-2">
                    <ClButton
                        icon
                        variant="ghost"
                        onClick={() => setSsMenuMode('main')}
                        /* clb--icon-xs, NOT `w-6 h-6`. ClButton puts className on
                           the outer .clb WRAPPER, never on the .cap that actually
                           draws the button, so `w-6 h-6` shrank the wrapper to 24px
                           while `.clb--icon .cap` stayed 46px — a 46px face
                           overflowing a 24px box in every direction, which is what
                           was covering the header icon and title next to it. The
                           kit already ships the real knob for this: cl-kit-ext.css's
                           `.clb--icon.clb--icon-xs .cap{width:24px;height:24px}`. */
                        className="clb--icon-xs shrink-0"
                        tooltip="Back"
                    >
                        <ChevronLeft className="w-3.5 h-3.5 text-cl-faint" />
                    </ClButton>
                    <div className="w-5 h-5 rounded-md bg-cl-lume/15 flex items-center justify-center shrink-0">
                        <Sliders className="w-3 h-3 text-cl-lume" />
                    </div>
                    <span className="text-[13px] text-cl-text font-semibold">Adjust Quality</span>
                </div>

                <div className="px-3.5 py-2.5 flex flex-col gap-2.5">
                    {/* Preset pills — 3 equal-width grid columns, not flex-1
                        (flex-1 only equalises width when every child stretches
                        the same amount, which broke down once Chip stopped
                        overriding its own width; a grid guarantees it). */}
                    <div>
                        <p className="text-[10px] text-cl-faint font-medium uppercase tracking-wide mb-1 m-0">Preset</p>
                        <div className="grid grid-cols-3 gap-1.5">
                            {(Object.entries(QUALITY_PRESETS) as [keyof typeof QUALITY_PRESETS, typeof QUALITY_PRESETS[keyof typeof QUALITY_PRESETS]][]).map(([key, preset]) => (
                                <Chip
                                    key={key}
                                    active={activePreset === key}
                                    onClick={() => { setQResolution(preset.resolution); setQFps(preset.frameRate); }}
                                >
                                    {preset.label}
                                </Chip>
                            ))}
                        </div>
                    </div>

                    {/* Resolution chips — 3 columns with `has1440p` (5
                        options: 3 + 2), 2 columns without it (4 options: a
                        clean 2x2) — every row that DOES exist is a full,
                        equal-width row; only the 5-option case ever leaves a
                        short last row, by exactly one cell. A single row of
                        N equal columns (N = option count) was tried first
                        and rejected: at this panel width the "Source"/
                        "1440p" columns weren't wide enough for the kit's
                        `chip` pill padding/font without ellipsis-truncating
                        the label (verified by measuring rendered chip
                        scrollWidth vs clientWidth against the real
                        stylesheet — see the before/after harness in the PR
                        description). */}
                    <div>
                        <p className="text-[10px] text-cl-faint font-medium uppercase tracking-wide mb-1 m-0">Resolution</p>
                        <div className={`grid gap-1.5 ${resolutionOptions.length > 4 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                            {resolutionOptions.map(r => (
                                <Chip key={r.value} active={qResolution === r.value} onClick={() => setQResolution(r.value)}>
                                    {r.label}
                                </Chip>
                            ))}
                        </div>
                    </div>

                    {/* FPS chips — fixed 4-column grid so all 4 options render
                        in a single row inside the panel (the bug report's
                        clipped 4th option was `flex` with no wrap allowance,
                        overflowing the panel's right edge instead of wrapping). */}
                    <div>
                        <p className="text-[10px] text-cl-faint font-medium uppercase tracking-wide mb-1 m-0">Frame Rate</p>
                        <div className="grid grid-cols-4 gap-1.5">
                            {QUALITY_FPS.map(fps => (
                                <Chip key={fps} active={qFps === fps} onClick={() => setQFps(fps)}>
                                    {fps} fps{fps === 90 ? '*' : ''}
                                </Chip>
                            ))}
                        </div>
                        {/* The `*` denotes "up to" — actual frame rate is
                            source/display/network-dependent, not guaranteed. */}
                        {qFps === 90 && (
                            <p className="text-[10px] text-amber-400/90 mt-1 m-0 leading-snug">
                                * Up to 90 fps — actual frame rate depends on your hardware and network speed.
                            </p>
                        )}
                    </div>

                    {/* Apply — kept as an explicit step rather than applying each
                        chip immediately: onAdjustScreenShareQuality tears down
                        and republishes the screen-share track (see CallPane's
                        and SidebarConference's "isAdjusting" grace-window
                        comments), so batching preset+resolution+fps into ONE
                        republish instead of up to three is load-bearing, not
                        just a UI nicety — especially with screenshare republish
                        performance under separate active investigation. */}
                    <ClButton
                        variant="ok"
                        size="sm"
                        fullWidth
                        onClick={handleApplyQuality}
                        /* clb--flat drops the kit's depth sheets (they read as a dark
                           slab under a fullWidth cap); cl-ss-apply carries the glow on
                           .cap, since className lands on the square .clb wrapper and a
                           shadow there is a square halo. See index.css. */
                        className="clb--flat cl-ss-apply"
                    >
                        <Check className="w-3.5 h-3.5" />
                        Apply
                    </ClButton>
                </div>
            </div>
        </div>,
        document.body
    );

    const micOn    = !!localParticipant?.isMicrophoneEnabled;
    const camOn    = !!localParticipant?.isCameraEnabled;

    return (
        <div className="shrink-0 w-full bg-transparent px-1 pt-1.5 pb-2 select-none">
            {menuPortal}
            {micMenu.menu}
            {deafenMenu.menu}
            {cameraMenu.menu}

            {/* One capsule, one row, never wraps — see .cl-console. Order runs
                most-used first: mic, deafen, then the video controls. */}
            <div className="cl-console">
            <div className="cl-console-inner" data-live-share={isScreensharing || undefined}>

                <CtrlBtn
                    pulse={micOn ? undefined : 'off'}
                    disabled={micDisabled}
                    tone={micOn ? 'neutral' : 'off'}
                    onClick={(e) => {
                        bumpMicDizzy(e.currentTarget as HTMLElement);
                        onToggleMic();
                    }}
                    onContextMenu={openMicMenu}
                    title={
                        isServerDeafened    ? "You've been server deafened — unmute is blocked"
                        : serverMutedAudio  ? "Your microphone has been muted by a moderator"
                        : micDisabled       ? "You don't have permission to speak in this channel"
                        : micOn ? 'Mute' : 'Unmute'
                    }
                >
                    <span className="cl-ico cl-ico--tog" data-off={!micOn}>
                        <Mic className={`${iconSize} ico-on`} />
                        <MicOff className={`${iconSize} ico-off`} />
                    </span>
                </CtrlBtn>

                <CtrlBtn
                    bumpSpam={bumpSpam}
                    spamKey="deafen"
                    pulse={isLocalDeafened ? 'off' : undefined}
                    disabled={deafenDisabled}
                    tone={isLocalDeafened ? 'off' : 'neutral'}
                    onClick={() => {
                        if (!deafenDisabled) {
                            onToggleDeafen();
                        }
                    }}
                    onContextMenu={openDeafenMenu}
                    title={deafenDisabled ? "You've been server deafened — you can't override this" : isLocalDeafened ? 'Undeafen' : 'Deafen'}
                >
                    <span className="cl-ico cl-ico--tog" data-off={isLocalDeafened}>
                        <Headphones className={`${iconSize} ico-on`} />
                        <HeadphoneOff className={`${iconSize} ico-off`} />
                    </span>
                </CtrlBtn>

                {/* Audio ends here; video begins. The divider is what makes the
                    row read as groups rather than six interchangeable circles. */}
                <span className="cl-console-sep" aria-hidden="true" />

                {/* Camera */}
                <CtrlBtn
                    bumpSpam={bumpSpam}
                    pulse={camOn ? 'live' : undefined}
                    disabled={cameraDisabled}
                    tone={camOn ? 'live' : 'neutral'}
                    onClick={() => {
                        if (videoLocked) { promptUpgrade('video'); return; }
                        onToggleCamera();
                    }}
                    onContextMenu={openCameraMenu}
                    title={
                        videoLocked ? 'Video calling is a Pro feature — upgrade for $2.50/mo + tax'
                        : serverMutedVideo ? "Your camera has been disabled by a moderator"
                        : cameraDisabled ? "You don't have permission to enable video in this channel"
                        : camOn ? 'Turn camera off' : 'Turn camera on'
                    }
                >
                    <span className="cl-ico cl-ico--tog" data-off={!camOn}>
                        <Video className={`${iconSize} ico-on`} />
                        <VideoOff className={`${iconSize} ico-off`} />
                    </span>
                </CtrlBtn>

                {/* Screenshare — idle: plain | active: split stop + chevron */}
                {isScreensharing ? (
                    /* Live share: a rounded segment pair — stop face + options
                       chevron — that reads as one control inside the capsule. */
                    <div className="cl-share-live" style={{ flex: '0 0 auto' }}>
                        {/* Stop button */}
                        <button
                            type="button"
                            title="Stop Screen Share"
                            onClick={onToggleScreenshare}
                            onMouseEnter={() => setSsHovered(true)}
                            onMouseLeave={() => setSsHovered(false)}
                            className={`cl-ctrlbtn cl-share-stop overflow-hidden
                                ${!ssHovered && ssTransReady ? 'ss-stop-btn-pulse' : ''}
                                ${justStartedSharing ? 'ss-start-flash' : ''}`}
                            style={{
                                background: ssHovered ? 'color-mix(in srgb, var(--cl-flash) 90%, transparent)' : 'var(--cl-lume)',
                                color: ssHovered ? 'var(--cl-text)' : 'var(--cl-on-lume)',
                                transition: ssTransReady ? 'background 220ms cubic-bezier(0.4,0,0.2,1)' : 'none',
                            } as React.CSSProperties}
                        >
                            <ScreenShare className="absolute" style={{
                                width: 'clamp(16px, 42%, 22px)', height: 'auto',
                                opacity: ssHovered ? 0 : 1,
                                transform: ssHovered ? 'scale(0.6) rotate(-15deg)' : 'scale(1) rotate(0deg)',
                                transition: ssIconTransition,
                            }} />
                            <X className="absolute" style={{
                                width: 'clamp(16px, 42%, 22px)', height: 'auto',
                                opacity: ssHovered ? 1 : 0,
                                transform: ssHovered ? 'scale(1) rotate(0deg)' : 'scale(0.5) rotate(15deg)',
                                transition: ssIconTransition,
                            }} />
                        </button>

                        {/* Chevron — slim attached flag, fixed width so only the
                            stop face flexes */}
                        <div ref={chevronRef} style={{ display: 'inline-flex' }}>
                            <button
                                type="button"
                                title="Screen share options"
                                onClick={openMenu}
                                className="cl-ctrlbtn cl-share-chev"
                                style={{
                                    background: ssMenuOpen ? 'var(--cl-lume)' : 'rgba(37,224,200,0.55)',
                                    color: 'var(--cl-on-lume)',
                                } as React.CSSProperties}
                            >
                                <ChevronDown
                                    className="w-3.5 h-3.5"
                                    style={{
                                        transition: 'transform 220ms cubic-bezier(0.4,0,0.2,1)',
                                        transform: ssMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                    }}
                                />
                            </button>
                        </div>
                    </div>
                ) : (
                    <CtrlBtn
                        bumpSpam={bumpSpam}
                        disabled={shareDisabled}
                        tone="neutral"
                        onClick={() => {
                            if (videoLocked) { promptUpgrade('screenshare'); return; }
                            onToggleScreenshare();
                        }}
                        title={
                            videoLocked ? 'Screen sharing is a Pro feature — upgrade for $2.50/mo + tax'
                            : serverMutedScreenShare ? "Screen sharing has been disabled by a moderator"
                            : shareDisabled        ? "You don't have permission to screen share in this channel"
                            : 'Share Screen'
                        }
                    >
                        <span className="cl-ico"><ScreenShare className={iconSize} /></span>
                    </CtrlBtn>
                )}

                {/* Fullscreen */}
                {/* Always mounted (disabled without video) — conditionally
                    unmounting it makes the sibling flex buttons resize, which
                    reads as the whole bar jumping around while tracks drop
                    during call teardown. */}
                {callCtx && (
                    <CtrlBtn
                        bumpSpam={bumpSpam}
                        disabled={!showFullscreenButton}
                        tone={callCtx.isFullscreen ? 'live' : 'neutral'}
                        onClick={() => {
                            if (!showFullscreenButton) return;
                            callCtx.setIsFullscreen(!callCtx.isFullscreen);
                        }}
                        title={
                            !showFullscreenButton ? 'Fullscreen — available when video or a screen share is up'
                            : callCtx.isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'
                        }
                    >
                        <span className="cl-ico">{callCtx.isFullscreen ? <Minimize2 className={iconSize} /> : <Maximize2 className={iconSize} />}</span>
                    </CtrlBtn>
                )}

                {/* Leaving is a different kind of act, so it sits furthest out. */}
                <span className="cl-console-sep cl-console-sep--leave" aria-hidden="true" />

                {/* Leave — grows a label when the console has room. Deliberately
                    has no spamKey: mashing hang-up isn't a joke worth making. */}
                <CtrlBtn
                    bumpSpam={bumpSpam}
                    tone="danger"
                    className="cl-ctrlbtn--wide"
                    onClick={onLeave}
                    title="Leave Call"
                >
                    <span className="cl-ico"><PhoneCall className="w-4 h-4 rotate-[135deg]" /></span>
                    <span className="cl-ctrl-label">Leave</span>
                </CtrlBtn>
            </div>
            </div>
        </div>
    );
};
