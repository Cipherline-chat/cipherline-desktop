import React from 'react';
import { ProfilePopoutCard, OpenProfileButton } from '../../profile/ProfilePopoutCard';
import { ClButton } from '../../cl';
import { MessageSquare, Hand, UserPlus } from 'lucide-react';
import type { VisibilityField } from '../../../utils/profileVisibility';
import { previewCardData, type ProfilePreviewData } from './profilePreviewData';

export type { ProfilePreviewData } from './profilePreviewData';

/**
 * Your profile PREVIEW exactly as the chosen audience sees it when they click
 * you: the SAME component the popover draws (profile/ProfilePopoutCard), fed
 * from your drafts. `seen` is what that audience is shown; `showLocks` draws
 * the friends-only locks a friend sees on the fields you restricted.
 *
 * A locked decoration / effect being tried on shows here like any other; the
 * Style editor beside it says it is locked and how to earn it (no second
 * banner above the card).
 */
export const ProfilePreviewCard: React.FC<{
    data: ProfilePreviewData;
    seen: Record<VisibilityField, boolean>;
    friendsOnly: VisibilityField[];
    /** Draw locks on friends-only fields, and the friend-only parts (the "a friend" audience). */
    showLocks: boolean;
    label?: string;
    /** "Open profile" in the picture opens your real full profile. */
    onOpenFull?: () => void;
}> = ({ data, seen, friendsOnly, showLocks, label, onOpenFull }) => {
    const asFriend = showLocks;
    return (
        <ProfilePopoutCard
            userId={data.userId ?? ''}
            token={data.token ?? ''}
            isSelf={false}
            label={label}
            testId="pv-preview"
            avatarId={data.avatarAttachmentId}
            bannerId={seen.banner ? data.bannerAttachmentId : null}
            bannerSrc={seen.banner ? data.bannerSrc ?? null : null}
            bannerFriendsOnly={showLocks && friendsOnly.includes('banner')}
            avatarLabel="Your avatar"
            avatarBadge={<span className="pcd-dot" style={{ backgroundColor: '#4ADE80' }} title="Online" />}
            presence={<span className="pcd-status-line"><span className="pcd-status-dot" style={{ backgroundColor: '#4ADE80' }} aria-hidden="true" /><b style={{ color: '#4ADE80' }}>Online</b></span>}
            data={previewCardData(data, seen, friendsOnly, asFriend)}
            // What the viewer's buttons will be; inert here (this is a picture of the card).
            actionsInert
            actions={(
                <>
                    <ClButton variant="primary" fullWidth>
                        {asFriend ? <MessageSquare size={14} /> : <UserPlus size={14} />} {asFriend ? 'Message' : 'Add friend'}
                    </ClButton>
                    <span className="pcd-hf">
                        <span className="pcd-hf-btn"><Hand size={16} />{(data.highFiveCount ?? 0) > 0 ? <span className="pcd-hf-n">{data.highFiveCount}</span> : <span>High five</span>}</span>
                    </span>
                    <OpenProfileButton onClick={() => onOpenFull?.()} />
                </>
            )}
        />
    );
};
