/**
 * RoleMembersEditor — "Manage Members" sub-tab of the role editor.
 *
 * Two sections:
 *   • "Members with this role" — everyone currently holding the role, with a
 *     × remove button on each row.
 *   • "Add members" — search bar + checkbox list of the rest of the server.
 *     Select any number and click "Add N Members" to bulk-assign.
 *
 * API surface:
 *   GET    /v1/servers/:sid/members                        → full member list
 *   PUT    /v1/servers/:sid/members/:uid/roles/:rid        → assign role
 *   DELETE /v1/servers/:sid/members/:uid/roles/:rid        → unassign role
 *
 * The @everyone role is special — membership cannot be managed manually
 * (the server assigns it automatically), so we show an explanatory banner
 * instead of the normal UI.
 *
 * SCROLL STABILITY — do not undo this without reading `roleMemberState.ts`.
 * Mutating role membership makes the server broadcast
 * `server:permissions_changed` to every member INCLUDING the actor, which
 * re-renders this component's whole ancestor chain. Two rules keep that from
 * throwing the user back to the top of the settings pane:
 *
 *   1. The fetch effect must depend ONLY on what identifies the request
 *      (`serverId`, `token`). `onError` is held in a ref instead of being a
 *      dependency — as a prop it is an inline closure recreated on every
 *      ancestor render, so depending on it refetched on every unrelated
 *      re-render.
 *   2. The spinner is for the FIRST load only. Once there is a list on
 *      screen, a refresh reconciles into it (`reconcileMembers`) and never
 *      unmounts it. Replacing a tall list with a 20px spinner collapses the
 *      scroll container and the browser clamps `scrollTop` to the top.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { UserPlus, X, Check, Shield, Search } from 'lucide-react';
import { API_BASE } from '../../../constants';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import type { Role } from './types';
import { ClButton, ClSearch } from '../../cl';
import {
    type ServerMember,
    reconcileMembers,
    assignRoleLocally,
    unassignRoleLocally,
    partitionByRole,
    pruneSelection,
} from './roleMemberState';

/** The only part of a rejected axios call this file ever reads. */
type ApiError = { response?: { data?: { message?: string } } };

interface Props {
    role: Role;
    serverId: string;
    token: string | null;
    /** True when the caller lacks MANAGE_ROLES — hides all mutative controls. */
    readOnly?: boolean;
    onError?: (msg: string) => void;
}

