import React from 'react';
import { AlertTriangle, Download, ExternalLink, RotateCw } from 'lucide-react';
import { useUpdate } from '../contexts/UpdateContext';
import { ClConfirm } from './cl';
import { describeUpdateTile } from '../utils/updateTile';

/** 44×44 — matches Dashboard.tsx's RailTile geometry exactly so this sits in
 *  the deck as if it were one, without pulling in RailTile itself (which
 *  bakes in the sliding "active tab" pill this tile has no use for — it's a
 *  status indicator, not a navigation target). */
const SIZE = 44;
const RING_R = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

const TONE_COLOR = {
    busy: 'var(--cl-muted)',
    ready: 'var(--cl-lume)',
    warn: 'var(--cl-glow)',
    error: 'var(--cl-danger)',
    external: 'var(--cl-lume)',
} as const;

/**
 * Update rail tile — mounted directly above the Friends tile in Dashboard's
 * bottom rail (the spot the user pointed at). Renders NOTHING while
 * state.phase === 'idle', so the rail is visually unchanged until there is
 * something worth telling the user. Wording and the action per phase live in
 * src/utils/updateTile.ts (tested); this file only draws them.
 *
 *   available /
 *   downloading — muted download glyph ringed by a live progress sweep.
 *                 Not clickable; nothing to do yet.
 *   retrying    — an attempt failed and another is scheduled (main retries
 *                 on its own, with backoff). Amber retry glyph; click retries
 *                 NOW. Still entirely in-app.
 *   failed      — retries exhausted, the update couldn't be verified, or the
 *                 installer couldn't start. Red alert glyph; click = Retry
 *                 (a fresh in-app download). Never a browser link.
 *   ready       — green, gently pulsing. Click restarts into the new build.
 *   manual      — LINUX ONLY (main never produces it elsewhere): green glyph
 *                 with a small arrow badge — "opens your browser" — for an
 *                 AppImage that cannot replace itself.
 *
 * Only `ready` can end a call, so only `ready` asks first when `inCall`.
 * `inCall` is passed in from Dashboard, which is the only place that
 * actually knows whether activeCall / activeVoiceChannelId /
 * activeHuddleChannelId is set.
 */
export default function UpdateRailTile({ inCall }: { inCall: boolean }) {
    const { state, installNow, retry, openDownload } = useUpdate();
    const [confirmOpen, setConfirmOpen] = React.useState(false);

    // The retry countdown in the tooltip is derived from `retryAt`; tick once a
    // second while it is showing so it doesn't freeze at its first value.
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (state.phase !== 'retrying') return;
        const tick = () => setNow(Date.now());
        const first = window.setTimeout(tick, 0); // refresh at once, not a second late
        const id = window.setInterval(tick, 1000);
        return () => { window.clearTimeout(first); window.clearInterval(id); };
    }, [state.phase]);

    const tile = describeUpdateTile(state, now);
    if (!tile.visible) return null;

    const handleClick = () => {
        if (tile.action === 'install') {
            if (inCall) { setConfirmOpen(true); return; }
            installNow();
        } else if (tile.action === 'retry') {
            // Restarts nothing — a download in the background — so no confirm.
            retry();
        } else if (tile.action === 'open-download') {
            // Linux only. Opens a browser tab; never touches the running app.
            openDownload();
        }
    };

    const clickable = tile.action !== null;
    const iconColor = TONE_COLOR[tile.tone];
    const Icon = tile.tone === 'warn' ? RotateCw : tile.tone === 'error' ? AlertTriangle : Download;

    return (
        <>
            <button
                type="button"
                onClick={clickable ? handleClick : undefined}
                title={tile.label}
                aria-label={tile.label}
                // 'available'/'downloading' are genuinely inert — nothing to
                // retry or cancel — so it's a real disabled button: not
                // focusable, not clickable, correctly announced by screen readers.
                disabled={!clickable}
                className={tile.tone === 'ready' ? 'update-ready-pulse' : undefined}
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
                {tile.percent !== null && (
                    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
                        <circle cx={SIZE / 2} cy={SIZE / 2} r={RING_R} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={2} />
                        <circle
                            cx={SIZE / 2} cy={SIZE / 2} r={RING_R} fill="none"
                            stroke="var(--cl-muted)" strokeWidth={2} strokeLinecap="round"
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={RING_CIRCUMFERENCE * (1 - tile.percent / 100)}
                            style={{ transition: 'stroke-dashoffset .3s ease' }}
                        />
                    </svg>
                )}
                <Icon size={19} />
                {tile.tone === 'external' && (
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
