import React, { useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { UserPlus, CheckCircle2 } from 'lucide-react';
import { useModalExit } from '../hooks/useModalExit';
import { parseUserTag } from '@cipherline/shared';
import { ClButton, ClInput, ClModal } from './cl';
import { nudges } from '../utils/firstWeekNudgeStore';

interface AddFriendModalProps {
    onClose: () => void;
}

export const AddFriendModal: React.FC<AddFriendModalProps> = ({ onClose }) => {
    const { token } = useAuth();
    const { closing, handleClose } = useModalExit(onClose, 260);
    const [username, setUsername] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

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
        } catch (err: any) {
            setError(err?.response?.data?.message || 'Failed to send friend request');
        } finally {
            setIsSending(false);
        }
    };

    return (
        <ClModal open={!closing} onClose={handleClose} width={400} cardStyle={{ padding: '32px' }}>
                {/* Icon */}
                <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-5 ring-1 transition-all duration-300
                    ${success
                        ? 'bg-cl-ok/10 ring-cl-ok/20 text-cl-ok'
                        : 'bg-cl-lume/10 ring-cl-lume/20 text-cl-lume'}`}
                >
                    {success ? <CheckCircle2 className="w-6 h-6" /> : <UserPlus className="w-6 h-6" />}
                </div>

                <h2 className="text-xl font-bold text-cl-text mb-2 mt-0">Add Friend</h2>
                <p className="text-[13px] text-cl-muted mb-6">
                    Enter their full tag, e.g. <span className="text-cl-text font-semibold">Username#1234</span>.
                    They'll get a notification — then it's their call.
                </p>

                {error && (
                    <div className="text-cl-flash font-medium text-[13px] mb-4 bg-cl-flash/10 border border-cl-flash/20 px-3 py-2 rounded-lg">
                        {error}
                    </div>
                )}
                {success && (
                    <div className="text-cl-ok font-medium text-[13px] mb-4 bg-cl-ok/10 border border-cl-ok/20 px-3 py-2 rounded-lg">
                        {success}
                    </div>
                )}

                <form onSubmit={handleSendRequest} className="mb-0 flex flex-col">
                    <label className="block text-[13px] font-semibold text-cl-faint mb-2 uppercase tracking-wide">
                        Their tag
                    </label>
                    <ClInput
                        type="text"
                        value={username}
                        onChange={e => { setUsername(e.target.value); setError(null); }}
                        placeholder="Username#1234"
                        autoFocus
                        style={{ marginBottom: 24 }}
                        disabled={isSending || !!success}
                    />

                    <div className="flex justify-end gap-2.5 shrink-0">
                        <ClButton type="button" variant="ghost" disabled={isSending} onClick={handleClose}>
                            Cancel
                        </ClButton>
                        <ClButton type="submit" disabled={isSending || !username.trim() || !!success} loading={isSending}>
                            Send Request
                        </ClButton>
                    </div>
                </form>
            </ClModal>
    );
};
