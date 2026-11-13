/**
 * InviteFriendsList — the "send it to a friend" half of the Invite People
 * dialog.
 *
 * Recent friends (people you just added or last chatted with — ordering rules
 * in utils/inviteFriends.ts, computed on this device) with an Invite button per
 * row, and a search box that reaches every friend. Invite DMs the dialog's
 * CURRENT link through the host's normal E2EE send path (`onSend`); the row then
 * reads "Sent ✓". People already in the server are marked and not offered.
 *
 * Presentational plus the per-row send state; it never talks to the network
 * itself.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Check, Search, Send, Users } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { ClButton, ClSearch } from '../cl';
import { BusyLabel } from '../dialog/BusyLabel';
import { recentInviteFriends, searchInviteFriends, type InviteFriend } from '../../utils/inviteFriends';
import '../../styles/dialog-server.css';

interface Props {
    friends: readonly InviteFriend[];
    /** Users already in the server, when the client knows (null = unknown: nobody is marked). */
    memberIds: ReadonlySet<string> | null;
    token: string | null;
    /** The code Invite will send; null while the link is being (re)made. */
    code: string | null;
    /** DM `code` to `userId` over the normal send path. Resolves true when it went out. */
    onSend: (userId: string, code: string) => Promise<boolean>;
    /** The friends list has not loaded yet. */
    loading?: boolean;
}

type RowState = 'idle' | 'sending' | 'sent' | 'error';

const SUB: Record<NonNullable<InviteFriend['recentReason']>, string> = {
    'message': 'Recent chat',
    'new-friend': 'New friend',
};

export const InviteFriendsList: React.FC<Props> = ({ friends, memberIds, token, code, onSend, loading }) => {
    const [query, setQuery] = useState('');
    // userId -> the code it was last sent (a regenerated link makes the row offer Invite again).
    const [sentCode, setSentCode] = useState<Record<string, string>>({});
    const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
    const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

    const searching = query.trim().length > 0;
    const rows = useMemo(
        () => (searching ? searchInviteFriends(friends, query) : recentInviteFriends(friends)),
        [friends, query, searching],
    );

    const stateOf = (userId: string): RowState =>
        sending.has(userId) ? 'sending'
            : code && sentCode[userId] === code ? 'sent'
                : failed.has(userId) ? 'error'
                    : 'idle';

    // A ref as well as state: two clicks inside one tick share a render's closure.
    const inFlight = useRef(new Set<string>());
    const send = async (userId: string) => {
        if (!code || inFlight.current.has(userId)) return;
        inFlight.current.add(userId);
        const forCode = code;
        setSending(prev => new Set(prev).add(userId));
        setFailed(prev => { const n = new Set(prev); n.delete(userId); return n; });
        let ok = false;
        try { ok = await onSend(userId, forCode); } catch { ok = false; }
        inFlight.current.delete(userId);
        setSending(prev => { const n = new Set(prev); n.delete(userId); return n; });
        if (ok) setSentCode(prev => ({ ...prev, [userId]: forCode }));
        else setFailed(prev => new Set(prev).add(userId));
    };

    return (
        <div className="dlg-fr" data-testid="invite-friends">
            <div className="dlg-section">{searching ? 'Results' : 'Recent friends'}</div>
            <ClSearch
                icon={<Search size={14} aria-hidden="true" />}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search friends by name"
                aria-label="Search friends by name"
                autoComplete="off"
                spellCheck={false}
            />
            {loading && friends.length === 0 ? (
                <div className="dlg-fr-empty" role="status">Loading friends…</div>
            ) : rows.length === 0 ? (
                <div className="dlg-fr-empty" role="status">
                    <Users size={14} aria-hidden="true" />
                    {searching
                        ? `No friends match “${query.trim()}”.`
                        : 'Add friends to send them invites right from here.'}
                </div>
            ) : (
                <ul className="dlg-fr-list custom-scrollbar" aria-label={searching ? 'Search results' : 'Recent friends'}>
                    {rows.map(f => {
                        const isMember = memberIds?.has(f.userId) ?? false;
                        const st = stateOf(f.userId);
                        const tag = f.discriminator === null ? null : `#${padDiscriminator(f.discriminator)}`;
                        return (
                            <li key={f.userId} className="dlg-fr-row" data-user-id={f.userId} data-state={isMember ? 'member' : st}>
                                <span className="dlg-fr-av">
                                    <EncryptedAvatar
                                        attachmentId={f.avatarUrl}
                                        userId={f.userId}
                                        token={token}
                                        className="w-full h-full"
                                        fallbackSize={14}
                                        disableClickProfile
                                    />
                                </span>
                                <span className="dlg-fr-text">
                                    <span className="dlg-fr-name">
                                        <span className="dlg-fr-uname">{f.username}</span>
                                        {tag && <span className="dlg-fr-tag">{tag}</span>}
                                    </span>
                                    <span className={`dlg-fr-sub${st === 'error' ? ' dlg-fr-sub--err' : ''}`}>
                                        {isMember ? 'Already in this server'
                                            : st === 'error' ? 'Couldn’t send. Try again.'
                                                : !searching && f.recentReason ? SUB[f.recentReason] : ''}
                                    </span>
                                </span>
                                {isMember ? (
                                    <span className="dlg-fr-member">Member</span>
                                ) : st === 'sent' ? (
                                    <span className="dlg-fr-sent" role="status"><Check size={13} strokeWidth={2.8} aria-hidden="true" /> Sent</span>
                                ) : (
                                    <ClButton
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => void send(f.userId)}
                                        disabled={!code || st === 'sending'}
                                        className={st === 'sending' ? 'dlg-busy' : undefined}
                                    >
                                        <BusyLabel busy={st === 'sending'}>
                                            {st !== 'sending' && <Send size={12} aria-hidden="true" />} {st === 'error' ? 'Retry' : 'Invite'}<span className="sr-only"> {f.username}</span>
                                        </BusyLabel>
                                    </ClButton>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default InviteFriendsList;