export const RoleMembersEditor: React.FC<Props> = ({
    role, serverId, token, readOnly, onError,
}) => {
    const [members, setMembers]   = useState<ServerMember[]>([]);
    const [loading, setLoading]   = useState(true);
    const [saving, setSaving]     = useState(false);
    const [removing, setRemoving] = useState<string | null>(null); // user_id being removed
    const [search, setSearch]     = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // See the header note (rule 1): `onError` is an inline closure from an
    // ancestor, so it changes identity on every unrelated re-render. Holding it
    // in a ref keeps it out of `load`'s dependency list while still always
    // calling the latest one.
    const onErrorRef = useRef(onError);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);

    // Guards the initial spinner (rule 2). Once a list has arrived, later
    // fetches refresh it in place instead of tearing it down.
    const hasLoadedRef = useRef(false);

    const load = useCallback(async () => {
        if (!token) { setLoading(false); return; }
        if (!hasLoadedRef.current) setLoading(true);
        try {
            const res = await axios.get(`${API_BASE}/servers/${serverId}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const incoming: ServerMember[] = res.data ?? [];
            // Merge rather than replace — `reconcileMembers` returns the
            // previous array unchanged when nothing moved, so an echo refresh
            // after our own mutation renders nothing at all.
            setMembers(prev => reconcileMembers(prev, incoming));
            hasLoadedRef.current = true;
        } catch (e: any) {
            onErrorRef.current?.(e?.response?.data?.message ?? 'Failed to load members');
        } finally {
            setLoading(false);
        }
    }, [serverId, token]);

    useEffect(() => { load(); }, [load]);

    // Reset selection and search when switching to a different role.
    useEffect(() => { setSelected(new Set()); setSearch(''); }, [role.role_id]);

    const { withRole, withoutRole } = useMemo(
        () => partitionByRole(members, role.role_id, search),
        [members, role.role_id, search],
    );

    const toggleSelect = (userId: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(userId)) next.delete(userId);
            else next.add(userId);
            return next;
        });
    };

    const selectAll = () => {
        setSelected(new Set(withoutRole.map(m => m.user_id)));
    };

    const clearSelection = () => setSelected(new Set());

    /**
     * Optimistic removal: the row leaves "Members with this role" immediately,
     * and comes BACK if the server refuses. Reverting via the exact inverse
     * (`assignRoleLocally`) rather than a refetch is what keeps the surrounding
     * scroll position intact on the error path too.
     */
    const removeFromRole = async (userId: string) => {
        if (!token || readOnly || removing) return;
        setRemoving(userId);
        setMembers(prev => unassignRoleLocally(prev, [userId], role.role_id));
        try {
            await axios.delete(
                `${API_BASE}/servers/${serverId}/members/${userId}/roles/${role.role_id}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
        } catch (e: any) {
            // Put it back where it was and say so — never leave the list
            // disagreeing with the server in silence.
            setMembers(prev => assignRoleLocally(prev, [userId], role.role_id));
            onErrorRef.current?.(e?.response?.data?.message ?? 'Failed to remove role');
        } finally {
            setRemoving(null);
        }
    };

    /**
     * Optimistic bulk assign. Each member is a SEPARATE request, so the result
     * is per-member and the UI has to be too: `Promise.allSettled` (not
     * `Promise.all`) means one rejection no longer discards the outcome of the
     * requests that succeeded. Members who landed keep the role and leave the
     * selection; members who failed are reverted, stay selected so the retry is
     * one click, and are named in the error.
     */
    const addSelected = async () => {
        if (!token || readOnly || selected.size === 0 || saving) return;
        const targets = Array.from(selected);
        setSaving(true);
        setMembers(prev => assignRoleLocally(prev, targets, role.role_id));

        try {
            const results = await Promise.allSettled(
                targets.map(uid =>
                    axios.put(
                        `${API_BASE}/servers/${serverId}/members/${uid}/roles/${role.role_id}`,
                        {},
                        { headers: { Authorization: `Bearer ${token}` } },
                    ),
                ),
            );

            const failed: string[] = [];
            let firstError: string | undefined;
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    failed.push(targets[i]);
                    firstError = firstError
                        ?? (r.reason as ApiError)?.response?.data?.message
                        ?? undefined;
                }
            });

            if (failed.length > 0) {
                setMembers(prev => unassignRoleLocally(prev, failed, role.role_id));
            }
            // Clear only the members that actually got the role; a failed one
            // stays ticked so the footer still offers "Add N Members" for the
            // retry.
            const failedSet = new Set(failed);
            setSelected(prev => pruneSelection(prev, targets.filter(uid => !failedSet.has(uid))));
            if (failed.length === 0) setSearch('');

            if (failed.length > 0) {
                const base = firstError ?? 'Failed to assign role';
                onErrorRef.current?.(
                    failed.length === targets.length
                        ? base
                        : `${base} — ${failed.length} of ${targets.length} member${targets.length !== 1 ? 's' : ''} could not be added.`,
                );
            }
        } catch (e) {
            // `Promise.allSettled` never rejects, so reaching here means
            // something threw before the requests were dispatched. Roll the
            // whole optimistic batch back rather than leaving the list claiming
            // a change that was never sent.
            setMembers(prev => unassignRoleLocally(prev, targets, role.role_id));
            onErrorRef.current?.((e as ApiError)?.response?.data?.message ?? 'Failed to assign role');
        } finally {
            // Must be a finally: a stuck `saving` permanently disables the
            // "Add N Members" button with no way back short of reopening.
            setSaving(false);
        }
    };

    // ── Special case: @everyone ────────────────────────────────────────────
    if (role.is_everyone) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
                <Shield size={36} className="text-cl-faint" />
                <p className="text-[14px] text-cl-muted font-medium">All members have @everyone</p>
                <p className="text-[12px] text-cl-faint max-w-xs leading-relaxed">
                    The default role is automatically assigned to every member. Its membership cannot be managed manually.
                </p>
            </div>
        );
    }

    // ── Loading spinner ────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex justify-center py-12">
                <div className="w-5 h-5 border-2 border-white/20 border-t-cl-lume rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-8">

            {/* ── Section 1: Current members ───────────────────────────── */}
            <section>
                <h3 className="text-[12px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-3">
                    Members with this role — {withRole.length}
                </h3>

                {withRole.length === 0 ? (
                    <div className="rounded-xl border border-cl-border/40 bg-white/[0.02] px-4 py-8 text-center text-cl-faint text-[13px]">
                        No members have this role yet.
                    </div>
                ) : (
                    <div className="rounded-xl border border-cl-border/40 bg-white/[0.02] divide-y divide-white/[0.04] max-h-72 overflow-y-auto custom-scrollbar">
                        {withRole.map(m => (
                            <MemberRow
                                key={m.user_id}
                                member={m}
                                token={token}
                                trailing={
                                    !readOnly ? (
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => removeFromRole(m.user_id)}
                                            disabled={removing === m.user_id}
                                            loading={removing === m.user_id}
                                            tooltip="Remove this role"
                                        >
                                            <X size={14} />
                                        </ClButton>
                                    ) : null
                                }
                            />
                        ))}
                    </div>
                )}
            </section>

            {/* ── Section 2: Add members ───────────────────────────────── */}
            {!readOnly && (
                <section>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-[12px] font-mono font-semibold uppercase tracking-widest text-cl-faint">
                            Add Members
                        </h3>
                        {/* Select all / clear shortcuts */}
                        {withoutRole.length > 0 && (
                            <div className="flex gap-2">
                                {selected.size < withoutRole.length && (
                                    <ClButton size="sm" variant="ghost" onClick={selectAll}>
                                        Select all
                                    </ClButton>
                                )}
                                {selected.size > 0 && (
                                    <ClButton size="sm" variant="ghost" onClick={clearSelection}>
                                        Clear
                                    </ClButton>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Search bar */}
                    <div className="mb-3">
                        <ClSearch
                            icon={<Search size={14} />}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search members…"
                        />
                    </div>

                    {/* Checkbox list */}
                    <div className="rounded-xl border border-cl-border/40 bg-white/[0.02] divide-y divide-white/[0.04] max-h-72 overflow-y-auto custom-scrollbar">
                        {withoutRole.length === 0 ? (
                            <div className="px-4 py-8 text-center text-cl-faint text-[13px]">
                                {search.trim()
                                    ? 'No members match that search.'
                                    : 'All members already have this role.'}
                            </div>
                        ) : (
                            withoutRole.map(m => {
                                const checked = selected.has(m.user_id);
                                return (
                                    <MemberRow
                                        key={m.user_id}
                                        member={m}
                                        token={token}
                                        onClick={() => toggleSelect(m.user_id)}
                                        leading={
                                            <span
                                                className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition-all ${
                                                    checked
                                                        ? 'bg-cl-lume border-cl-lume'
                                                        : 'border-white/25 bg-transparent'
                                                }`}
                                            >
                                                {checked && <Check size={11} strokeWidth={3} className="text-cl-text" />}
                                            </span>
                                        }
                                    />
                                );
                            })
                        )}
                    </div>

                    {/* Sticky footer — appears only when members are selected */}
                    {selected.size > 0 && (
                        <div className="mt-4 px-4 py-3 bg-cl-deep border border-cl-border/50 rounded-xl flex items-center justify-between shadow-lg">
                            <span className="text-[13px] text-cl-muted">
                                {selected.size} member{selected.size !== 1 ? 's' : ''} selected
                            </span>
                            <ClButton
                                onClick={addSelected}
                                disabled={saving}
                                loading={saving}
                            >
                                <UserPlus size={14} />
                                {`Add ${selected.size} Member${selected.size !== 1 ? 's' : ''}`}
                            </ClButton>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
};

// ── Shared member row ────────────────────────────────────────────────────────

interface MemberRowProps {
    member: ServerMember;
    token: string | null;
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    onClick?: () => void;
}

const MemberRow: React.FC<MemberRowProps> = ({ member, token, leading, trailing, onClick }) => {
    const displayName = member.nickname ?? member.username;

    return (
        <div
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onClick={onClick}
            onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
            className={`flex items-center gap-3 px-4 py-2.5 transition-colors select-none ${
                onClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''
            }`}
        >
            {leading && <div className="shrink-0">{leading}</div>}

            {/* Avatar */}
            <EncryptedAvatar
                attachmentId={member.avatar_url}
                token={token}
                userId={member.user_id}
                bypassFriendGate
                disableClickProfile
                fallbackSize={16}
                className="w-8 h-8 shrink-0"
            />

            {/* Name */}
            <div className="flex-1 min-w-0">
                <span className="block text-[14px] font-medium text-cl-text truncate leading-snug">
                    {displayName}
                </span>
                {member.nickname && (
                    <span className="block text-[12px] text-cl-faint truncate leading-snug">
                        @{member.username}#{String(member.discriminator).padStart(4, '0')}
                    </span>
                )}
            </div>

            {trailing && <div className="shrink-0">{trailing}</div>}
        </div>
    );
};
