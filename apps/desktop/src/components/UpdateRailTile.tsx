import React from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { useUpdate } from '../contexts/UpdateContext';
import { ClConfirm } from './cl';

/** 44×44 — matches Dashboard.tsx's RailTile geometry exactly so this sits in
 *  the deck as if it were one, without pulling in RailTile itself (which
 *  bakes in the sliding "active tab" pill this tile has no use for — it's a
 *  status indicator, not a navigation target). */
const SIZE = 44;
const RING_R = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

/**
 * Update rail tile — mounted directly above the Friends tile in Dashboard's
 * bottom rail (the spot the user pointed at). Renders NOTHING while
 * state.phase === 'idle', so the rail is visually unchanged until there is
 * something worth telling the user.
 *
 *   downloading — muted download glyph ringed by a live progress sweep.
 *                 Not clickable; nothing to do yet.
 *   ready       — green, gently pulsing. Click restarts into the new build.
 *   manual      — green, same glyph as ready but with a small arrow badge
 *                 hinting "opens your browser" instead of "restarts the app".
 *                 See the module doc on why this NEVER shows the in-call
 *                 confirm: it only opens a download page, the running app
 *                 (and any call in it) is untouched.
 *
 * `inCall` is passed in from Dashboard, which is the only place that
 * actually knows whether activeCall / activeVoiceChannelId /
 * activeHuddleChannelId is set — this component has no opinion on what
 * counts as "in a call", it just asks before firing the one action that
 * would end one.
 */
export default function UpdateRailTile({ inCall }: { inCall: boolean }) {
    const { state, installNow, openDownload } = useUpdate();
    const [confirmOpen, setConfirmOpen] = React.useState(false);

    if (state.phase === 'idle') return null;

    const handleClick = () => {
        if (state.phase === 'ready') {
            if (inCall) { setConfirmOpen(true); return; }
            installNow();
        } else if (state.phase === 'manual') {
            // Opens a browser tab — never touches the running app or an
            // in-progress call, so no confirmation needed regardless of inCall.
            openDownload();
        }
        // 'downloading' has no click handler at all (see below) — unreachable here.
    };

    const clickable = state.phase === 'ready' || state.phase === 'manual';
    const label =
        state.phase === 'downloading' ? `Downloading update… ${Math.round(state.percent)}%`
        : state.phase === 'ready'     ? 'Update ready — click to restart and install'
        : `Update available — click to download v${state.version}`;

    const iconColor = clickable ? 'var(--cl-lume)' : 'var(--cl-muted)';

    return (
        <>
            <button
                type="button"
                onClick={clickable ? handleClick : undefined}
                title={label}
                aria-label={label}
                // 'downloading' is genuinely inert — nothing to retry or
                // cancel — so it's a real disabled button: not focusable,
                // not clickable, correctly announced by screen readers.
                disabled={!clickable}
                className={state.phase === 'ready' ? 'update-ready-pulse' : undefined}
                style={{
                    position: 'relative', width: SIZE, height: SIZE, border: 'none',
                    background: 'none', cursor: clickable ? 'pointer' : 'default',
                    borderRadius: 12, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', padding: 0, color: iconColor, flex: 'none',
                    transition: 'color .2s, background .2s',
                }}
                onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = 'rgba(255,255,255,.06)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
                {state.phase === 'downloading' && (
                    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
                        <circle cx={SIZE / 2} cy={SIZE / 2} r={RING_R} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={2} />
                        <circle
                            cx={SIZE / 2} cy={SIZE / 2} r={RING_R} fill="none"
                            stroke="var(--cl-muted)" strokeWidth={2} strokeLinecap="round"
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={RING_CIRCUMFERENCE * (1 - state.percent / 100)}
                            style={{ transition: 'stroke-dashoffset .3s ease' }}
                        />
                    </svg>
                )}
                <Download size={19} />
                {state.phase === 'manual' && (
                    // Small corner glyph distinguishing "opens a download page
                    // in your browser" from ready's "restarts the app" — same
                    // green, different promise, shouldn't look identical.
                    <ExternalLink
                        size={10}
                        strokeWidth={3}
                        style={{
                            position: 'absolute', bottom: 3, right: 3,
                            background: 'var(--cl-abyss)', borderRadius: '50%', padding: 1,
                        }}
                    />
                )}
            </button>

            <ClConfirm
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => { setConfirmOpen(false); installNow(); }}
                title="Leave your call to update?"
                message="Installing this update restarts Cipherline, which will end your current call. You can install it later from this same icon."
                confirmLabel="Leave & install"
                cancelLabel="Cancel"
                danger
                // ClModal's default overlay z-index (1000) sits BELOW a
                // fullscreen call (SidebarConference's z-[99999]) — without
                // this override, confirming "leave the call" while actually
                // in fullscreen would be invisible behind the call itself.
                // Matches UpgradeRequiredOverlay's precedent for "must be
                // seen above an active call".
                overlayStyle={{ zIndex: 100000 }}
            />
        </>
    );
}
