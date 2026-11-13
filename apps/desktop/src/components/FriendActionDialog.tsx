import React, { useId, useRef } from 'react';
import { Ban, UserMinus, UserX, MessageSquareOff, EyeOff, History, UserPlus } from 'lucide-react';
import { ClModal, ClButton } from './cl';
import { DialogHeader, DialogBody, DialogFooter } from './dialog/DialogFrame';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { lookupUserAvatarId } from '../utils/peerIdentityCache';
import '../styles/dialog-member-action.css';

/**
 * Block / remove-friend confirmation for another person (opened from the
 * friend, DM, profile and member context menus).
 *
 * Presentation only: `onConfirm` is the caller's own request
 * (POST /friends/block, DELETE /friends/:id — the calls each surface always
 * made); this dialog just asks first, in the house dialog pattern
 * (components/dialog/DialogFrame), the same shape as MemberActionDialog.
 *
 * What the copy says is what the server does:
 *  - block rewrites the friendship row to `blocked` (so they are no longer a
 *    friend), drops delivery between the two of you in both directions —
 *    DMs and shared groups — and tells the other side nothing beyond what an
 *    unfriend would;
 *  - remove-friend deletes the friendship; the DM history stays on your
 *    device, and a new request can be sent later.
 *
 * Focus starts on Cancel (ClModal focuses the first focusable element and the
 * footer's Cancel precedes the danger button), so a stray Enter never blocks
 * or unfriends anyone; Escape / backdrop click cancel.
 */

export type FriendActionKind = 'block' | 'unfriend';

interface Props {
    kind: FriendActionKind;
    userId: string;
    /** Display name; blank falls back to "this person". */
    username: string;
    /** Attachment id of their avatar; looked up from the identity cache when omitted. */
    avatarUrl?: string | null;
    token: string | null;
    /** The caller's action. Fired once, then the dialog closes. */
    onConfirm: () => void;
    onClose: () => void;
}

const COPY: Record<FriendActionKind, {
    verb: string;
    title: (name: string) => string;
    subtitle: string;
    consequences: { icon: React.ReactNode; text: React.ReactNode }[];
    hint: React.ReactNode;
}> = {
    block: {
        verb: 'Block',
        title: (n) => `Block ${n}?`,
        subtitle: 'They are removed from your friends and cut off from you.',
        consequences: [
            { icon: <UserMinus size={15} />, text: 'Removed from your friends' },
            { icon: <MessageSquareOff size={15} />, text: <>Can&rsquo;t <strong>message you</strong> or send friend requests, even in shared groups</> },
            { icon: <EyeOff size={15} />, text: <>They <strong>aren&rsquo;t notified</strong> that you blocked them</> },
        ],
        hint: 'Unblock in Friends → Blocked',
    },
    unfriend: {
        verb: 'Remove',
        title: (n) => `Remove ${n} as a friend?`,
        subtitle: 'They stay in your chat history, but you stop being friends.',
        consequences: [
            { icon: <UserX size={15} />, text: 'Removed from your friends list' },
            { icon: <MessageSquareOff size={15} />, text: <>You&rsquo;ll no longer be able to <strong>send messages</strong></> },
            { icon: <History size={15} />, text: <>Your chat history <strong>stays visible</strong></> },
        ],
        hint: <><UserPlus size={13} aria-hidden /><span>You can send a new request later</span></>,
    },
};

export const FriendActionDialog: React.FC<Props> = ({
    kind, userId, username, avatarUrl, token, onConfirm, onClose,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 200);
    const titleId = useId();
    const firedRef = useRef(false);
    const c = COPY[kind];
    const name = username.trim() || 'this person';
    const avatarId = avatarUrl ?? lookupUserAvatarId(userId);

    // Once the exit animation starts the buttons are still on screen for a
    // moment; a second click must not fire the caller's request again.
    const confirm = () => {
        if (firedRef.current) return;
        firedRef.current = true;
        onConfirm();
        handleClose();
    };

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            label={c.title(name)}
            cardClassName="dlg-card dlg-card--danger"
        >
            <DialogHeader
                tone="danger"
                icon={kind === 'block' ? <Ban size={18} /> : <UserMinus size={18} />}
                titleId={titleId}
                title={c.title(name)}
                subtitle={c.subtitle}
            />
            <DialogBody>
                <div className="mact-member">
                    <EncryptedAvatar
                        attachmentId={avatarId || undefined}
                        userId={userId}
                        token={token}
                        className="w-10 h-10 shrink-0 ring-1 ring-white/5"
                        fallbackSize={22}
                        disableClickProfile
                    />
                    <div className="mact-member-text">
                        <div className="mact-member-name">{name}</div>
                    </div>
                </div>
                <ul className="mact-list">
                    {c.consequences.map((row, i) => (
                        <li key={i}>
                            <span className="mact-ico" aria-hidden="true">{row.icon}</span>
                            <span>{row.text}</span>
                        </li>
                    ))}
                </ul>
            </DialogBody>
            <DialogFooter hint={c.hint}>
                <ClButton variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                <ClButton variant="danger" size="sm" onClick={confirm}>{c.verb}</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default FriendActionDialog;
