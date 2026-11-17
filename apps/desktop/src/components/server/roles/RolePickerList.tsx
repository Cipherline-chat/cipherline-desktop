/**
 * RolePickerList — the ONE role checklist behind every "change this member's
 * roles" surface: the member-list right-click menu, the chat message
 * right-click menu, and the profile card's "+" button (all via
 * MemberRolePicker).
 *
 * Presentational: it is handed the roles the viewer may toggle (already
 * filtered by rolePickerModel's hierarchy mirror), the ids the member holds,
 * and an onToggle. It owns only the search query and keyboard focus.
 *
 *  - Always scrolls inside its own box (`maxListHeight`), so a server with
 *    dozens of roles never pushes the list off screen.
 *  - Over ROLE_SEARCH_THRESHOLD rows a search box appears (autofocused);
 *    Escape clears a non-empty query before anything else closes.
 *  - ArrowUp/Down / Home / End move between the search box and the rows;
 *    Enter or Space toggles the focused row (native button activation).
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Search, Loader2 } from 'lucide-react';
import { readableRoleColorHex, roleColorHexFromInt } from '../../../utils/roleColor';
import { useEscape } from '../../../hooks/useEscape';
import { filterRolesByQuery, shouldShowRoleSearch, type PickerRole } from './rolePickerModel';
import '../../../styles/role-picker.css';

export interface RolePickerListProps {
    /** Roles the viewer may toggle, in display order (highest first). */
    roles: readonly PickerRole[];
    /** Role ids the member currently holds (optimistic state included). */
    assignedIds: readonly string[];
    onToggle: (roleId: string, nextAssigned: boolean) => void;
    /** Role ids with a request in flight — shown busy, clicks ignored. */
    pendingIds?: ReadonlySet<string>;
    /** Real roles left out because they sit at or above the viewer's highest role. */
    hiddenAbove?: number;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    /** Focus the search box (or the first row when there is none) on mount. */
    autoFocus?: boolean;
    maxListHeight?: number;
    /** Accessible name for the checklist, e.g. "Roles for alice". */
    label?: string;
}

export const RolePickerList: React.FC<RolePickerListProps> = ({
    roles, assignedIds, onToggle, pendingIds, hiddenAbove = 0, loading = false, error = null, onRetry,
    autoFocus = true, maxListHeight = 288, label = 'Roles',
}) => {
    const [query, setQuery] = useState('');
    const rowsId = useId();
    const searchable = shouldShowRoleSearch(roles.length);
    const shown = useMemo(() => (searchable ? filterRolesByQuery(roles, query) : [...roles]), [roles, query, searchable]);
    const assigned = useMemo(() => new Set(assignedIds), [assignedIds]);

    const inputRef = useRef<HTMLInputElement>(null);
    const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const didFocusRef = useRef(false);

    // A layer of its own: Escape empties a typed query first; the host's layer
    // (close the picker) only sees the next press.
    useEscape(() => setQuery(''), query !== '');

    // Focus once, as soon as there is something to focus (the roster may still
    // be loading on mount).
    useEffect(() => {
        if (!autoFocus || didFocusRef.current || loading || error) return;
        if (searchable && inputRef.current) {
            inputRef.current.focus();
            didFocusRef.current = true;
        } else if (rowRefs.current[0]) {
            rowRefs.current[0].focus();
            didFocusRef.current = true;
        }
    }, [autoFocus, loading, error, searchable, shown.length]);

    const focusRow = (i: number) => {
        const n = shown.length;
        if (n === 0) return;
        const idx = Math.max(0, Math.min(n - 1, i));
        rowRefs.current[idx]?.focus();
    };

    const onRowKey = (e: React.KeyboardEvent, i: number) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusRow(i + 1); }
        else if (e.key === 'ArrowUp') {
            e.preventDefault(); e.stopPropagation();
            if (i === 0 && searchable) inputRef.current?.focus(); else focusRow(i - 1);
        }
        else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); focusRow(0); }
        else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); focusRow(shown.length - 1); }
    };

    const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusRow(0); }
        else if (e.key === 'Enter') {
            // Enter in the box toggles the single remaining match — type, Enter, done.
            e.preventDefault();
            if (shown.length === 1 && !pendingIds?.has(shown[0].role_id)) {
                onToggle(shown[0].role_id, !assigned.has(shown[0].role_id));
            }
        }
    };

    if (loading) {
        return (
            <div className="rpk-state" role="status" aria-live="polite">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading roles…
            </div>
        );
    }
    if (error) {
        return (
            <div className="rpk-state rpk-state--error" role="alert">
                <span>{error}</span>
                {onRetry && <button type="button" className="rpk-retry" onClick={onRetry}>Try again</button>}
            </div>
        );
    }
    if (roles.length === 0) {
        return (
            <div className="rpk-state" role="status" data-testid="role-picker-none">
                <span>No roles you can assign.</span>
                {hiddenAbove > 0 && <span className="rpk-hint">You can only change roles below your highest role.</span>}
            </div>
        );
    }

    return (
        <div className="rpk" data-testid="role-picker-list">
            {searchable && (
                <label className="rpk-search">
                    <Search size={12} aria-hidden="true" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={onSearchKey}
                        placeholder={`Search ${roles.length} roles`}
                        aria-label="Search roles"
                        aria-controls={rowsId}
                        spellCheck={false}
                        autoComplete="off"
                        data-testid="role-picker-search"
                    />
                </label>
            )}
            <div
                id={rowsId}
                className="rpk-rows custom-scrollbar"
                role="group"
                aria-label={label}
                style={{ maxHeight: maxListHeight }}
            >
                {shown.length === 0 ? (
                    <div className="rpk-empty" role="status" data-testid="role-picker-empty">
                        No roles match “{query.trim()}”
                    </div>
                ) : shown.map((r, i) => {
                    const on = assigned.has(r.role_id);
                    const busy = !!pendingIds?.has(r.role_id);
                    const hex = readableRoleColorHex(roleColorHexFromInt(r.color));
                    return (
                        <button
                            key={r.role_id}
                            ref={el => { rowRefs.current[i] = el; }}
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            aria-busy={busy || undefined}
                            className={`rpk-row${busy ? ' busy' : ''}`}
                            data-testid="role-picker-row"
                            data-role-id={r.role_id}
                            onClick={() => { if (!busy) onToggle(r.role_id, !on); }}
                            onKeyDown={e => onRowKey(e, i)}
                        >
                            <span className={`ctxm-chk${on ? ' on' : ''}`} aria-hidden="true">
                                {on && <Check size={11} strokeWidth={3} />}
                            </span>
                            <span
                                className="rpk-dot"
                                aria-hidden="true"
                                style={hex ? { backgroundColor: hex, boxShadow: `0 0 6px ${hex}70` } : undefined}
                            />
                            <span className="rpk-name">{r.name}</span>
                            {busy && <Loader2 size={12} className="animate-spin rpk-busy" aria-hidden="true" />}
                        </button>
                    );
                })}
            </div>
            {hiddenAbove > 0 && (
                <p className="rpk-foot">
                    {hiddenAbove === 1 ? '1 role' : `${hiddenAbove} roles`} at or above your highest role not shown
                </p>
            )}
        </div>
    );
};
