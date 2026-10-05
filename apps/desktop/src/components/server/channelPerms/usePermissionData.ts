/**
 * Loads everything a channel / category permission editor needs:
 * roles (in Server Settings order), members (for member overrides, the
 * member preview, and the hierarchy guard), the caller's own server-level
 * permissions, the parent category's overrides (the inherited tier), and —
 * when editing — the target's own saved overrides.
 *
 * Results that depend on an input (the category, the edited target) are
 * stored WITH the input they were loaded for, and read back only while it
 * still matches — so a stale response can never be shown for a new input,
 * and nothing has to be reset synchronously when the input changes.
 */

import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../../../constants';
import type { Role } from '../roles/types';
import { sortRolesForDisplay } from '../roles/roleOrder';
import { overrideFromWire, type PermOverride } from './effectivePermissions';

export interface EditorMember {
    user_id: string;
    name: string;
    role_ids: string[];
    muted_until: string | null;
}

export interface WireOverride {
    target_kind: string;
    target_id: string;
    allow_bits: string;
    deny_bits: string;
}

export interface OwnTarget {
    scope: 'channel' | 'category';
    id: string;
}

interface Opts {
    serverId: string;
    token: string | null;
    /** Parent category whose overrides a channel inherits (null = none). */
    inheritFromCategoryId: string | null;
    /** The saved overrides being edited: a channel's or a category's. */
    own: OwnTarget | null;
    /** Pass the caller's server bits if the parent already has them. */
    myPermissions?: bigint;
}

