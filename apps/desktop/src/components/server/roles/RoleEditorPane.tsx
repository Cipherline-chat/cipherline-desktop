/**
 * RoleEditorPane — right column of the Roles tab.
 *
 * Single-scroll layout (no tabs): identity header → display editor →
 * permissions chip grid → members. No subTab state; parent just switches
 * role_id.
 */

import React, { useCallback, useEffect } from 'react';
import type { Role } from './types';
import { RoleDisplayEditor } from './RoleDisplayEditor';
import { RolePermissionsEditor } from './RolePermissionsEditor';
import { RoleMembersEditor } from './RoleMembersEditor';

interface Props {
    role: Role;
    serverId: string;
    token: string | null;
    canManage: boolean;
    onSaved: (next: Role) => void;
    onDelete: () => void;
    onError?: (msg: string) => void;
    everyonePerms?: bigint;
    onDirtyChange?: (dirty: boolean) => void;
}

export const RoleEditorPane: React.FC<Props> = ({
    role, serverId, token, canManage, onSaved, onDelete, onError, everyonePerms, onDirtyChange,
}) => {
    // Reset dirty flag whenever the selected role changes.
    useEffect(() => {
        onDirtyChange?.(false);
    }, [role.role_id]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleDirtyChange = useCallback((dirty: boolean) => {
        onDirtyChange?.(dirty);
    }, [onDirtyChange]);

    return (
        // No separate header bar anymore — the display editor's color-washed
        // identity hero IS the header (it also hosts Delete), which kills the
        // old duplication of showing the role name-in-colour twice (header +
        // preview card) that made this read like Discord's role settings.
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: 'var(--cl-deep)' }}>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="px-8 py-7 space-y-10">

                    {/* Identity hero + name / colour / options */}
                    <RoleDisplayEditor
                        role={role}
                        serverId={serverId}
                        token={token}
                        readOnly={!canManage || role.is_everyone}
                        canDelete={canManage && !role.is_everyone}
                        onDelete={onDelete}
                        onSaved={onSaved}
                        onError={onError}
                        onDirtyChange={handleDirtyChange}
                    />

                    {/* Permissions chip grid */}
                    <section>
                        <SectionHeading>Permissions</SectionHeading>
                        <RolePermissionsEditor
                            role={role}
                            serverId={serverId}
                            token={token}
                            readOnly={!canManage}
                            everyonePerms={everyonePerms}
                            onSaved={onSaved}
                            onError={onError}
                            onDirtyChange={handleDirtyChange}
                        />
                    </section>

                    {/* Members */}
                    <section>
                        <SectionHeading>Members</SectionHeading>
                        <RoleMembersEditor
                            role={role}
                            serverId={serverId}
                            token={token}
                            readOnly={!canManage}
                            onError={onError}
                        />
                    </section>

                </div>
            </div>
        </div>
    );
};

function SectionHeading({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 mb-5">
            <h3
                className="text-[11px] font-mono font-semibold uppercase tracking-widest shrink-0"
                style={{ color: 'var(--cl-faint)' }}
            >
                {children}
            </h3>
            <div className="flex-1 h-px" style={{ background: 'var(--cl-border)' }} />
        </div>
    );
}
