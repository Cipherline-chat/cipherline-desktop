import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { Search, Users, MessageSquare } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { ClModal, ClButton, ClSearch, ClSkeleton } from './cl';
import { emitMascotCue } from '../hooks/useMascotCue';
import { CUTTLEFISH_POOL, SELF_EGGS, pickRotating } from '../utils/eggPools';
import { buildDmPickerResults, isSelfDm, selfConversationTitle } from '../utils/selfConversation';

interface StartDMModalProps {
    onClose: () => void;
    onDMStarted: (chat: { id: string; title: string; type: string; other_user_id: string; avatar_url?: string }) => void;
    existingConversations: any[];
}

export const StartDMModal: React.FC<StartDMModalProps> = ({ onClose, onDMStarted, existingConversations }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { token, deviceId, user } = useAuth();
    const [friends, setFriends] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [openingId, setOpeningId] = useState<string | null>(null);
    const [egg, setEgg] = useState<string | null>(null);
    const selfEggIdx = useRef(0);
    const cuttlefishEggIdx = useRef(0);

    useEffect(() => {
        let isMounted = true;
        axios.get(`${API_BASE}/friends`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then(res => {
            if (isMounted) { setFriends(res.data.accepted || []); setLoading(false); }
        }).catch(() => {
            if (isMounted) setLoading(false);
        });
        return () => { isMounted = false; };
    }, [token]);

    const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        setSearch(v);
        const q = v.trim().toLowerCase();
        if (q === 'cuttlefish') {
            // emitMascotCue self-limits to once per session; the line still
            // rotates on every retype (owned field slot, rule 6).
            emitMascotCue();
            setEgg(pickRotating(CUTTLEFISH_POOL, cuttlefishEggIdx.current));
            cuttlefishEggIdx.current++;
            return;
        }
        const myName = user?.username?.toLowerCase() ?? '';
        if (myName && (q === myName || q === 'me' || q === 'myself')) {
            setEgg(pickRotating(SELF_EGGS, selfEggIdx.current));
            selfEggIdx.current++;
            return;
        }
        setEgg(null);
    };

    const handleOpen = async (friend: any) => {
        if (openingId) return;
        setOpeningId(friend.user_id);
        try {
            // For yourself this is the same call with your own id: the server
            // find-or-creates your ONE self conversation (no friendship needed
            // for that exact case; every other id still does).
            const res = await axios.post(
                `${API_BASE}/conversations/dm`,
                { other_user_id: friend.user_id },
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } }
            );
            onDMStarted({
                id: res.data.conversation_id,
                title: friend.user_id === user?.user_id ? selfConversationTitle(friend.username) : friend.username,
                type: 'dm',
                other_user_id: friend.user_id,
                avatar_url: friend.avatar_url,
            });
        } catch {
            setOpeningId(null);
        }
    };

    const existingDMUserIds = new Set(
        existingConversations.filter(c => c.type === 'dm').map(c => c.other_user_id)
    );

    // You appear in the results only when the search points at you (your name,
    // "me", "myself") — never in the empty list: the self chat is not pre-listed.
    // Shaped like a friend row so the same open handler serves it.
    const filtered = buildDmPickerResults({ search, me: user, friends });
    const selfRow = filtered.find(r => r.isSelf) ?? null;
    const hasSelfChat = existingConversations.some(c => isSelfDm(c, user?.user_id));

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={420}
            cardStyle={{ padding: '28px 28px 24px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        >
            <h2 className="text-xl font-bold text-cl-text mt-0 mb-5">New message</h2>

            <div className="mb-1 shrink-0">
                <ClSearch
                    autoFocus
                    icon={<Search size={15} />}
                    type="text"
                    value={search}
                    onChange={handleSearch}
                    placeholder="search people — they're already encrypted to you"
                />
            </div>

            {egg && (
                <p className="text-[11.5px] font-bold text-cl-lume mx-1 mb-2">{egg}</p>
            )}

            <div
                className="overflow-y-auto bg-cl-sink border border-white/5 rounded-xl p-2 custom-scrollbar flex-1 mt-2"
                style={{ minHeight: '200px', maxHeight: '360px' }}
            >
                {loading ? (
                    /* skeleton friend rows, not a spinner — kit rule for content loading */
                    <div className="flex flex-col gap-2 p-2">
                        {[0, 1, 2, 3].map(i => (
                            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
                                <ClSkeleton variant="avt" />
                                <ClSkeleton variant="ln" style={{ width: 120 + (i % 3) * 40 }} />
                            </div>
                        ))}
                    </div>
                ) : friends.length === 0 && !selfRow ? (
                    <div className="flex flex-col items-center justify-center h-full py-10 gap-2 text-cl-faint">
                        <Users className="w-8 h-8 opacity-50" />
                        <span className="text-sm">No friends yet. Add some!</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center text-cl-faint py-8 text-sm">
                        no one by that name. they might be in the deep.
                    </div>
                ) : (
                    filtered.map(f => {
                        const isSelfResult = !!f.isSelf;
                        const hasExisting = isSelfResult ? hasSelfChat : existingDMUserIds.has(f.user_id);
                        const isOpening = openingId === f.user_id;
                        return (
                            <ClButton
                                key={f.user_id}
                                onClick={() => handleOpen(f)}
                                disabled={!!openingId}
                                variant="ghost"
                                row
                                fullWidth
                                loading={isOpening}
                                style={{ marginBottom: 2 }}
                            >
                                <div className="w-9 h-9 rounded-full shrink-0 overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--cl-border)' }}>
                                    <EncryptedAvatar attachmentId={f.avatar_url} userId={f.user_id} token={token} className="w-full h-full" fallbackSize={17} disableClickProfile />
                                </div>
                                <span className="text-[14px] font-semibold text-cl-text truncate flex-1 text-left">
                                    {isSelfResult ? selfConversationTitle(f.username) : f.username}
                                </span>
                                {!isOpening && (hasExisting ? (
                                    <span className="text-[11px] text-cl-faint shrink-0 font-medium tracking-wide">
                                        existing chat
                                    </span>
                                ) : (
                                    <MessageSquare className="w-4 h-4 text-cl-faint shrink-0" />
                                ))}
                            </ClButton>
                        );
                    })
                )}
            </div>

            <div className="flex justify-end mt-4 shrink-0">
                <ClButton variant="ghost" onClick={handleClose}>Cancel</ClButton>
            </div>
        </ClModal>
    );
};
