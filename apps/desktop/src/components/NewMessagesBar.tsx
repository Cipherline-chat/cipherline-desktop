import React from 'react';
import { ArrowDown } from 'lucide-react';
import '../styles/new-messages-bar.css';

/**
 * The bar across the top of the message feed while the reader is scrolled up
 * (owner, 2026-11-26: "just have a small thing that says jump to new message
 * or whatever at the top"). Discord's "N new messages since 3:42 PM" strip.
 *
 * Two states, one slot, so there is never a second competing indicator:
 *   - new messages arrived while scrolled up: "3 new messages since 3:42 PM",
 *     Jump → the first unseen message;
 *   - nothing new, but the reader is far up in history: "You're viewing older
 *     messages", Jump to present → the bottom. (This replaced the old
 *     top-centre "Jump to latest" pill, which showed only past 1500 px.)
 *
 * It sits inside the feed's own wrapper, so it can never cover the channel
 * header or the banners stacked above the feed (pinned strip, announcements,
 * unverified-device warning). The count is announced through a polite live
 * region that stays mounted (a region that mounts with its text is often not
 * announced at all); the bar itself is a real <button>.
 */
export interface NewMessagesBarProps {
    /** "3 new messages since 3:42 PM", or null when nothing new arrived. */
    newLabel: string | null;
    /** Reader is far from the bottom (shown only when there is no new label). */
    farFromBottom: boolean;
    onJumpToNew: () => void;
    onJumpToPresent: () => void;
}

export const NewMessagesBar: React.FC<NewMessagesBarProps> = ({ newLabel, farFromBottom, onJumpToNew, onJumpToPresent }) => {
    const mode: 'new' | 'older' | null = newLabel ? 'new' : farFromBottom ? 'older' : null;
    return (
        <>
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {newLabel ?? ''}
            </div>
            {mode && (
                <button
                    type="button"
                    data-new-messages-bar={mode}
                    className={`cl-newmsg-bar cl-newmsg-bar--${mode}`}
                    onClick={mode === 'new' ? onJumpToNew : onJumpToPresent}
                    aria-label={mode === 'new'
                        ? `${newLabel}. Jump to the first new message`
                        : 'You are viewing older messages. Jump to present'}
                >
                    <span className="cl-newmsg-bar__label">
                        {mode === 'new' ? newLabel : 'You’re viewing older messages'}
                    </span>
                    <span className="cl-newmsg-bar__action" aria-hidden="true">
                        {mode === 'new' ? 'Jump' : 'Jump to present'}
                        <ArrowDown className="cl-newmsg-bar__icon" />
                    </span>
                </button>
            )}
        </>
    );
};

export default NewMessagesBar;
