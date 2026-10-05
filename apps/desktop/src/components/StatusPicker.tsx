import React, { useState, useRef } from 'react';
import { X, Pencil } from 'lucide-react';
import ClButton from './ClButton';
import { ClSlider } from './ClSlider';
import { GameControllerIcon } from './GameControllerIcon';
import { StatusDot, StatusIcon } from './StatusIcon';
// Re-exported: most of the app imports the status dot from here.
export { StatusDot, StatusIcon } from './StatusIcon';
import { EncryptedAvatar } from './EncryptedAvatar';
import { type UserStatus, STATUS_CONFIG } from '../hooks/useUserStatus';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import { useClTooltip } from './cl/useClTooltip';

interface StatusPickerProps {
    myStatus: UserStatus;
    /** No text/emoji arg — the picker no longer edits custom status. Called
     *  with just the status; useUserStatus's setStatus preserves whatever
     *  custom text/emoji is already on the account unchanged. */
    onSetStatus: (status: UserStatus) => void;
    username: string;
    currentGame?: string | null;
    onDismissGame?: () => void;
    /** Current user's avatar attachment id (for the trigger avatar). */
    avatarAttachmentId?: string | null;
    /** Current user's user_id — drives the deterministic-color fallback avatar. */
    userId?: string | null;
    /** Auth token for avatar decryption. */
    token?: string | null;
    /** Opens the Settings modal on the profile tab. When provided, an
     *  "Edit Profile" row appears at the bottom of the status dropdown. */
    onEditProfile?: () => void;
}

const STATUS_OPTIONS: UserStatus[] = ['online', 'away', 'dnd', 'offline'];

// Shorter than STATUS_CONFIG's labels ("Away" → "Idle", "Do Not Disturb" →
// "DND") — those read better elsewhere (tooltips, profile cards) but are too
// long for this compact grid.
const STATUS_SHORT_LABEL: Record<UserStatus, string> = {
    online: 'Online',
    away: 'Idle',
    dnd: 'DND',
    offline: 'Offline',
};

/** 6-digit hex + appended alpha channel — every STATUS_CONFIG color is a
 *  plain `#rrggbb`, so this is safe without pulling in a color-parsing dep. */
const withAlpha = (hex: string, alphaHex: string) => `${hex}${alphaHex}`;

