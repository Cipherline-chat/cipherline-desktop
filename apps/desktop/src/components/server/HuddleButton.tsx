/**
 * HuddleButton — the clickable "spawn-a-call-here" template that lives in
 * the right-side ServerContextPanel. One per Huddle channel (Channel.kind
 * === 'huddle').
 *
 * Behaviour:
 *  - Click body → POST /huddles/:hid/calls (spawn a fresh call).
 *  - Active calls are rendered as children (passed by the parent).
 *  - Teal/lume "merged card" styling only appears when the local user is IN
 *    a call under this Huddle (`isActiveForMe`) — the button row and its
 *    expanded call/participant list become one continuous bordered card.
 *    Other users with active calls (not yours) see a neutral gray tint,
 *    two independently-bordered boxes stacked, same as before. The + spawn
 *    button is hidden while you're already in a call here.
 */

import React, { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Volume2, ChevronDown, ChevronRight, Plus, Lock, Loader2, ShieldAlert } from 'lucide-react';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { FlatIconBtn } from '../primitives/HoverActions';

interface Props {
    name: string;
    iconName?: string | null;
    iconEmoji?: string | null;
    /** Aggregate participant count across all calls under this Huddle. */
    activeParticipantCount: number;
    /** Number of active calls (not participants). */
    activeCallCount: number;
    /** Max concurrent calls allowed under this Huddle — shows "X/Y" when set. */
    maxCalls?: number | null;
    canConnect: boolean;
    /**
     * True when `activeCallCount >= maxCalls` (server's per-Huddle call cap
     * from HuddlesService.spawnCall — "This Calls channel has reached its
     * call limit of N"). The caller already has both numbers from the same
     * live `huddleCalls` state that drives `activeCallCount`, so this needs
     * no extra fetch/poll. When true, the "+" spawn affordance is hidden and
     * the row is not clickable to spawn — previously a click here always hit
     * the server and came back as a plain "Call connection failed" toast
     * that read like a network error, not a full channel.
     */
    atCallLimit?: boolean;
    /** Seconds remaining on a rate-limit cooldown — shown in the subtitle. */
    cooldownSecs?: number;
    /** True when the local user is currently in a call under this Huddle. */
    isActiveForMe: boolean;
    /**
     * Real encryption state of the call under this Huddle — NEVER hardcoded.
     * This is only ever knowable from a room this device actually holds a
     * key for, so it's meaningful precisely when `isActiveForMe`:
     *   - 'connecting' — joining; no confirmed room key yet (mirrors
     *     callsChannelGate's 'blocked' loading/stalled states).
     *   - 'connected'  — this device holds a real key for the room
     *     (callsChannelGate reached 'connect').
     *   - undefined/null — unknown (not my call, or no call), in which case
     *     NOTHING is rendered rather than a padlock that might be a lie —
     *     this device has no way to know another participant's key state.
     */
    encryptionState?: 'connecting' | 'connected' | 'mixed' | null;
    expanded: boolean;
    onToggleExpanded: () => void;
    onSpawn: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    children?: React.ReactNode;
}

interface RippleState { id: number; x: number; y: number; }

