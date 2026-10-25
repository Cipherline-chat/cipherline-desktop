import React, { useEffect, useRef } from 'react';
import { ArrowRight, Loader2, Search, X } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { StatusIcon } from '../StatusIcon';
import { formatShortAgo, type PickerPerson, type PickerSection } from '../../utils/peoplePicker';
import '../../styles/people-picker.css';

/**
 * People picker — the presentational half (rules live in utils/peoplePicker.ts).
 *
 * A search field that holds the selection as chips, and a sectioned listbox of
 * people with avatar + presence, name + #tag, a status line, last activity, a
 * hover action and a selection box. First adopter: the New Message dialog
 * (StartDMModal). Built so CreateGroupModal / AddGroupMembersPicker /
 * AddToGroupModal can move onto it without changing their data flow.
 *
 * Accessibility model — the WAI-ARIA combobox-with-listbox pattern: focus stays
 * in the search input, the input owns the list via `aria-controls` and points
 * at the highlighted row with `aria-activedescendant`, rows are `role=option`
 * with `aria-selected`. Rows never take focus (mouse-down is prevented on them
 * so a click does not steal it from the input), which is why the hover action
 * and chip remove buttons are tabIndex -1: their keyboard equivalents are
 * Enter and Backspace (see pickerKeyIntent).
 *
 * Outside `components/cl/` on purpose: the website imports that folder, and
 * this is app UI, not a brand primitive.
 */

// ── Search field with chips ───────────────────────────────────────────────

export interface PickerChip {
    id: string;
    label: string;
    avatar?: React.ReactNode;
}

export const PeopleSearchField = React.forwardRef<HTMLInputElement, {
    query: string;
    onQueryChange: (value: string, e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    chips?: readonly PickerChip[];
    onRemoveChip?: (id: string) => void;
    placeholder: string;
    /** Placeholder once at least one chip is in the field. */
    placeholderWithChips?: string;
    ariaLabel: string;
    listboxId: string;
    activeDescendant?: string;
    describedBy?: string;
    disabled?: boolean;
    autoFocus?: boolean;
}>(({
    query, onQueryChange, onKeyDown, chips = [], onRemoveChip, placeholder, placeholderWithChips,
    ariaLabel, listboxId, activeDescendant, describedBy, disabled, autoFocus,
}, ref) => {
    const localRef = useRef<HTMLInputElement | null>(null);
    const setRef = (el: HTMLInputElement | null) => {
        localRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
    };
    return (
        <div
            className={['pp-field', chips.length ? 'pp-field--chips' : '', query ? 'pp-field--query' : ''].filter(Boolean).join(' ')}
            onMouseDown={(e) => {
                // Clicking the field's padding (or a chip) focuses the input instead.
                if (e.target !== localRef.current) { e.preventDefault(); localRef.current?.focus(); }
            }}
        >
            <Search size={16} className="pp-field-icon" aria-hidden="true" />
            {chips.map(c => (
                <span key={c.id} className="pp-chip">
                    {c.avatar && <span className="pp-chip-av" aria-hidden="true">{c.avatar}</span>}
                    <span className="pp-chip-label">{c.label}</span>
                    {onRemoveChip && (
                        <button
                            type="button"
                            tabIndex={-1}
                            className="pp-chip-x"
                            aria-label={`Remove ${c.label}`}
                            onClick={() => { onRemoveChip(c.id); localRef.current?.focus(); }}
                        >
                            <X size={12} strokeWidth={2.6} />
                        </button>
                    )}
                </span>
            ))}
            <input
                ref={setRef}
                className="pp-field-input"
                type="text"
                value={query}
                onChange={(e) => onQueryChange(e.target.value, e)}
                onKeyDown={onKeyDown}
                placeholder={chips.length && placeholderWithChips ? placeholderWithChips : placeholder}
                disabled={disabled}
                autoFocus={autoFocus}
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-label={ariaLabel}
                aria-expanded="true"
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeDescendant}
                aria-describedby={describedBy}
            />
            {query && (
                <button
                    type="button"
                    tabIndex={-1}
                    className="pp-field-clear"
                    aria-label="Clear search"
                    onClick={(e) => { onQueryChange('', e as unknown as React.ChangeEvent<HTMLInputElement>); localRef.current?.focus(); }}
                >
                    <X size={14} strokeWidth={2.4} />
                </button>
            )}
        </div>
    );
});
PeopleSearchField.displayName = 'PeopleSearchField';

