import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ClButton, ClInput, ClSelect } from '../../cl';
import type { ClSelectOption, ClSelectReorderConfig } from '../../cl';
import { readableRoleColorHex, roleColorHexFromInt } from '../../../utils/roleColor';
import { computeMovePosition } from './roleReorderMath';
import { sortRolesForDisplay } from './roleOrder';
import { useEscape } from '../../../hooks/useEscape';
import type { Role } from './types';

interface Props {
    roles: Role[];
    selectedRoleId: string | null;
    onSelect: (roleId: string) => void;
    onCreate: (name: string) => Promise<void>;
    canManage: boolean;
    onReorder?: (roleId: string, newPosition: number) => Promise<void>;
    onError?: (msg: string) => void;
}

const sortRoles = (roles: Role[]): Role[] => sortRolesForDisplay(roles);

/** One role's dropdown label — colour dot + the role's own colour as the
 *  text colour (lightened, hue/sat preserved, only if it wouldn't otherwise
 *  read against the dropdown's dark background), used for BOTH the closed
 *  trigger and the open option list since `ClSelect` renders the same
 *  `label` node in both places. No colour assigned -> normal text colour,
 *  never invisible. */
function roleOptionLabel(role: Role): React.ReactNode {
    const hex = roleColorHexFromInt(role.color);
    const readable = readableRoleColorHex(hex);
    return (
        <span className="flex items-center gap-2 min-w-0">
            <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{
                    backgroundColor: readable ?? 'transparent',
                    boxShadow: readable ? `0 0 6px ${readable}70` : undefined,
                    border: readable ? undefined : '1.5px solid rgba(255,255,255,0.25)',
                }}
            />
            <span className="truncate" style={readable ? { color: readable } : undefined}>
                {role.name}
            </span>
            {role.is_everyone && (
                <span className="text-[9px] uppercase tracking-widest text-cl-faint font-bold shrink-0">all</span>
            )}
        </span>
    );
}

