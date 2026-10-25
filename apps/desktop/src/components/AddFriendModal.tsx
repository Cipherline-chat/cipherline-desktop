import React, { useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { UserPlus, CheckCircle2, Bell } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { parseUserTag } from '@cipherline/shared';
import { ClButton, ClInput, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError, DialogOk, DialogField } from './dialog/DialogFrame';
import { nudges } from '../utils/firstWeekNudgeStore';
import { isOwnTag, requestMoment } from '../utils/moments';
import { SELF_FRIEND_ERRORS, pickRotating } from '../utils/eggPools';

interface AddFriendModalProps {
    onClose: () => void;
}

export const AddFriendModal: React.FC<AddFriendModalProps> = ({ onClose }) => {
    const { token, user } = useAuth();
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [username, setUsername] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const selfTries = useRef(0);

    const handleSendRequest = async (e: React.FormEvent) => {
        e.preventDefault();
        const input = username.trim();
        if (!input) {
            setError('Please enter a username');
            return;
        }
        const parsed = parseUserTag(input);
        if (!parsed) {
            setError('Format: Username#1234');
            return;
        }
        // Your own tag: never sent (the server would only refuse it). The
        // error slot says so plainly; the full-screen moment is the joke.
        if (isOwnTag(parsed, user)) {
            setError(pickRotating(SELF_FRIEND_ERRORS, selfTries.current++));
            requestMoment('self-friend');
            return;
        }

        setIsSending(true);
        setError(null);
        setSuccess(null);

        try {
            await axios.post(`${API_BASE}/friends/request`, {
                target_username: parsed.username,
                target_discriminator: parsed.discriminator,
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            nudges.notify({ kind: 'friend_request_sent' });
            setSuccess(`Friend request sent to ${input}!`);
            setUsername('');
            setTimeout(() => { handleClose(); }, 1500);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Failed to send friend request');
        } finally {
            setIsSending(false);
        }
    };

    return (
        <ClModal open={!closing} onClose={handleClose} width={440} label="Add a friend" cardClassName="dlg-card">
            <form onSubmit={handleSendRequest} className="dlg-form" noValidate>
                <DialogHeader
                    tone={success ? 'ok' : 'default'}
                    icon={success ? <CheckCircle2 size={19} strokeWidth={2.2} /> : <UserPlus size={19} strokeWidth={2.2} />}
                    title="Add a friend"
                    subtitle="Send a request using their full tag."
                />
                <DialogBody>
                    <DialogField label="Their tag" htmlFor="add-friend-tag" help={<>Looks like <b style={{ color: 'var(--cl-text, #F4F7FF)' }}>Username#1234</b></>}>
                        <ClInput
                            id="add-friend-tag"
                            type="text"
                            value={username}
                            onChange={e => { setUsername(e.target.value); setError(null); }}
                            placeholder="Username#1234"
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            disabled={isSending || !!success}
                        />
                    </DialogField>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                {success && <DialogOk>{success}</DialogOk>}
                <DialogFooter hint={<><Bell size={13} /><span>They&rsquo;ll be notified</span></>}>
                    <ClButton type="button" variant="ghost" size="sm" disabled={isSending} onClick={handleClose}>
                        Cancel
                    </ClButton>
                    <ClButton type="submit" size="sm" disabled={isSending || !username.trim() || !!success} loading={isSending}>
                        Send request
                    </ClButton>
                </DialogFooter>
            </form>
        </ClModal>
    );
};