// ── Rows ──────────────────────────────────────────────────────────────────

const CHECK = 'M2.5 7.5 L5.5 10.5 L11.5 3.5';

export const PersonRow: React.FC<{
    person: PickerPerson;
    optionId: string;
    avatar: React.ReactNode;
    highlighted: boolean;
    selected: boolean;
    /** Show the selection box (multi-select pickers; never on the self row). */
    selectable: boolean;
    /** The trailing action ("Open chat" / "Start chat"), shown on the highlighted row. */
    actionLabel?: string;
    showAction: boolean;
    busy: boolean;
    disabled: boolean;
    now: number;
    /** No presence data to show (a picker with no live statuses): name + tag only. */
    plain?: boolean;
    onHighlight: () => void;
    onClick: () => void;
    onAction?: () => void;
}> = ({ person, optionId, avatar, highlighted, selected, selectable, actionLabel, showAction, busy, disabled, now, plain, onHighlight, onClick, onAction }) => {
    const ago = formatShortAgo(person.lastActivityAt, now);
    const actionVisible = (showAction && highlighted && !!onAction) || busy;
    return (
        <div
            id={optionId}
            role="option"
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            className={[
                'pp-row',
                highlighted ? 'is-active' : '',
                selected ? 'is-selected' : '',
                person.status === 'offline' && !person.isSelf && !plain ? 'is-offline' : '',
                plain ? 'pp-row--plain' : '',
                disabled ? 'is-disabled' : '',
            ].filter(Boolean).join(' ')}
            onMouseMove={highlighted ? undefined : onHighlight}
            onMouseDown={(e) => e.preventDefault()}
            onClick={disabled ? undefined : onClick}
            data-user-id={person.user_id}
        >
            <span className="pp-av">
                <span className="pp-av-img">{avatar}</span>
                {!person.isSelf && !plain && (
                    <span className={['pp-presence', person.currentGame ? 'pp-presence--game' : ''].filter(Boolean).join(' ')} aria-hidden="true">
                        <StatusIcon status={person.status} currentGame={person.currentGame} onMobile={person.onMobile} size={10} />
                    </span>
                )}
            </span>
            <span className="pp-text">
                <span className="pp-name-line">
                    <span className="pp-name">{person.username}</span>
                    {person.isSelf
                        ? <span className="pp-you">You</span>
                        : person.discriminator !== null && person.discriminator !== undefined && (
                            <span className="pp-tag">#{padDiscriminator(person.discriminator)}</span>
                        )}
                </span>
                {!plain && <span className={['pp-sub', `pp-sub--${person.status}`].join(' ')}>{person.secondary}</span>}
            </span>
            {/* Screen-reader-only facts the visual design carries in other ways. */}
            {!plain && <span className="sr-only">{person.hasChat ? ', existing chat' : ', no chat yet'}</span>}
            <span className="pp-end">
                {actionVisible ? (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        className="pp-action"
                        disabled={disabled && !busy}
                        onClick={(e) => { e.stopPropagation(); if (!disabled) onAction?.(); }}
                    >
                        {busy ? <Loader2 size={13} className="pp-spin" /> : <>{actionLabel}<ArrowRight size={13} strokeWidth={2.6} /></>}
                    </button>
                ) : ago ? (
                    <span className="pp-ago" title={new Date(person.lastActivityAt!).toLocaleString()}>{ago}</span>
                ) : null}
                {selectable && (
                    <span className={['pp-check', selected ? 'on' : ''].filter(Boolean).join(' ')} aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 14 14"><path d={CHECK} /></svg>
                    </span>
                )}
            </span>
        </div>
    );
};

// ── Sectioned listbox ─────────────────────────────────────────────────────

