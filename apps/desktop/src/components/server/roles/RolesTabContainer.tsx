/**
 * RolesTabContainer — owns the roles list and orchestrates the two-pane
 * layout (RoleListPane on the left, RoleEditorPane on the right).
 *
 * REST surface:
 *   GET    /v1/servers/:sid/roles
 *   POST   /v1/servers/:sid/roles
 *   PATCH  /v1/servers/:sid/roles/:rid       (used by both editors via callbacks)
 *   DELETE /v1/servers/:sid/roles/:rid
 *
 * Permission: requires MANAGE_ROLES (or ADMINISTRATOR / owner) to mutate;
 * read-only fallback for users without it. The `canManage` flag flows down
 * to both panes. Owners are detected at the modal level — for now any caller
 * that can fetch the roles list is treated as read-only-by-default, and the
 * server enforces the actual permission on PATCH/DELETE/POST.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Shield } from 'lucide-react';
import { API_BASE } from '../../../constants';
import type { ServerInfo } from '../../../hooks/useServers';
import type { Role } from './types';
import { RoleListPane } from './RoleListPane';
import { RoleEditorPane } from './RoleEditorPane';
import { sortRolesForDisplay } from './roleOrder';
import { useToast } from '../../../contexts/ToastContext';
import { ConfirmDialog } from '../../primitives/ConfirmDialog';
import type { ConfirmOptions } from '../../primitives/ConfirmDialog';
import { useReportDirty } from '../../../hooks/useUnsavedChangesGuard';

interface Props {
    server: ServerInfo;
    token: string | null;
    /** Owner / MANAGE_ROLES holder. Server still validates on each PATCH. */
    canManage: boolean;
    /** Lets the shell guard close / tab-switch while a role has unsaved permission edits. */
    onDirtyChange?: (dirty: boolean) => void;
}

