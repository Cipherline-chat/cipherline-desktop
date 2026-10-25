import React, { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useAuth } from '../contexts/AuthContext';
import { MessageSquarePlus, SearchX, UserPlus, Users, WifiOff, ArrowRight } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useModalExit } from '../hooks/useModalExit';
import { ClModal, ClButton } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from './dialog/DialogFrame';
import { PeopleSearchField, PeopleListbox, PickerEmptyState, PickerSkeleton } from './peoplePicker/PeoplePicker';
import { AddFriendModal } from './AddFriendModal';
import { emitMascotCue } from '../hooks/useMascotCue';
import { CUTTLEFISH_POOL, SELF_EGGS, pickRotating } from '../utils/eggPools';
import { recordEggFound } from '../utils/eggProgress';
import { buildDmPickerResults, isSelfDm, selfConversationTitle } from '../utils/selfConversation';
import {
    toPickerPeople, buildPickerSections, flattenSections, moveHighlight, pickerKeyIntent,
    type PickerPerson, type PickerStatusEntry,
} from '../utils/peoplePicker';

export interface StartGroupPerson {
    user_id: string;
    username: string;
    avatar_url?: string;
}

interface StartDMModalProps {
    onClose: () => void;
    onDMStarted: (chat: { id: string; title: string; type: string; other_user_id: string; avatar_url?: string }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    existingConversations: any[];
    /** Live presence per user (useUserStatus' `friendStatuses`). Optional: falls back to the friends payload's status. */
    friendStatuses?: Record<string, PickerStatusEntry | undefined>;
    /** Boolean presence from the DM poll (Dashboard's `displayPresence`). */
    presence?: Record<string, boolean | undefined>;
    /** Device-local last-message time per conversation id (Dashboard's `lastActivityAt`). */
    lastActivityAt?: Record<string, number>;
    /**
     * The footer's low-key "Start a group chat" link: hands the currently
     * picked friend (or an empty list) to the group-creation step (name +
     * photo). Nothing is created here; the host closes this dialog. Without
     * this prop the link is hidden.
     */
    onStartGroup?: (people: StartGroupPerson[]) => void;
}

/**
 * "New message" — pick ONE friend to open (or start) your chat with them. A
 * quiet footer link ("Start a group chat") leads to the group-creation step.
 *
 * Behaviour that MUST NOT change with the redesign (pinned by
 * StartDMModal.test.ts):
 *   - only accepted friends are listed (GET /friends → `accepted`); the server
 *     additionally refuses a DM with a non-friend — the client never works
 *     around that gate;
 *   - opening a 1:1 is ONE call, `POST /conversations/dm { other_user_id }`,
 *     which find-or-creates the conversation, then `onDMStarted`;
 *   - yourself appears only when the search points at you (selfConversation.ts).
 *
 * Interaction: single-select. A click picks a row (no checkboxes), the footer's
 * "Open chat" button opens the picked chat, and the highlighted row's pill — or
 * Enter on the highlighted row — opens in one step. Groups are NOT built here:
 * the footer link goes to CreateGroupModal (prefilled with the pick, if any).
 * Full keyboard contract: pickerKeyIntent.
 */
export const StartDMModal: React.FC<StartDMModalProps> = ({
    onClose, onDMStarted, existingConversations, friendStatuses, presence, lastActivityAt, onStartGroup,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { token, deviceId, user } = useAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    const [friends, setFriends] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [search, setSearch] = useState('');
    const [openingId, setOpeningId] = useState<string | null>(null);
    const [openError, setOpenError] = useState<string | null>(null);
    const [egg, setEgg] = useState<string | null>(null);
    const [pickedId, setPickedId] = useState<string | null>(null);
    const [highlightRaw, setHighlightedId] = useState<string | null>(null);
    const [scrollSignal, setScrollSignal] = useState(0);
    const [showAddFriend, setShowAddFriend] = useState(false);
    const selfEggIdx = useRef(0);
    const cuttlefishEggIdx = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const uid = useId();
    const listboxId = `${uid}-people`;
    const hintId = `${uid}-keys`;
    const optionId = useCallback((userId: string) => `${uid}-opt-${userId}`, [uid]);
    // One clock reading per open: "2h" labels don't need to tick while the dialog is up.
    const [now] = useState(() => Date.now());

    useEffect(() => {
        let isMounted = true;
        axios.get(`${API_BASE}/friends`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then(res => {
            if (isMounted) { setFriends(res.data.accepted || []); setLoadFailed(false); setLoading(false); }
        }).catch(() => {
            if (isMounted) { setLoadFailed(true); setLoading(false); }
        });
        return () => { isMounted = false; };
    }, [token, reloadKey]);

    const reload = () => { setLoading(true); setLoadFailed(false); setReloadKey(k => k + 1); };

    const updateSearch = (v: string) => {
        setSearch(v);
        const q = v.trim().toLowerCase();
        if (q === 'cuttlefish') {
            // emitMascotCue self-limits to once per session; the line still
            // rotates on every retype (owned field slot, rule 6).
            emitMascotCue();
            recordEggFound('cuttlefish');
            setEgg(pickRotating(CUTTLEFISH_POOL, cuttlefishEggIdx.current));
            cuttlefishEggIdx.current++;
            return;
        }
        const myName = user?.username?.toLowerCase() ?? '';
        if (myName && (q === myName || q === 'me' || q === 'myself')) {
            recordEggFound('self-search');
            setEgg(pickRotating(SELF_EGGS, selfEggIdx.current));
            selfEggIdx.current++;
            return;
        }
        setEgg(null);
    };

    // You appear in the results only when the search points at you (your name,
    // "me", "myself") — never in the empty list: the self chat is not pre-listed.
    // Shaped like a friend row so the same open handler serves it.
    const filtered = buildDmPickerResults({ search, me: user, friends });
    const selfRow = filtered.find(r => r.isSelf) ?? null;
    const hasSelfChat = existingConversations.some(c => isSelfDm(c, user?.user_id));

    const people = useMemo(() => toPickerPeople({
        rows: filtered,
        conversations: existingConversations,
        statuses: friendStatuses,
        presence,
        lastActivityAt,
        myUserId: user?.user_id,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `filtered` is derived from search/friends/user each render
    }), [search, friends, user, existingConversations, friendStatuses, presence, lastActivityAt]);
    const sections = useMemo(() => buildPickerSections(people, search), [people, search]);
    const ordered = useMemo(() => flattenSections(sections), [sections]);
    const orderedIds = useMemo(() => ordered.map(p => p.user_id), [ordered]);

    // A pick only counts while its row is visible: a search that hides it drops it,
    // so "Open chat" never acts on someone you cannot see.
    const picked = useMemo(
        () => (pickedId ? ordered.find(p => p.user_id === pickedId) ?? null : null),
        [pickedId, ordered],
    );
    const selectedSet = useMemo(() => new Set(picked ? [picked.user_id] : []), [picked]);

    // The highlight always sits on a visible row: wherever it was, or the first
    // row once the list changes under it (a new search). Derived, not synced.
    const highlightedId = highlightRaw && orderedIds.includes(highlightRaw) ? highlightRaw : orderedIds[0] ?? null;

    const handleOpen = async (friend: PickerPerson) => {
        if (openingId) return;
        setOpeningId(friend.user_id);
        setOpenError(null);
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
                avatar_url: friend.avatar_url ?? undefined,
            });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setOpeningId(null);
            const status = err?.response?.status;
            setOpenError(
                status === 403
                    ? `You can't message ${friend.username} right now — you need to be friends with each other.`
                    : `Couldn't open your chat with ${friend.username}. Check your connection and try again.`,
            );
        }
    };

