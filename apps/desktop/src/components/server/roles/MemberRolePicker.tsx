/**
 * The member role picker — toggles one member's server roles. One body
 * (MemberRolePickerBody → RolePickerList), two shells:
 *
 *  - MemberRolesFlyout: the hover flyout beside the member-list and chat
 *    message right-click menus (ContextMenu's `flyout` panel; see
 *    rolesMenuItem.tsx). No header, no close button — it is part of the menu.
 *  - MemberRolePicker: a popover anchored next to the profile card's "+",
 *    opened through RolePickerContext.open.
 *
 * Data comes from the shared roster cache (fetched here if this server's
 * roster is not cached yet). Toggles go through memberRoleMutation, which is
 * optimistic with per-role rollback; a failure surfaces as an error toast
 * carrying the server's reason. Toggling never closes either shell, so
 * several roles can be changed in one go.
 *
 * Only roles strictly below the viewer's highest role are listed (owner: all)
 * — a mirror of RolesService.assignRole / unassignRole's hierarchy check. The
 * API enforces it (and MANAGE_ROLES) regardless of what this shows.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { X } from 'lucide-react';
import { useServerRoster } from '../../../hooks/useServerRoster';
import { useEscape } from '../../../hooks/useEscape';
import { useDismissOnOutsideClick } from '../../../hooks/useDismissOnOutsideClick';
import { refreshRoster } from '../../../utils/serverRosterCache';
import { useToast } from '../../../contexts/ToastContext';
import { useRolePicker, type OpenRolePickerArgs, type RolePickerSession } from '../../../contexts/RolePickerContext';
import { RolePickerList } from './RolePickerList';
import { actorHighestPosition, assignableRoles, flyoutListHeight, hasManageRolesPermission } from './rolePickerModel';
import { roleToggleErrorMessage, setMemberRole, useMemberRoleIds } from './memberRoleMutation';
import '../../../styles/role-picker.css';

const WIDTH = 264;
const MARGIN = 8;
/** Above the profile popover (10001) and the context menus (10009/10010). */
const Z = 10020;

// ─── Body ────────────────────────────────────────────────────────────────────

export interface MemberRolePickerBodyProps extends RolePickerSession {
    serverId: string;
    userId: string;
    displayName?: string;
    fallbackRoleIds?: readonly string[];
    /** Focus the search box / first row once the roles are there. */
    autoFocus: boolean;
    maxListHeight: number;
}

export const MemberRolePickerBody: React.FC<MemberRolePickerBodyProps> = ({
    serverId, userId, displayName, fallbackRoleIds, token, myUserId, ownerUserId, perms, autoFocus, maxListHeight,
}) => {
    const roster = useServerRoster(serverId);
    const toast = useToast();
    const [loadError, setLoadError] = useState<string | null>(null);
    const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

    const fetchRoster = useCallback(() => {
        refreshRoster(serverId, token).catch(() => setLoadError('Could not load roles.'));
    }, [serverId, token]);
    // Revalidate on open (a no-op when the cached copy is fresh).
    useEffect(() => { fetchRoster(); }, [fetchRoster]);
    const retry = useCallback(() => { setLoadError(null); fetchRoster(); }, [fetchRoster]);

    const assignedIds = useMemberRoleIds(serverId, userId, fallbackRoleIds) ?? [];
    const highest = useMemo(
        () => (roster ? actorHighestPosition(myUserId, ownerUserId, roster.members, roster.roles) : -1),
        [roster, myUserId, ownerUserId],
    );
    const { roles, hiddenAbove } = useMemo(
        () => (roster ? assignableRoles(roster.roles, highest) : { roles: [], hiddenAbove: 0 }),
        [roster, highest],
    );
    const isMember = !roster || roster.members.some(m => m.user_id === userId);
    const allowed = hasManageRolesPermission(perms);

    const onToggle = useCallback((roleId: string, nextAssigned: boolean) => {
        setPending(prev => new Set(prev).add(roleId));
        setMemberRole({ serverId, userId, roleId, assign: nextAssigned, token, fallbackIds: fallbackRoleIds })
            .catch(err => {
                toast.push({ kind: 'error', title: nextAssigned ? 'Could not add role' : 'Could not remove role', message: roleToggleErrorMessage(err) });
            })
            .finally(() => {
                setPending(prev => { const n = new Set(prev); n.delete(roleId); return n; });
            });
    }, [serverId, userId, token, fallbackRoleIds, toast]);

    if (!allowed) {
        return <div className="rpk-state" role="status">You don’t have permission to manage roles in this server.</div>;
    }
    if (!isMember) {
        return <div className="rpk-state" role="status">They’re no longer a member of this server.</div>;
    }
    return (
        <RolePickerList
            roles={roles}
            assignedIds={assignedIds}
            onToggle={onToggle}
            pendingIds={pending}
            hiddenAbove={hiddenAbove}
            loading={!roster && !loadError}
            error={!roster ? loadError : null}
            onRetry={retry}
            autoFocus={autoFocus}
            maxListHeight={maxListHeight}
            label={displayName ? `Roles for ${displayName}` : 'Roles'}
        />
    );
};

