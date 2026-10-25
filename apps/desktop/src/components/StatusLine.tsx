import React from 'react';
import { GameControllerIcon } from './GameControllerIcon';
import { customStatusLabel, parseStatusEmoji, statusLineModel } from '../utils/customStatus';
import type { FriendStatusEntry } from '../utils/userStatusModel';
import { personalStatusEmoji } from './personalStatusEmoji';
import { MusicNoteIcon } from './integrations/MusicNoteIcon';
import { listeningDetail, useListening } from '../utils/integrations/listening';

/**
 * The status emoji slot. A unicode emoji renders as text. A personal custom
 * emoji (`cl:p_<id>`) renders through `renderCustom` (see `personalStatusEmoji`
 * below); without it, or for any other `cl:` value, nothing - never the raw token.
 */
export const StatusEmoji: React.FC<{
    value: string | null | undefined;
    className?: string;
    renderCustom?: (ref: string) => React.ReactNode;
}> = ({ value, className, renderCustom }) => {
    const parsed = parseStatusEmoji(value);
    if (!parsed) return null;
    if (parsed.kind === 'custom') return renderCustom ? <>{renderCustom(parsed.ref)}</> : null;
    return <span className={className} aria-hidden="true">{parsed.value}</span>;
};

type EntryLike = Pick<FriendStatusEntry, 'status' | 'custom_status_text' | 'custom_status_emoji' | 'custom_status_expires_at' | 'current_game' | 'on_mobile'>;

interface StatusLineProps {
    entry: EntryLike | null | undefined;
    className?: string;
    style?: React.CSSProperties;
    /** Whose status this is: lets a personal-emoji status be fetched under their audience gate. */
    userId?: string | null;
    /** Play an animated personal emoji (the profile card); lists show its first frame unless hovered. */
    animate?: boolean;
    /** Controller size beside a custom status. */
    iconSize?: number;
    /** Game-only rendering (no custom status): defaults to "Playing <game>". */
    renderGame?: (game: string) => React.ReactNode;
    /** Nothing to say (no custom status, no game): e.g. the plain status label. */
    fallback?: React.ReactNode;
}

/**
 * The line under a name. Custom status wins over the game; when there is also
 * a game, a small controller sits next to it ("Playing <game>" on hover). The
 * decision itself is `statusLineModel` (utils/customStatus.ts); this only draws
 * it, truncated, with the full text as the tooltip.
 */
export const StatusLine: React.FC<StatusLineProps> = ({ entry, className, style, userId, animate = false, iconSize = 12, renderGame, fallback = null }) => {
    const m = statusLineModel(entry);
    // "Listening to ..." (friends only, utils/integrations/listening.ts) ranks like a
    // game but below one: a game wins the line; with a custom status, a small note
    // sits beside it as the controller does. Surfaces that keep the game OFF this
    // line (renderGame returns null) keep the listening text off it too.
    const heard = useListening(entry && entry.status !== 'offline' ? userId : null);
    const listeningTip = heard ? `Listening to ${heard.track} — ${listeningDetail(heard)}` : null;
    const activityText = !renderGame || renderGame('') !== null;
    if (m.kind === 'none') {
        if (heard && activityText) {
            return (
                <span className={['inline-flex items-center gap-1 min-w-0', className ?? ''].filter(Boolean).join(' ')} style={style} title={listeningTip ?? undefined} data-testid="status-line-listening">
                    <MusicNoteIcon size={iconSize} className="shrink-0 text-cl-ok" />
                    <span className="truncate min-w-0">Listening to {heard.track}</span>
                </span>
            );
        }
        return <>{fallback}</>;
    }
    if (m.kind === 'game') {
        return <span className={className} style={style}>{renderGame ? renderGame(m.game!) : `Playing ${m.game}`}</span>;
    }
    const label = customStatusLabel(m);
    return (
        <span
            className={['flex items-center gap-1 min-w-0', className ?? ''].filter(Boolean).join(' ')}
            style={style}
            title={label || undefined}
            data-testid="status-line"
        >
            <StatusEmoji value={m.emoji} className="shrink-0" renderCustom={personalStatusEmoji(userId, animate)} />
            {m.text && <span className="truncate min-w-0">{m.text}</span>}
            {m.kind === 'custom' && heard && (
                <span className="shrink-0 inline-flex items-center text-cl-ok" title={listeningTip ?? undefined} data-testid="status-line-listening">
                    <MusicNoteIcon size={iconSize} />
                </span>
            )}
            {m.kind === 'custom+game' && (
                <span className="shrink-0 inline-flex items-center text-cl-ok" title={m.gameTooltip ?? undefined} data-testid="status-line-game">
                    <GameControllerIcon size={iconSize} />
                </span>
            )}
        </span>
    );
};