export const HuddleButton: React.FC<Props> = ({
    name, iconName, iconEmoji,
    activeParticipantCount, activeCallCount, maxCalls,
    canConnect, atCallLimit = false, cooldownSecs, isActiveForMe, encryptionState, expanded, onToggleExpanded, onSpawn, onContextMenu, children,
}) => {
    const buttonRef = useRef<HTMLDivElement>(null);
    const [ripples, setRipples] = useState<RippleState[]>([]);
    const rippleId = useRef(0);
    const [pressed, setPressed] = useState(false);

    // Spawning a NEW call is what the row body / "+" affordance do — that's
    // the one action the per-Huddle call cap actually blocks. `canConnect`
    // alone stays the permission/cooldown signal (still drives the Lock icon
    // and the "no permission" copy below); `canSpawn` is the narrower gate
    // that also accounts for the channel being full.
    const canSpawn = canConnect && !atCallLimit;

    const handleMouseDown = (e: React.MouseEvent) => {
        if (!canSpawn) return;
        const el = buttonRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const id = ++rippleId.current;
        setRipples(prev => [...prev, { id, x, y }]);
        setPressed(true);
        setTimeout(() => { setRipples(prev => prev.filter(r => r.id !== id)); }, 500);
        setTimeout(() => setPressed(false), 120);
    };

    const handleClick = (e: React.MouseEvent) => {
        if (!canSpawn) return;
        e.stopPropagation();
        onSpawn();
    };

    const Chevron = expanded ? ChevronDown : ChevronRight;
    const isLive = activeCallCount > 0;
    // Only show the chevron when there are active calls to expand/collapse.
    const showChevron = isLive;

    // When the local user is IN a call here, the whole button + its expanded
    // call/participant list merge into a single continuous teal-bordered card
    // (matching the encrypted-call callout look) instead of two independently
    // bordered boxes stacked on top of each other. A call that's merely live
    // (someone else's, not yours) keeps the neutral "elevated" gray treatment.
    const mergedTeal = isActiveForMe;

    // Card colour: elevated when any call is live (including yours);
    // idle shows a flatter card at rest. Skipped entirely when mergedTeal —
    // the outer wrapper owns the border/background in that case.
    const cardBg = isLive
        ? 'bg-cl-surface border border-white/[0.15] hover:bg-[#263040] hover:border-white/[0.20]'
        : 'bg-cl-deep border border-white/[0.12] hover:bg-cl-surface hover:border-white/[0.18]';

    // Icon stays teal for idle AND "it's my call"; only a live-but-not-mine
    // call (someone else's, seen from outside) gets the neutral gray tint.
    const iconBg = isLive && !mergedTeal
        ? 'bg-white/[0.12] text-cl-muted'
        : 'bg-cl-lume/15 text-cl-lume';

    const nameColor = 'text-white/85';

    const rowStateCls = mergedTeal
        ? (canSpawn ? 'hover:bg-cl-lume/[0.06]' : 'opacity-50 cursor-not-allowed')
        : (canSpawn ? `hover:bg-white/[0.05] ${cardBg}` : `opacity-50 cursor-not-allowed ${cardBg}`);

    return (
        <div
            className={mergedTeal ? 'rounded-xl border border-cl-lume/35 bg-cl-lume/[0.05] overflow-hidden' : undefined}
            style={mergedTeal ? { boxShadow: 'var(--cl-glow-lume)' } : undefined}
        >
            <div
                ref={buttonRef}
                onMouseDown={handleMouseDown}
                onClick={handleClick}
                onContextMenu={onContextMenu}
                className={[
                    'relative flex items-center gap-2 px-2.5 py-2 cursor-pointer select-none transition-all',
                    pressed ? 'scale-[0.97]' : '',
                    rowStateCls,
                ].join(' ')}
                style={{ borderRadius: mergedTeal ? 0 : 12 }}
                title={
                    !canConnect
                        ? (cooldownSecs ? `Slow down — wait ${cooldownSecs}s` : "You don't have permission to connect")
                        : atCallLimit
                            ? `This Calls channel has reached its call limit${maxCalls != null ? ` (${activeCallCount}/${maxCalls})` : ''}`
                            : `Click to start a new call in ${name}`
                }
            >
                {/* Ripples */}
                <span aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden rounded-[12px]">
                    {ripples.map(r => (
                        <span
                            key={r.id}
                            style={{
                                position: 'absolute',
                                left: r.x - 6,
                                top: r.y - 6,
                                width: 12,
                                height: 12,
                                borderRadius: '50%',
                                background: 'rgba(99,102,241,0.55)',
                                transform: 'scale(0)',
                                opacity: 0.45,
                                pointerEvents: 'none',
                                animation: 'huddle-ripple 460ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards',
                            }}
                        />
                    ))}
                </span>

                {/* Expand chevron — only rendered when there are active calls */}
                {showChevron && (
                    <FlatIconBtn
                        title={expanded ? 'Collapse' : 'Expand'}
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                        onClick={(e) => { e.stopPropagation(); onToggleExpanded(); }}
                        tabIndex={-1}
                    >
                        <Chevron />
                    </FlatIconBtn>
                )}

                {/* Icon */}
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
                    {iconName
                        ? <ChannelIconRenderer name={iconName} size={14} />
                        : iconEmoji
                            ? <span className="text-[14px] leading-none">{iconEmoji}</span>
                            : <Volume2 size={14} />}
                </div>

                {/* Name + status */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className={`text-[12px] font-medium truncate ${nameColor}`}>
                            {name}
                        </span>
                        {!canConnect && <Lock size={10} className="text-cl-faint shrink-0" />}
                    </div>
                    <div className="text-[10px] truncate">
                        {cooldownSecs && cooldownSecs > 0
                            ? <span className="text-amber-400/80">Hold on — {cooldownSecs}s</span>
                            : isLive
                                ? (
                                    <span className="text-cl-faint inline-flex items-center gap-1 min-w-0">
                                        <span className="truncate">
                                            {maxCalls != null ? `${activeCallCount}/${maxCalls}` : activeCallCount} call{activeCallCount === 1 && maxCalls == null ? '' : 's'} · {activeParticipantCount} in voice
                                        </span>
                                        {/* Padlock only ever reflects a room key THIS device
                                            actually holds — see the Props comment on
                                            encryptionState. A live call that isn't mine renders
                                            neither icon: absent is honest, a guessed one isn't. */}
                                        {encryptionState === 'connecting' && (
                                            <span
                                                className="shrink-0 inline-flex"
                                                role="img"
                                                aria-label="Connecting…"
                                                title="Connecting…"
                                            >
                                                <Loader2 size={9} className="animate-spin text-cl-faint" />
                                            </span>
                                        )}
                                        {encryptionState === 'connected' && (
                                            <span
                                                className="shrink-0 inline-flex"
                                                role="img"
                                                aria-label="End-to-end encrypted"
                                                title="End-to-end encrypted"
                                            >
                                                <Lock size={9} className="text-cl-faint" />
                                            </span>
                                        )}
                                        {/* Someone in the call is on a build older than
                                            1.0.13 and cannot encrypt call media, so part
                                            of this call is in the clear. A padlock — of
                                            any colour — would still read as "encrypted"
                                            at this size, so this is deliberately a
                                            different glyph, not a tinted lock. */}
                                        {encryptionState === 'mixed' && (
                                            <span
                                                className="shrink-0 inline-flex"
                                                role="img"
                                                aria-label="Not fully encrypted — someone is on an older version"
                                                title="Not fully encrypted — someone in this call is on an older version of Cipherline and their audio and video are not end-to-end encrypted."
                                            >
                                                <ShieldAlert size={9} className="text-cl-danger" />
                                            </span>
                                        )}
                                    </span>
                                )
                                : <span className="text-cl-faint">Click to start a call</span>
                        }
                    </div>
                </div>

                {/* + spawn button — hidden while you're already in a call here */}
                {canSpawn && !isActiveForMe && (
                    <div className="w-6 h-6 rounded-md flex items-center justify-center bg-cl-lume/15 text-cl-lume shrink-0 transition-transform hover:scale-110">
                        <Plus size={13} />
                    </div>
                )}
            </div>

            {/* Children = HuddleCallCards — animate in/out when toggled */}
            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        key="huddle-expanded"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        /* restDelta/restSpeed are the whole reason this reads smooth on join.
                         * `height` is a LAYOUT property: every frame of this spring forces a
                         * full layout + style recalc of the channel list and everything below
                         * it — and those frames land exactly while LiveKitRoom is negotiating
                         * ICE/DTLS, constructing the E2EE worker and opening the mic, so the
                         * main thread is already saturated. Framer's default restDelta is
                         * 0.01px, so this underdamped spring (zeta 0.74) kept re-laying-out the
                         * sidebar for ~28 frames after it was visually finished, settling from
                         * a half-pixel to a hundredth of a pixel that nobody can see.
                         * Resting at half a pixel cuts the animation from 56 layout-forcing
                         * frames to 30 (measured: 46.6ms -> 29.8ms of layout+recalc+script)
                         * while leaving stiffness/damping/mass untouched — same curve, same
                         * overshoot, same feel, just no invisible tail. Do NOT "fix" this by
                         * raising damping toward critical: that makes it strictly worse
                         * (damping 40 = 32 frames, 50 = 42 frames). */
                        transition={{
                            type: 'spring', stiffness: 480, damping: 30, mass: 0.85,
                            restDelta: 0.5, restSpeed: 2,
                            opacity: { duration: 0.12 },
                        }}
                        style={{ overflow: 'hidden' }}
                    >
                        <div className={mergedTeal ? 'pb-1' : 'mt-1 ml-4 pb-2 space-y-1'}>
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <style>{`
                @keyframes huddle-ripple {
                    0%   { transform: scale(0);   opacity: 0.45; }
                    100% { transform: scale(2.6); opacity: 0;    }
                }
            `}</style>
        </div>
    );
};

export default HuddleButton;