// ─── In-menu flyout ──────────────────────────────────────────────────────────

export interface MemberRolesFlyoutProps {
    serverId: string;
    userId: string;
    displayName?: string;
    fallbackRoleIds?: readonly string[];
    /** Opened from the keyboard — take focus (search box, else first row). */
    viaKeyboard: boolean;
    /** The flyout's own height cap (ContextMenu's FlyoutRenderContext.maxHeight). */
    maxHeight: number;
}

export const MemberRolesFlyout: React.FC<MemberRolesFlyoutProps> = ({
    serverId, userId, displayName, fallbackRoleIds, viaKeyboard, maxHeight,
}) => {
    const picker = useRolePicker();
    const session = picker?.session(serverId) ?? null;
    if (!session) {
        return <div className="rpk-state" role="status">Roles are unavailable right now.</div>;
    }
    return (
        <div className="rpk-flyout" data-testid="member-roles-flyout">
            <MemberRolePickerBody
                {...session}
                serverId={serverId}
                userId={userId}
                displayName={displayName}
                fallbackRoleIds={fallbackRoleIds}
                autoFocus={viaKeyboard}
                maxListHeight={flyoutListHeight(maxHeight)}
            />
        </div>
    );
};

// ─── Anchored popover (profile card "+") ─────────────────────────────────────

export interface MemberRolePickerProps {
    args: OpenRolePickerArgs;
    token: string;
    myUserId: string;
    ownerUserId: string | null;
    perms: bigint;
    onClose: () => void;
}

export const MemberRolePicker: React.FC<MemberRolePickerProps> = ({ args, token, myUserId, ownerUserId, perms, onClose }) => {
    const { serverId, userId, anchor, displayName, fallbackRoleIds } = args;
    const rootRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
    const [vh, setVh] = useState(() => window.innerHeight);

    // ── Dismissal: outside click, Escape, another popover opening ─────────
    const close = useCallback(() => {
        onClose();
        const back = args.returnFocusTo;
        if (back && document.contains(back)) requestAnimationFrame(() => back.focus());
    }, [onClose, args.returnFocusTo]);
    const isInside = useCallback((t: Node) => !!rootRef.current?.contains(t), []);
    useDismissOnOutsideClick(isInside, true, close);
    useEscape(close);
    useEffect(() => {
        const onAll = () => onClose();
        window.addEventListener('close-all-popovers', onAll);
        const onResize = () => setVh(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('close-all-popovers', onAll);
            window.removeEventListener('resize', onResize);
        };
    }, [onClose]);

    // ── Placement: beside the anchor, flipped / clamped into the window ───
    const place = useCallback(() => {
        const el = rootRef.current;
        if (!el) return;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        let left = anchor.x;
        let top = anchor.y;
        if (left + WIDTH > vw - MARGIN) left = Math.max(MARGIN, anchor.x - WIDTH);
        if (top + h > vh - MARGIN) top = Math.max(MARGIN, vh - h - MARGIN);
        setPos(prev => (prev.left === left && prev.top === top ? prev : { left, top }));
    }, [anchor.x, anchor.y, vh]);
    useLayoutEffect(place, [place]);
    // Re-place when the content (and so the height) changes — the roster
    // landing, a search filtering rows away.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => place());
        ro.observe(el);
        return () => ro.disconnect();
    }, [place]);

    // Header + search + footer + padding ≈ 120px; the list takes the rest, capped.
    const maxListHeight = Math.max(120, Math.min(320, vh - 2 * MARGIN - 120));

    return ReactDOM.createPortal(
        <div className="cl-kit">
            <div
                ref={rootRef}
                role="dialog"
                aria-label={displayName ? `Edit roles for ${displayName}` : 'Edit roles'}
                className="ctxm rpk-pop"
                style={{ left: pos.left, top: pos.top, zIndex: Z }}
                onContextMenu={e => e.preventDefault()}
                onClick={e => e.stopPropagation()}
                data-testid="member-role-picker"
            >
                <div className="rpk-head">
                    <span>{displayName ? `Roles · ${displayName}` : 'Roles'}</span>
                    <button type="button" className="rpk-close" onClick={close} aria-label="Close" title="Close">
                        <X size={13} aria-hidden="true" />
                    </button>
                </div>
                <MemberRolePickerBody
                    serverId={serverId}
                    userId={userId}
                    displayName={displayName}
                    fallbackRoleIds={fallbackRoleIds}
                    token={token}
                    myUserId={myUserId}
                    ownerUserId={ownerUserId}
                    perms={perms}
                    autoFocus
                    maxListHeight={maxListHeight}
                />
            </div>
        </div>,
        document.body,
    );
};