const auth = (token: string | null) => ({ headers: { Authorization: `Bearer ${token}` } });
const errMsg = (e: unknown, fallback: string) =>
    ((e as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) ?? fallback;
const keyOf = (t: OwnTarget | null) => (t ? `${t.scope}:${t.id}` : '');
/** Stable empty value, so consumers memoising on `ownRows` don't churn. */
const NO_ROWS: WireOverride[] = [];

export function usePermissionData({ serverId, token, inheritFromCategoryId, own, myPermissions }: Opts) {
    const [roles, setRoles] = useState<Role[]>([]);
    const [members, setMembers] = useState<EditorMember[]>([]);
    const [fetchedPerms, setFetchedPerms] = useState<bigint | null>(null);
    const [rolesState, setRolesState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [rolesError, setRolesError] = useState<string | null>(null);
    const [inheritedResult, setInheritedResult] = useState<{ id: string; overrides: PermOverride[]; ok: boolean } | null>(null);
    const [ownResult, setOwnResult] = useState<{ key: string; rows: WireOverride[] | null; error: string | null } | null>(null);
    const [reloadTick, setReloadTick] = useState(0);

    // Roles + members + my permissions — once per server (and on retry).
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        axios.get(`${API_BASE}/servers/${serverId}/roles`, auth(token))
            .then(res => {
                if (cancelled) return;
                setRoles(sortRolesForDisplay((res.data ?? []) as Role[]));
                setRolesState('ready');
            })
            .catch(e => { if (!cancelled) { setRolesState('error'); setRolesError(errMsg(e, 'Couldn’t load roles')); } });
        // Members are an enhancement (member overrides, preview, hierarchy):
        // a failure degrades those features instead of blocking the editor.
        axios.get(`${API_BASE}/servers/${serverId}/members`, auth(token))
            .then(res => {
                if (cancelled) return;
                const rows = (res.data ?? []) as {
                    user_id: string; nickname?: string | null; username?: string | null;
                    role_ids?: string[] | null; muted_until?: string | null;
                }[];
                setMembers(rows.map(m => ({
                    user_id: m.user_id,
                    name: m.nickname || m.username || m.user_id.slice(0, 8),
                    role_ids: m.role_ids ?? [],
                    muted_until: m.muted_until ?? null,
                })));
            })
            .catch(() => { /* degrade */ });
        if (myPermissions === undefined) {
            axios.get(`${API_BASE}/servers/${serverId}/me/permissions`, auth(token))
                .then(res => { if (!cancelled) setFetchedPerms(BigInt(res.data?.permissions ?? '0')); })
                .catch(() => { if (!cancelled) setFetchedPerms(0n); });
        }
        return () => { cancelled = true; };
    }, [serverId, token, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

    // The inherited (category) tier — follows the category picker.
    useEffect(() => {
        if (!token || !inheritFromCategoryId) return;
        let cancelled = false;
        const id = inheritFromCategoryId;
        axios.get(`${API_BASE}/servers/${serverId}/categories/${id}/overrides`, auth(token))
            .then(res => {
                if (!cancelled) setInheritedResult({ id, ok: true, overrides: ((res.data ?? []) as WireOverride[]).map(overrideFromWire) });
            })
            .catch(() => { if (!cancelled) setInheritedResult({ id, ok: false, overrides: [] }); });
        return () => { cancelled = true; };
    }, [serverId, token, inheritFromCategoryId, reloadTick]);

    // The target's own saved overrides (edit mode).
    const ownKey = keyOf(own);
    const ownScope = own?.scope;
    const ownId = own?.id;
    /** Re-read the saved overrides. Pass `target` when the dialog has just
     *  switched targets (a create became an edit) and hasn't re-rendered. */
    const reloadOwn = useCallback(async (target?: OwnTarget): Promise<WireOverride[] | null> => {
        const t = target ?? (ownScope && ownId ? { scope: ownScope, id: ownId } : null);
        if (!token || !t) return [];
        const key = keyOf(t);
        try {
            const path = t.scope === 'channel' ? 'channels' : 'categories';
            const res = await axios.get(`${API_BASE}/servers/${serverId}/${path}/${t.id}/overrides`, auth(token));
            const rows = (res.data ?? []) as WireOverride[];
            setOwnResult({ key, rows, error: null });
            return rows;
        } catch (e) {
            setOwnResult({ key, rows: null, error: errMsg(e, 'Couldn’t load the saved permissions') });
            return null;
        }
    }, [serverId, token, ownScope, ownId]);

    useEffect(() => {
        if (!token || !ownScope || !ownId) return;
        let cancelled = false;
        const key = `${ownScope}:${ownId}`;
        const path = ownScope === 'channel' ? 'channels' : 'categories';
        axios.get(`${API_BASE}/servers/${serverId}/${path}/${ownId}/overrides`, auth(token))
            .then(res => { if (!cancelled) setOwnResult({ key, rows: (res.data ?? []) as WireOverride[], error: null }); })
            .catch(e => { if (!cancelled) setOwnResult({ key, rows: null, error: errMsg(e, 'Couldn’t load the saved permissions') }); });
        return () => { cancelled = true; };
    }, [serverId, token, ownScope, ownId, reloadTick]);

    const retry = useCallback(() => {
        setRolesState('loading');
        setRolesError(null);
        setOwnResult(null);
        setReloadTick(t => t + 1);
    }, []);

    const inheritedCurrent = inheritFromCategoryId && inheritedResult?.id === inheritFromCategoryId ? inheritedResult : null;
    const ownCurrent = ownKey && ownResult?.key === ownKey ? ownResult : null;

    return {
        roles, members,
        myPerms: myPermissions ?? fetchedPerms,
        rolesState, rolesError,
        inherited: inheritedCurrent?.overrides ?? [],
        inheritedState: !inheritFromCategoryId ? 'idle' as const
            : !inheritedCurrent ? 'loading' as const
                : inheritedCurrent.ok ? 'ready' as const : 'error' as const,
        /** null while loading; [] when there is nothing to edit yet (create). */
        ownRows: !ownKey ? NO_ROWS : (ownCurrent?.rows ?? null),
        ownError: ownCurrent?.error ?? null,
        reloadOwn,
        retry,
    };
}