    const runPrimary = () => {
        if (openingId || !picked) return;
        void handleOpen(picked);
    };

    const startGroup = () => {
        if (!onStartGroup || openingId) return;
        // Yourself is never part of a group; anyone else picked comes along.
        const who = picked && !picked.isSelf
            ? [{ user_id: picked.user_id, username: picked.username, avatar_url: picked.avatar_url ?? undefined }]
            : [];
        onStartGroup(who);
    };

    const onRowClick = (p: PickerPerson) => {
        if (openingId) return;
        setOpenError(null);
        setHighlightedId(p.user_id);
        // Clicking the picked row again lets go of it.
        setPickedId(prev => (prev === p.user_id ? null : p.user_id));
        inputRef.current?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const intent = pickerKeyIntent(
            { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            { query: search, selectionCount: 0, multiSelect: false },
        );
        if (!intent) return;
        switch (intent.type) {
            case 'move':
                e.preventDefault();
                setHighlightedId(moveHighlight(orderedIds, highlightedId, intent.delta));
                setScrollSignal(n => n + 1);
                return;
            case 'first':
            case 'last':
                e.preventDefault();
                setHighlightedId(intent.type === 'first' ? orderedIds[0] ?? null : orderedIds[orderedIds.length - 1] ?? null);
                setScrollSignal(n => n + 1);
                return;
            case 'open': {
                e.preventDefault();
                const current = highlightedId ? ordered.find(p => p.user_id === highlightedId) ?? null : null;
                if (current) void handleOpen(current);
                return;
            }
            default:
                return;
        }
    };

    const renderAvatar = (p: PickerPerson, fallbackSize = 17) => (
        <EncryptedAvatar attachmentId={p.avatar_url ?? null} userId={p.user_id} token={token} className="w-full h-full" fallbackSize={fallbackSize} disableClickProfile />
    );

    const noFriends = !loading && !loadFailed && friends.length === 0 && !selfRow;
    const noResults = !loading && !loadFailed && !noFriends && ordered.length === 0;
    const openAddFriend = () => setShowAddFriend(true);

    let placeholder: React.ReactNode = null;
    if (loading) placeholder = <PickerSkeleton />;
    else if (loadFailed) placeholder = (
        <PickerEmptyState
            tone="error"
            icon={<WifiOff size={24} />}
            title="Couldn't load your friends"
            body="Check your connection, then try again."
            action={<ClButton variant="ghost" size="sm" onClick={reload}>Try again</ClButton>}
        />
    );
    else if (noFriends) placeholder = (
        <PickerEmptyState
            icon={<Users size={24} />}
            title="No friends yet"
            body="You can message anyone who's accepted your friend request — that's how Cipherline keeps strangers out of your inbox."
        />
    );
    else if (noResults) placeholder = (
        <PickerEmptyState
            icon={<SearchX size={24} />}
            title={<>No friends match “{search.trim()}”</>}
            body="You can only message friends. Check the spelling, or send them a friend request first."
            action={<ClButton variant="ghost" size="sm" onClick={openAddFriend}><UserPlus size={15} />Add a friend</ClButton>}
        />
    );

    // ── footer ──
    // Left: a low-key text link to the group flow (hidden when there is nothing
    // to group with, or the host did not wire it). Right: Cancel + Open chat.
    const groupLink = onStartGroup && !noFriends ? (
        <button type="button" className="dlg-foot-link" onClick={startGroup} disabled={!!openingId}>
            <Users size={14} />Start a group chat
        </button>
    ) : null;

    const primaryButton = noFriends ? (
        <ClButton size="sm" onClick={openAddFriend}><UserPlus size={15} />Add a friend</ClButton>
    ) : (
        <ClButton
            size="sm"
            onClick={runPrimary}
            disabled={!picked}
            loading={!!openingId && openingId === picked?.user_id}
            tooltip={!picked ? 'Pick a friend first' : undefined}
        >
            Open chat
            {picked && <ArrowRight size={15} strokeWidth={2.6} />}
        </ClButton>
    );

    const activeDescendant = !placeholder && highlightedId && orderedIds.includes(highlightedId) ? optionId(highlightedId) : undefined;

    return (
        <>
            <ClModal
                open={!closing}
                onClose={handleClose}
                width={480}
                label="New message"
                cardClassName="dlg-card"
            >
                <DialogHeader
                    icon={<MessageSquarePlus size={19} strokeWidth={2.2} />}
                    title="New message"
                    subtitle="Pick a friend to message."
                />
                <DialogBody>
                    <PeopleSearchField
                        ref={inputRef}
                        autoFocus
                        query={search}
                        onQueryChange={(v) => updateSearch(v)}
                        onKeyDown={onKeyDown}
                        placeholder="Search friends"
                        ariaLabel="Search friends"
                        listboxId={listboxId}
                        activeDescendant={activeDescendant}
                        describedBy={hintId}
                        disabled={false}
                    />
                    <span id={hintId} className="sr-only">
                        Up and down arrows move through your friends. Enter opens a chat with the highlighted friend.
                    </span>
                    {egg && <div className="text-[12px] font-bold text-cl-lume mx-1 mt-2">{egg}</div>}

                    <PeopleListbox
                        id={listboxId}
                        label="Friends"
                        sections={sections}
                        highlightedId={highlightedId}
                        scrollSignal={scrollSignal}
                        selectedIds={selectedSet}
                        multiSelect={false}
                        optionId={optionId}
                        renderAvatar={(p) => renderAvatar(p)}
                        onHighlight={setHighlightedId}
                        onRowClick={onRowClick}
                        onRowAction={(p) => void handleOpen(p)}
                        rowActionLabel={(p) => (p.isSelf ? (hasSelfChat ? 'Open' : 'Start') : p.hasChat ? 'Open chat' : 'Start chat')}
                        showRowAction={!picked}
                        busyId={openingId}
                        disabled={!!openingId}
                        now={now}
                        placeholder={placeholder}
                    />
                </DialogBody>
                {openError && <DialogError>{openError}</DialogError>}
                <DialogFooter hint={groupLink}>
                    <ClButton variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                    {primaryButton}
                </DialogFooter>
            </ClModal>
            {showAddFriend && (
                <AddFriendModal
                    onClose={() => {
                        setShowAddFriend(false);
                        // A request only becomes a friend once accepted — but the
                        // other side may already have sent one, so refresh.
                        // Silent refresh (no skeleton flash): the list stays as it is
                        // unless someone new turns out to be an accepted friend.
                        setReloadKey(k => k + 1);
                        inputRef.current?.focus();
                    }}
                />
            )}
        </>
    );
};
