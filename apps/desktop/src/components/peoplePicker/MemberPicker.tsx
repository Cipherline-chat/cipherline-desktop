import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { SearchX, Users, WifiOff } from 'lucide-react';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { ClButton } from '../cl';
import { PeopleSearchField, PeopleListbox, PickerEmptyState, PickerSkeleton } from './PeoplePicker';
import {
    toPickerPeople, buildPickerSections, flattenSections, moveHighlight, pickerKeyIntent, toggleSelection,
    type PickerFriend, type PickerPerson, type PickerSection,
} from '../../utils/peoplePicker';

/**
 * Multi-select people picker for dialogs that choose MEMBERS for a group
 * (CreateGroupModal, AddGroupMembersModal): the New Message dialog's search
 * field + chips + listbox, minus the chat-opening parts (no hover "Open chat",
 * no presence — these dialogs only know the friends list).
 *
 * Controlled: the host owns `selection` (ordered user ids) and decides what
 * Enter does once something is selected (`onSubmit`). Keyboard contract is
 * `pickerKeyIntent`'s, with "Enter on nothing selected" meaning "select the
 * highlighted person" rather than "open a chat".
 */
export const MemberPicker: React.FC<{
    /** Everyone the user may pick (already minus anyone who must not be offered). */
    people: readonly PickerFriend[];
    loading: boolean;
    loadFailed?: boolean;
    onRetry?: () => void;
    selection: readonly string[];
    onSelectionChange: (next: readonly string[]) => void;
    /** Most people that can be selected. */
    max: number;
    token: string | null;
    /** Names for selected ids that are not in `people` (e.g. pre-selected before the friends load). */
    knownPeople?: readonly PickerFriend[];
    ariaLabel: string;
    placeholder?: string;
    /** Shown when there is nobody to offer at all. */
    emptyTitle: string;
    emptyBody?: string;
    onSubmit?: () => void;
    autoFocus?: boolean;
    disabled?: boolean;
    /** Shorter list, for dialogs with other fields above the picker. */
    compact?: boolean;
}> = ({
    people, loading, loadFailed, onRetry, selection, onSelectionChange, max, token, knownPeople, ariaLabel,
    placeholder = 'Search friends', emptyTitle, emptyBody, onSubmit, autoFocus, disabled, compact,
}) => {
    const uid = useId();
    const listboxId = `${uid}-members`;
    const hintId = `${uid}-keys`;
    const optionId = useCallback((userId: string) => `${uid}-opt-${userId}`, [uid]);
    const inputRef = useRef<HTMLInputElement>(null);
    const [search, setSearch] = useState('');
    const [highlightRaw, setHighlighted] = useState<string | null>(null);
    const [scrollSignal, setScrollSignal] = useState(0);
    const [now] = useState(() => Date.now());

    const offered = useMemo(() => toPickerPeople({ rows: people, conversations: [] }), [people]);
    const allById = useMemo(() => {
        const m = new Map<string, PickerPerson>();
        for (const p of toPickerPeople({ rows: knownPeople ?? [], conversations: [] })) m.set(p.user_id, p);
        for (const p of offered) m.set(p.user_id, p);
        return m;
    }, [offered, knownPeople]);

    const sections: PickerSection[] = useMemo(() => {
        if (search.trim()) return buildPickerSections(offered, search);
        if (offered.length === 0) return [];
        const sorted = [...offered].sort((a, b) =>
            a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }) || a.user_id.localeCompare(b.user_id));
        return [{ key: 'results', label: 'Friends', people: sorted }];
    }, [offered, search]);
    const ordered = useMemo(() => flattenSections(sections), [sections]);
    const orderedIds = useMemo(() => ordered.map(p => p.user_id), [ordered]);
    const highlightedId = highlightRaw && orderedIds.includes(highlightRaw) ? highlightRaw : orderedIds[0] ?? null;
    const selectedSet = useMemo(() => new Set(selection), [selection]);
    const selectedPeople = useMemo(
        () => selection.map(id => allById.get(id)).filter((p): p is PickerPerson => !!p),
        [selection, allById],
    );

    const toggle = (p: PickerPerson, clearQuery: boolean) => {
        const wasSelected = selectedSet.has(p.user_id);
        onSelectionChange(toggleSelection(selection, p.user_id, max));
        setHighlighted(p.user_id);
        if (clearQuery && !wasSelected && search) setSearch('');
        inputRef.current?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const intent = pickerKeyIntent(
            { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            { query: search, selectionCount: selection.length, multiSelect: true },
        );
        if (!intent) return;
        const current = highlightedId ? allById.get(highlightedId) ?? null : null;
        switch (intent.type) {
            case 'move':
                e.preventDefault();
                setHighlighted(moveHighlight(orderedIds, highlightedId, intent.delta));
                setScrollSignal(n => n + 1);
                return;
            case 'first':
            case 'last':
                e.preventDefault();
                setHighlighted(intent.type === 'first' ? orderedIds[0] ?? null : orderedIds[orderedIds.length - 1] ?? null);
                setScrollSignal(n => n + 1);
                return;
            case 'open':
            case 'toggle':
                if (!current || !orderedIds.includes(current.user_id)) return;
                e.preventDefault();
                toggle(current, intent.type === 'toggle' ? intent.clearQuery : !!search);
                return;
            case 'primary':
                e.preventDefault();
                onSubmit?.();
                return;
            case 'removeLast':
                e.preventDefault();
                onSelectionChange(selection.slice(0, -1));
                return;
        }
    };

    const renderAvatar = (p: PickerPerson, fallbackSize = 17) => (
        <EncryptedAvatar attachmentId={p.avatar_url ?? null} userId={p.user_id} token={token} className="w-full h-full" fallbackSize={fallbackSize} disableClickProfile />
    );

    let placeholderNode: React.ReactNode = null;
    if (loading) placeholderNode = <PickerSkeleton rows={compact ? 4 : 6} />;
    else if (loadFailed) placeholderNode = (
        <PickerEmptyState
            tone="error"
            icon={<WifiOff size={24} />}
            title="Couldn't load your friends"
            body="Check your connection, then try again."
            action={onRetry ? <ClButton variant="ghost" size="sm" onClick={onRetry}>Try again</ClButton> : undefined}
        />
    );
    else if (people.length === 0) placeholderNode = (
        <PickerEmptyState icon={<Users size={24} />} title={emptyTitle} body={emptyBody} />
    );
    else if (ordered.length === 0) placeholderNode = (
        <PickerEmptyState icon={<SearchX size={24} />} title={<>No friends match “{search.trim()}”</>} body="Check the spelling." />
    );

    const activeDescendant = !placeholderNode && highlightedId && orderedIds.includes(highlightedId) ? optionId(highlightedId) : undefined;

    return (
        <>
            <PeopleSearchField
                ref={inputRef}
                autoFocus={autoFocus}
                query={search}
                onQueryChange={(v) => setSearch(v)}
                onKeyDown={onKeyDown}
                chips={selectedPeople.map(p => ({ id: p.user_id, label: p.username, avatar: renderAvatar(p, 11) }))}
                onRemoveChip={(id) => onSelectionChange(selection.filter(x => x !== id))}
                placeholder={placeholder}
                placeholderWithChips="Add more"
                ariaLabel={ariaLabel}
                listboxId={listboxId}
                activeDescendant={activeDescendant}
                describedBy={hintId}
                disabled={disabled}
            />
            <span id={hintId} className="sr-only">
                Up and down arrows move through your friends. Enter or Space with an empty search selects the highlighted person. Backspace removes the last selected person.
            </span>
            <PeopleListbox
                id={listboxId}
                label="Friends"
                sections={sections}
                highlightedId={highlightedId}
                scrollSignal={scrollSignal}
                selectedIds={selectedSet}
                multiSelect
                optionId={optionId}
                renderAvatar={(p) => renderAvatar(p)}
                onHighlight={setHighlighted}
                onRowClick={(p) => { if (!disabled) toggle(p, true); }}
                showRowAction={false}
                disabled={disabled}
                now={now}
                placeholder={placeholderNode}
                plain
                listClassName={compact ? 'pp-list--compact' : undefined}
            />
        </>
    );
};