export const RolesTabContainer: React.FC<Props> = ({ server, token, canManage, onDirtyChange }) => {
    const [roles, setRoles] = useState<Role[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
    const toast = useToast();
    // `push` is useCallback-stable inside ToastProvider; the context VALUE
    // object is not, so destructure it and depend on the function. `reportError`
    // is then referentially stable for the lifetime of this component, which
    // matters: it is passed down as `onError` and a child that keys a fetch
    // effect off it would otherwise refetch on every unrelated re-render of
    // this container. See RoleMembersEditor's header note.
    const { push: pushToast } = toast;
    const reportError = useCallback(
        (message: string) => pushToast({ kind: 'error', message }),
        [pushToast],
    );
    const [isDirty, setIsDirty] = useState(false);
    useReportDirty(isDirty, onDirtyChange);
    const [confirmPending, setConfirmPending] = useState<ConfirmOptions | null>(null);

    const askDirtyGuard = useCallback((action: () => void) => {
        if (!isDirty) { action(); return; }
        setConfirmPending({
            title: 'Unsaved Changes',
            message: 'You have unsaved changes that will be lost. Leave anyway?',
            confirmLabel: 'Leave',
            onConfirm: () => {
                setIsDirty(false);
                action();
            },
        });
    }, [isDirty]);

    const load = useCallback(async () => {
        if (!token) { setLoading(false); return; }
        try {
            const res = await axios.get(`${API_BASE}/servers/${server.server_id}/roles`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const list: Role[] = sortRolesForDisplay((res.data ?? []) as Role[]);
            setRoles(list);
            setSelectedRoleId(prev => {
                if (prev && list.some(r => r.role_id === prev)) return prev;
                const first = list.find(r => !r.is_everyone) ?? list[0] ?? null;
                return first?.role_id ?? null;
            });
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to load roles' });
        } finally { setLoading(false); }
    }, [server.server_id, token]);

    useEffect(() => { load(); }, [load]);

    const createRole = useCallback(async (name: string) => {
        if (!token) return;
        askDirtyGuard(async () => {
            try {
                const res = await axios.post(
                    `${API_BASE}/servers/${server.server_id}/roles`,
                    { name },
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                const created = res.data as Role | undefined;
                await load();
                if (created?.role_id) setSelectedRoleId(created.role_id);
            } catch (e: any) {
                toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to create role' });
            }
        });
    }, [server.server_id, token, load, askDirtyGuard]);

    const handleSaved = useCallback((next: Role) => {
        setRoles(prev => prev.map(r => r.role_id === next.role_id ? next : r));
    }, []);

    const handleReorder = useCallback(async (roleId: string, newPosition: number) => {
        if (!token) return;
        if (!canManage) {
            toast.push({ kind: 'error', message: 'You no longer have permission to manage roles in this server.' });
            throw new Error('no-permission');
        }
        try {
            await axios.patch(
                `${API_BASE}/servers/${server.server_id}/roles/${roleId}`,
                { position: newPosition },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setRoles(prev => prev.map(r => r.role_id === roleId ? { ...r, position: newPosition } : r));
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to reorder role' });
            throw e;
        }
    }, [server.server_id, token, canManage]);

    const handleDelete = useCallback(() => {
        if (!token || !selectedRoleId) return;
        if (!canManage) {
            toast.push({ kind: 'error', message: 'You no longer have permission to manage roles in this server.' });
            return;
        }
        const target = roles.find(r => r.role_id === selectedRoleId);
        if (!target || target.is_everyone) return;
        setConfirmPending({
            title: `Delete "${target.name}"?`,
            message: 'This role will be permanently removed and unassigned from all members.',
            confirmLabel: 'Delete Role',
            onConfirm: async () => {
                try {
                    await axios.delete(`${API_BASE}/servers/${server.server_id}/roles/${selectedRoleId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    setRoles(prev => prev.filter(r => r.role_id !== selectedRoleId));
                    const remaining = roles.filter(r => r.role_id !== selectedRoleId);
                    const next = remaining.find(r => !r.is_everyone) ?? remaining[0] ?? null;
                    setSelectedRoleId(next?.role_id ?? null);
                } catch (e: any) {
                    toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to delete role' });
                }
            },
        });
    }, [server.server_id, token, selectedRoleId, roles, canManage]);

    const everyonePerms = useMemo<bigint>(() => {
        const everyone = roles.find(r => r.is_everyone);
        try { return everyone ? BigInt(everyone.permissions) : 0n; } catch { return 0n; }
    }, [roles]);

    if (loading) {
        return (
            <div className="flex justify-center py-12">
                <div className="w-5 h-5 border-2 border-white/20 border-t-cl-lume rounded-full animate-spin" />
            </div>
        );
    }

    const selected = roles.find(r => r.role_id === selectedRoleId) ?? null;

    return (
        <>
            {/* Column layout — a horizontal role RAIL on top, full-width editor
                below. Deliberately NOT the vertical left-sidebar + right-editor
                split that reads as Discord's roles page; this also lets the
                editor use the full width so permission chips wrap instead of
                being clipped.
                Sized container-relative (h-full), not viewport-relative — the
                caller (ServerSettingsModal) gives this component its own
                dedicated bounded flex slot, unpadded and without an
                independent scroll container, so h-full resolves against a
                real, definite height whether the settings shell is windowed
                or full-screen. */}
            <div className="h-full min-h-[420px] flex flex-col border-t border-cl-border/40" style={{ background: 'var(--cl-abyss)' }}>
                <RoleListPane
                    roles={roles}
                    selectedRoleId={selectedRoleId}
                    onSelect={(id) => askDirtyGuard(() => setSelectedRoleId(id))}
                    onCreate={createRole}
                    canManage={canManage}
                    onReorder={handleReorder}
                    onError={reportError}
                />

                {selected ? (
                    <RoleEditorPane
                        role={selected}
                        serverId={server.server_id}
                        token={token}
                        canManage={canManage}
                        onSaved={handleSaved}
                        onDelete={handleDelete}
                        onError={reportError}
                        everyonePerms={everyonePerms}
                        onDirtyChange={setIsDirty}
                    />
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-cl-faint">
                        <Shield size={48} className="mb-4 opacity-50" />
                        <p className="text-[15px]">Select a role to edit it</p>
                        {canManage && <p className="text-[12px] mt-1">Or click "+ New" to create one.</p>}
                    </div>
                )}
            </div>

            {confirmPending && (
                <ConfirmDialog
                    {...confirmPending}
                    onConfirm={() => { confirmPending.onConfirm(); setConfirmPending(null); }}
                    onCancel={() => setConfirmPending(null)}
                />
            )}
        </>
    );
};
