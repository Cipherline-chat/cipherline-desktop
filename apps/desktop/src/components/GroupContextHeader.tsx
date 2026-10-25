import React from 'react';
import { Users } from 'lucide-react';
import { GroupBackdrop } from './GroupBackdrop';

/** "1 member" / "N members" (0 reads "0 members"). */
// eslint-disable-next-line react-refresh/only-export-components -- tiny pure helper co-located with its only UI; only affects dev Fast Refresh
export const memberCountLabel = (n: number): string => `${n} ${n === 1 ? 'member' : 'members'}`;

interface GroupContextHeaderProps {
    title: string;
    memberCount: number;
    /** The group picture's attachment id (conversation.avatar_url). */
    avatarUrl?: string | null;
    token: string | null;
}

/**
 * The group's card at the top of the right-hand context panel: name + member
 * count over the group picture, blurred and darkened (see group-hero.css for
 * the contrast contract). With no picture — or while it loads — it is the same
 * plain surface card the panel always had.
 */
export const GroupContextHeader: React.FC<GroupContextHeaderProps> = ({ title, memberCount, avatarUrl, token }) => (
    <div className="cl-group-hero mb-3.5" data-testid="group-context-header">
        <GroupBackdrop attachmentId={avatarUrl ?? null} token={token} />
        <div className="cl-group-hero-copy">
            <div className="cl-group-hero-title font-display">{title}</div>
            <div className="cl-group-hero-count">
                <Users size={12} aria-hidden="true" /> <span>{memberCountLabel(memberCount)}</span>
            </div>
        </div>
    </div>
);
