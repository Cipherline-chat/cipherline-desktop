import React, { useId } from 'react';
import { Gavel, Ban, UserMinus, Link as LinkIcon, ShieldOff } from 'lucide-react';
import { ClModal, ClButton } from '../cl';
import { DialogHeader, DialogBody, DialogFooter } from '../dialog/DialogFrame';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { useModalExit } from '../../hooks/useModalExit';
import '../../styles/dialog-member-action.css';

/**
 * Kick / ban confirmation for a server member (opened from the member
 * context menu in ServerContextPanel).
 *
 * Presentation only — `onConfirm` is the caller's own request (the
 * POST …/members/:id/kick | ban it always made); this dialog just asks first.
 * Neither endpoint takes options (both are sent `{}`), so there is nothing to
 * collect here beyond the yes/no.
 *
 * Focus starts on Cancel (ClModal focuses the first focusable element and the
 * footer's Cancel precedes the danger button), so a stray Enter never kicks or
 * bans anyone; Escape / backdrop click cancel.
 */

export type MemberActionKind = 'kick' | 'ban';

interface Props {
    kind: MemberActionKind;
    serverName: string;
    memberId: string;
    memberName: string;
    avatarUrl?: string | null;
    token: string | null;
    /** The caller's action. Fired once, then the dialog closes. */
    onConfirm: () => void;
    onClose: () => void;
}

const COPY: Record<MemberActionKind, {
    verb: string;
    subtitle: string;
    consequences: { icon: React.ReactNode; text: React.ReactNode }[];
    hint: string;
}> = {
    kick: {
        verb: 'Kick',
        subtitle: 'They are removed from the server right away.',
        consequences: [
            { icon: <UserMinus size={15} />, text: 'Removed from the server and its channels' },
            { icon: <LinkIcon size={15} />, text: <>Can <strong>rejoin</strong> with an invite link</> },
        ],
        hint: 'Use Ban to keep them out',
    },
    ban: {
        verb: 'Ban',
        subtitle: 'They are removed and kept out until you unban them.',
        consequences: [
            { icon: <UserMinus size={15} />, text: 'Removed from the server and its channels' },
            { icon: <ShieldOff size={15} />, text: <>Can <strong>not rejoin</strong>, even with an invite link</> },
        ],
        hint: 'Undo in Settings → Bans',
    },
};

export const MemberActionDialog: React.FC<Props> = ({
    kind, serverName, memberId, memberName, avatarUrl, token, onConfirm, onClose,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 200);
    const titleId = useId();
    const c = COPY[kind];

    const confirm = () => { onConfirm(); handleClose(); };

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={460}
            label={`${c.verb} ${memberName} from ${serverName}`}
            cardClassName="dlg-card dlg-card--danger"
        >
            <DialogHeader
                icon={kind === 'kick' ? <Gavel size={18} /> : <Ban size={18} />}
                titleId={titleId}
                title={`${c.verb} ${memberName} from ${serverName}?`}
                subtitle={c.subtitle}
            />
            <DialogBody>
                <div className="mact-member">
                    <EncryptedAvatar
                        attachmentId={avatarUrl || undefined}
                        userId={memberId}
                        token={token}
                        className="w-10 h-10 shrink-0 ring-1 ring-white/5"
                        fallbackSize={22}
                        disableClickProfile
                    />
                    <div className="mact-member-text">
                        <div className="mact-member-name">{memberName}</div>
                        <div className="mact-member-sub">Member of {serverName}</div>
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

export default MemberActionDialog;