export const StatusPicker: React.FC<StatusPickerProps> = ({
    myStatus,
    onSetStatus,
    currentGame,
    onDismissGame,
    avatarAttachmentId = null,
    userId = null,
    token = null,
    onEditProfile,
}) => {
    const [open, setOpen] = useState(false);
    const [awayMin, setAwayMin] = useState(15);
    const containerRef = useRef<HTMLDivElement>(null);

    useDismissOnOutsideClick(containerRef, open, () => setOpen(false));
    // TASK 2: this popover had no Escape-to-close at all before.
    useEscape(() => setOpen(false), open);

    // Every status change applies immediately — no text to commit separately.
    const handleSetStatus = (status: UserStatus) => onSetStatus(status);

    const cfg = STATUS_CONFIG[myStatus];

    // Portal-based tooltip (cl/useClTooltip) instead of the old group-hover
    // sibling `<div>` — that sibling was `left-full`/`ml-3` off the trigger,
    // which clips against any scrolling/transformed ancestor the rail sits in
    // and was stuck at z-index 50, under the picker's own popover (z-[200])
    // and any modal. `text` accepts a ReactNode so the "Playing X" case can
    // keep its controller icon. Disabled entirely while the popover is open,
    // matching the old `{!open && (...)}` guard.
    const statusTooltipContent = currentGame
        ? <span className="flex items-center gap-1.5"><GameControllerIcon size={16} className="text-green-400" />{currentGame}</span>
        : cfg.label;
    const { anchorProps: statusTipAnchor, tooltip: statusTipNode } = useClTooltip(
        open ? undefined : statusTooltipContent,
        { preferred: 'right' },
    );
    const { ref: statusTipRef, ...statusTipHandlers } = statusTipAnchor;

    return (
        <div ref={containerRef} className="relative flex justify-center w-full">
            {/* Trigger button */}
            <div className="relative" ref={statusTipRef as React.Ref<HTMLDivElement>} {...statusTipHandlers}>
                {/* Plain button so the avatar fills — ClButton's icon cap is a fixed
                    46px circle that would float the image inside the 40px frame. */}
                <button
                    type="button"
                    onClick={() => setOpen(v => !v)}
                    title={currentGame ? `Playing ${currentGame}` : `Status: ${cfg.label}`}
                    className="w-10 h-10 p-0 border-none rounded-full overflow-hidden bg-cl-surface cursor-pointer ring-1 ring-white/10 hover:ring-white/25 transition-[box-shadow]"
                >
                    <EncryptedAvatar
                        attachmentId={avatarAttachmentId}
                        userId={userId}
                        token={token}
                        className="w-full h-full object-cover rounded-full"
                        fallbackSize={18}
                        disableClickProfile
                    />
                </button>
                <span
                    className={`absolute bottom-0 right-0 z-10 flex items-center justify-center pointer-events-none${
                        currentGame && myStatus !== 'offline' ? '' : ' rounded-full border-[2px] border-cl-abyss'
                    }`}
                >
                    <StatusIcon status={myStatus} currentGame={currentGame} size={currentGame && myStatus !== 'offline' ? 12 : 10} />
                </span>
                {statusTipNode}
            </div>

            {/* Popover panel */}
            <div
                className={`
                    absolute left-full ml-3 bottom-0
                    w-64 bg-cl-deep border border-white/[0.08] rounded-2xl shadow-2xl z-[200]
                    transition-all duration-200 ease-out origin-bottom-left
                    ${open
                        ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto'
                        : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
                    }
                `}
            >
                {/* Now Playing row */}
                {currentGame && (
                    <div className="px-2 pt-2">
                        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06]">
                            <GameControllerIcon size={18} className="text-green-400 shrink-0" />
                            <span className="text-xs text-white/80 truncate flex-1">{currentGame}</span>
                            {onDismissGame && (
                                <ClButton icon variant="ghost" size="sm" onClick={e => { e.stopPropagation(); onDismissGame(); }} tooltip="Dismiss">
                                    <X size={12} />
                                </ClButton>
                            )}
                        </div>
                    </div>
                )}

                {/* Presence selector — one 2x2 grid, each tile tinted with its own
                    status color when active. Offline lives here as a peer status
                    rather than a separate "Appear Offline" row below. */}
                <div className="p-3">
                    <p className="text-[10px] font-bold text-cl-faint uppercase tracking-widest mb-2">Status</p>
                    <div className="grid grid-cols-2 gap-1.5">
                        {STATUS_OPTIONS.map(s => {
                            const active = myStatus === s;
                            const color = STATUS_CONFIG[s].color;
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => handleSetStatus(s)}
                                    style={active ? {
                                        backgroundColor: withAlpha(color, '26'),
                                        boxShadow: `inset 0 0 0 1.5px ${withAlpha(color, '80')}`,
                                        color,
                                    } : undefined}
                                    className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-[12.5px] font-bold transition-all ${
                                        active
                                            ? ''
                                            : 'bg-cl-sink text-cl-faint hover:text-cl-text'
                                    }`}
                                >
                                    <StatusDot status={s} size={8} />
                                    <span className="truncate">{STATUS_SHORT_LABEL[s]}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="mx-3 border-t border-white/[0.06]" />

                {/* Auto-away slider */}
                <div className="px-3 pt-3 pb-2">
                    <div className="flex items-baseline justify-between mb-2">
                        <span className="text-[10px] font-bold text-cl-faint uppercase tracking-widest">Auto-away after</span>
                        <span className="font-mono text-[11px] font-bold text-cl-lume">{awayMin} min</span>
                    </div>
                    <ClSlider min={5} max={60} step={5} value={awayMin} onChange={setAwayMin} />
                </div>

                <div className="mx-3 border-t border-white/[0.06]" />

                {/* Edit profile + Done */}
                <div className="px-2 py-2 flex items-center gap-1">
                    {onEditProfile && (
                        <ClButton onClick={() => { setOpen(false); onEditProfile(); }} variant="ghost" row>
                            <Pencil size={14} className="text-cl-faint" />
                            <span className="text-sm font-medium">Edit Profile</span>
                        </ClButton>
                    )}
                    <ClButton onClick={() => setOpen(false)} className="ml-auto">Done</ClButton>
                </div>
            </div>
        </div>
    );
};
