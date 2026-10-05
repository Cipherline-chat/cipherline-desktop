/**
 * HuddleCallCard — one row per *active call* under a Huddle button. Lives
 * inside HuddleButton's children slot.
 *
 * Shows: call name, participant avatar stack (max 4 visible + +N overflow),
 * live participant count, and a Join button (non-active calls only). When
 * the card is yours (isMine), the avatar stack is replaced by a live call-
 * duration timer; leave is handled via the bottom ControlBar — no Leave
 * button on the card itself.
 *
 * Mount animation: a framer-motion opacity fade (`initial={{opacity:0}}` →
 * `animate={{opacity:1}}` on the outer `motion.div`, see below) so newly
 * spawned calls fade in rather than popping into the stack instantly.
 */

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { MoreVertical } from 'lucide-react';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { FlatIconBtn } from '../primitives/HoverActions';

interface ParticipantLite {
    user_id: string;
    nickname?: string | null;
    username?: string;
    avatar_url?: string | null;
}

interface Props {
    callId: string;
    name: string;
    participants: ParticipantLite[];
    isMine: boolean;
    /** Whether "Rename" is offered (spawner or manager, per the channel's
     *  "Call names" setting). */
    canRename: boolean;
    /** True when the local user is the spawner — drives "you started this".
     *  Falls back to `canRename` for callers that predate it. */
    startedByMe?: boolean;
    canConnect: boolean;
    token: string | null;
    /** ISO timestamp the call was spawned — used to render the duration timer. */
    spawnedAt?: string;
    /** Max participants for this Huddle — shows "X/Y" when set. */
    memberLimit?: number | null;
    onJoin: () => void;
    onLeave: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onMoreClick?: (e: React.MouseEvent) => void;
}

const MAX_AVATARS = 4;

/** Format elapsed seconds as M:SS or H:MM:SS */
const formatDuration = (startIso: string): string => {
    const totalSecs = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

export const HuddleCallCard: React.FC<Props> = ({
    callId, name, participants, isMine, canRename, startedByMe, canConnect,
    token, spawnedAt, memberLimit, onJoin, onContextMenu, onMoreClick,
}) => {
    const visible = participants.slice(0, MAX_AVATARS);
    const overflow = Math.max(0, participants.length - MAX_AVATARS);

    // Live timer — ticks every second for all calls (not just the local user's).
    const [elapsed, setElapsed] = useState(() => (spawnedAt ? formatDuration(spawnedAt) : ''));
    useEffect(() => {
        if (!spawnedAt) return;
        setElapsed(formatDuration(spawnedAt));
        const id = setInterval(() => setElapsed(formatDuration(spawnedAt)), 1000);
        return () => clearInterval(id);
    }, [spawnedAt]);

    return (
        <motion.div
            onClick={!isMine && canConnect ? (e) => { e.stopPropagation(); onJoin(); } : undefined}
            onContextMenu={onContextMenu}
            className={[
                'group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-colors',
                isMine
                    // Borderless — nested inside HuddleButton's merged teal card
                    // (see mergedTeal in HuddleButton.tsx), so this row doesn't
                    // draw its own competing box around "your" call summary.
                    ? 'cursor-default bg-transparent'
                    : canConnect
                        ? 'cursor-pointer bg-cl-deep border border-white/[0.11] hover:bg-cl-surface hover:border-white/[0.16] active:scale-[0.98]'
                        : 'cursor-not-allowed opacity-50 bg-cl-deep border border-white/[0.11]',
            ].join(' ')}
            data-call-id={callId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
        >
            {/* Live indicator dot — only for calls I'm not in.
                The isMine card is already green so no separate dot is needed. */}
            {!isMine && <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500/60" />}

            {/* Call name + meta */}
            <div className="flex-1 min-w-0">
                <div className={`text-[12px] font-semibold truncate ${isMine ? 'text-cl-lume' : 'text-white/80'}`}>
                    {name}
                </div>
                <div className="text-[10px] text-cl-faint truncate">
                    {memberLimit != null
                        ? `${participants.length}/${memberLimit} in call`
                        : `${participants.length} in call`
                    }{(startedByMe ?? canRename) ? ' · you started this' : ''}
                </div>
            </div>

            {/* Right slot: duration timer for all calls */}
            {spawnedAt ? (
                <span className="text-[11px] font-mono font-semibold shrink-0 tabular-nums text-cl-faint">
                    {elapsed}
                </span>
            ) : visible.length > 0 ? (
                <div className="flex -space-x-1.5 shrink-0">
                    {visible.map(p => (
                        <div key={p.user_id} className="w-5 h-5 rounded-full overflow-hidden border-2 border-cl-deep">
                            <EncryptedAvatar
                                attachmentId={p.avatar_url ?? null}
                                userId={p.user_id}
                                token={token}
                                className="w-full h-full"
                                fallbackSize={9}
                                bypassFriendGate
                            />
                        </div>
                    ))}
                    {overflow > 0 && (
                        <div className="w-5 h-5 rounded-full bg-white/[0.12] border-2 border-cl-deep flex items-center justify-center text-[8px] font-bold text-cl-muted">
                            +{overflow}
                        </div>
                    )}
                </div>
            ) : null}

            {/* More-options dot */}
            {onMoreClick && (
                <FlatIconBtn
                    title="More"
                    aria-label="More"
                    onClick={(e) => { e.stopPropagation(); onMoreClick(e); }}
                >
                    <MoreVertical />
                </FlatIconBtn>
            )}
        </motion.div>
    );
};

export default HuddleCallCard;