export const PeopleListbox: React.FC<{
    id: string;
    label: string;
    sections: readonly PickerSection[];
    highlightedId: string | null;
    /** Bumped by the host whenever the highlight moved by KEYBOARD — scrolls it into view. */
    scrollSignal: number;
    selectedIds: ReadonlySet<string>;
    multiSelect: boolean;
    optionId: (userId: string) => string;
    renderAvatar: (person: PickerPerson) => React.ReactNode;
    onHighlight: (userId: string) => void;
    onRowClick: (person: PickerPerson) => void;
    onRowAction?: (person: PickerPerson) => void;
    rowActionLabel?: (person: PickerPerson) => string;
    /** Hide the hover action (e.g. while a selection is being built). */
    showRowAction: boolean;
    busyId?: string | null;
    disabled?: boolean;
    now: number;
    /** Rendered instead of rows when there are none (loading / empty / error). */
    placeholder?: React.ReactNode;
    /** Rows without presence / status line (no live statuses available). */
    plain?: boolean;
    /** Extra class on the scroll container, e.g. `pp-list--compact` for a shorter list. */
    listClassName?: string;
}> = ({
    id, label, sections, highlightedId, scrollSignal, selectedIds, multiSelect, optionId, renderAvatar,
    onHighlight, onRowClick, onRowAction, rowActionLabel, showRowAction, busyId, disabled, now, placeholder, plain, listClassName,
}) => {
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!highlightedId || !scrollSignal) return;
        const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-user-id]') ?? [])
            .find(n => n.dataset.userId === highlightedId);
        el?.scrollIntoView?.({ block: 'nearest' });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only keyboard moves scroll; the id is read at that moment
    }, [scrollSignal]);
    const showSectionHeads = sections.length > 1 || (sections[0] && sections[0].key !== 'results');
    return (
        <div ref={listRef} className={['pp-list custom-scrollbar', listClassName ?? ''].filter(Boolean).join(' ')}>
            {placeholder}
            <div
                id={id}
                role="listbox"
                aria-label={label}
                aria-multiselectable={multiSelect || undefined}
                hidden={!!placeholder}
            >
            {sections.map(s => {
                const headId = `${id}-h-${s.key}`;
                return (
                    <div key={s.key} role="group" aria-labelledby={showSectionHeads ? headId : undefined} aria-label={showSectionHeads ? undefined : s.label} className="pp-section">
                        {showSectionHeads && (
                            <div className="pp-section-head" id={headId}>
                                <span>{s.label}</span>
                                <span className="pp-section-count">{s.people.length}</span>
                            </div>
                        )}
                        {s.people.map(p => (
                            <PersonRow
                                key={p.user_id}
                                person={p}
                                optionId={optionId(p.user_id)}
                                avatar={renderAvatar(p)}
                                highlighted={highlightedId === p.user_id}
                                selected={selectedIds.has(p.user_id)}
                                selectable={multiSelect && !p.isSelf}
                                actionLabel={rowActionLabel?.(p)}
                                showAction={showRowAction}
                                busy={busyId === p.user_id}
                                disabled={!!disabled}
                                now={now}
                                plain={plain}
                                onHighlight={() => onHighlight(p.user_id)}
                                onClick={() => onRowClick(p)}
                                onAction={onRowAction ? () => onRowAction(p) : undefined}
                            />
                        ))}
                    </div>
                );
            })}
            </div>
        </div>
    );
};

// ── Placeholders ──────────────────────────────────────────────────────────

/** Centered empty / error state for the list area (keeps the list's fixed height). */
export const PickerEmptyState: React.FC<{
    icon: React.ReactNode;
    title: React.ReactNode;
    body?: React.ReactNode;
    action?: React.ReactNode;
    tone?: 'default' | 'error';
}> = ({ icon, title, body, action, tone = 'default' }) => (
    <div className={['pp-empty', tone === 'error' ? 'pp-empty--error' : ''].filter(Boolean).join(' ')}>
        <div className="pp-empty-icon" aria-hidden="true">{icon}</div>
        <div className="pp-empty-title" role="status">{title}</div>
        {body && <div className="pp-empty-body">{body}</div>}
        {action && <div className="pp-empty-action">{action}</div>}
    </div>
);

/** Skeleton rows while the people load — kit rule: content loads as skeletons, not spinners. */
export const PickerSkeleton: React.FC<{ rows?: number }> = ({ rows = 6 }) => (
    <div className="pp-skeleton" aria-hidden="true">
        <div className="pp-section-head"><span className="pp-sk pp-sk--head" /></div>
        {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="pp-sk-row">
                <span className="pp-sk pp-sk--av" />
                <span className="pp-sk-lines">
                    <span className="pp-sk pp-sk--ln" style={{ width: 96 + ((i * 37) % 70) }} />
                    <span className="pp-sk pp-sk--ln pp-sk--ln2" style={{ width: 60 + ((i * 23) % 50) }} />
                </span>
            </div>
        ))}
    </div>
);