export const RoleListPane: React.FC<Props> = ({
    roles, selectedRoleId, onSelect, onCreate, canManage, onReorder,
}) => {
    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState('');
    // A layer of its own while naming a new role — Escape backs out of just
    // the inline create control, not whatever hosts this pane.
    useEscape(() => { setCreating(false); setDraftName(''); }, creating);
    const [busy, setBusy] = useState(false);
    const [sorted, setSorted] = useState<Role[]>(() => sortRoles(roles));
    const [moving, setMoving] = useState(false);
    const backupRef = useRef<Role[]>([]);

    useEffect(() => {
        if (!moving) setSorted(sortRoles(roles));
    }, [roles, moving]);

    const draggableRoles = useMemo(() => sorted.filter(r => !r.is_everyone), [sorted]);
    const everyoneRole = useMemo(() => sorted.find(r => r.is_everyone), [sorted]);

    const options: ClSelectOption<string>[] = useMemo(() => {
        const opts = draggableRoles.map(r => ({ value: r.role_id, label: roleOptionLabel(r) }));
        if (everyoneRole) opts.push({ value: everyoneRole.role_id, label: roleOptionLabel(everyoneRole) });
        return opts;
    }, [draggableRoles, everyoneRole]);

    // Runs the SAME persistence path the old up/down buttons (and the rail
    // before them) used — compute the new midpoint `position` via
    // computeMovePosition, apply it optimistically, PATCH it, and revert on
    // failure (e.g. the server's hierarchy check: you can't move a role to
    // or above your own highest — see roles.service.ts). `fromIndex`/
    // `toIndex` are indices into `draggableRoles` (never `@everyone`, which
    // is never part of this array).
    const moveRole = async (fromIndex: number, toIndex: number) => {
        const movedRole = draggableRoles[fromIndex];
        if (!onReorder || !movedRole || fromIndex === toIndex) return;
        const newPos = computeMovePosition(draggableRoles, fromIndex, toIndex);
        backupRef.current = sorted;
        setMoving(true);
        setSorted(sortRoles(sorted.map(r =>
            r.role_id === movedRole.role_id ? { ...r, position: newPos } : r,
        )));
        try {
            await onReorder(movedRole.role_id, newPos);
        } catch {
            setSorted(backupRef.current);
        } finally {
            setMoving(false);
        }
    };

    // ClSelect reports moves as (movedValue, full new value order) — a plain
    // enough contract for a generic dropdown. Translate that into the
    // fromIndex/toIndex `moveRole` (and computeMovePosition) already expect.
    // `@everyone` is stripped out of `newOrder` first: ClSelect's `isLocked`
    // clamp below guarantees it never actually appears anywhere but last (so
    // this is a defensive no-op strip, not something the clamp relies on).
    const handleSelectReorder = (movedRoleId: string, newOrder: string[]) => {
        const newDraggableOrder = everyoneRole
            ? newOrder.filter(id => id !== everyoneRole.role_id)
            : newOrder;
        const fromIndex = draggableRoles.findIndex(r => r.role_id === movedRoleId);
        const toIndex = newDraggableOrder.indexOf(movedRoleId);
        if (fromIndex === -1 || toIndex === -1) return;
        void moveRole(fromIndex, toIndex);
    };

    const reorderConfig: ClSelectReorderConfig<string> | undefined = (canManage && onReorder)
        ? {
            isLocked: (id) => id === everyoneRole?.role_id,
            onReorder: handleSelectReorder,
            describeValue: (id) => sorted.find(r => r.role_id === id)?.name ?? id,
        }
        : undefined;

    const submitNew = async () => {
        const trimmed = draftName.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        try {
            await onCreate(trimmed);
            setDraftName('');
            setCreating(false);
        } finally { setBusy(false); }
    };

    return (
        <div className="shrink-0 border-b border-cl-border/40 flex items-center gap-3 px-5 py-3" style={{ background: 'var(--cl-abyss)' }}>
            {/* Left: count label */}
            <p className="text-[10px] font-mono font-semibold uppercase tracking-widest shrink-0" style={{ color: 'var(--cl-faint)' }}>
                Roles<span className="text-cl-lume ml-1.5">{roles.length}</span>
            </p>

            {/* Middle: the role picker — a dropdown instead of a horizontal rail
                so this scales past a handful of roles without wrapping/overflow.
                Hierarchy reordering lives INSIDE it now: press-and-drag an
                option (past a small movement threshold, so a plain click still
                selects it) to change its position; `reorderConfig` is only set
                when `canManage`, so a read-only viewer gets a plain select with
                no drag affordance at all. @everyone is `isLocked` — it can't be
                picked up, and the drop indicator never lands past it — so it
                stays pinned last exactly like the old rail pinned it. */}
            <div className="flex-1 min-w-0">
                {roles.length === 0 ? (
                    <span className="text-[12px] text-cl-faint px-1">No roles yet.</span>
                ) : (
                    <ClSelect
                        options={options}
                        value={selectedRoleId ?? options[0]?.value ?? ''}
                        onChange={onSelect}
                        style={{ width: '100%', maxWidth: 320 }}
                        ariaLabel="Select role to edit"
                        reorder={reorderConfig}
                    />
                )}
            </div>

            {/* Right: create control (its own action, deliberately not folded
                into the dropdown's option list). */}
            {canManage && (
                <div className="shrink-0">
                    {creating ? (
                        <div className="flex items-center gap-1.5">
                            <ClInput
                                autoFocus
                                type="text"
                                value={draftName}
                                onChange={e => setDraftName(e.target.value)}
                                placeholder="Role name…"
                                maxLength={50}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') submitNew();
                                }}
                                style={{ width: 160, flexShrink: 0, padding: '7px 12px', fontSize: 13 }}
                            />
                            <ClButton size="sm" onClick={submitNew} disabled={!draftName.trim() || busy} loading={busy}>
                                Add
                            </ClButton>
                            <ClButton size="sm" variant="ghost" icon onClick={() => { setCreating(false); setDraftName(''); }} tooltip="Cancel">
                                <X size={14} />
                            </ClButton>
                        </div>
                    ) : (
                        <ClButton variant="ghost" size="sm" onClick={() => setCreating(true)}>
                            <Plus size={12} /> New
                        </ClButton>
                    )}
                </div>
            )}
        </div>
    );
};
