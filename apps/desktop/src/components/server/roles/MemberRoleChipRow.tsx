import React from 'react';
import { useServerRoster } from '../../../hooks/useServerRoster';
import { roleColorHexFromInt } from '../../../utils/roleColor';
import { useMemberRoleIds } from './memberRoleMutation';
import { memberRoleChips } from './memberRoleChips';

/**
 * The member's roles as small coloured chips (Server Settings → Members).
 * Reads `useMemberRoleIds`, so a toggle in the role picker flips the chips on
 * the click, the same way the profile card does, not a round trip later.
 */
export const MemberRoleChipRow: React.FC<{ serverId: string; userId: string; max?: number }> = ({ serverId, userId, max = 3 }) => {
    const roster = useServerRoster(serverId);
    const roleIds = useMemberRoleIds(serverId, userId);
    const { shown, more } = memberRoleChips(roster?.roles, roleIds, max);
    if (shown.length === 0) return null;
    return (
        <div className="flex items-center gap-1 mt-1 min-w-0 flex-wrap" data-member-roles={userId}>
            {shown.map(r => {
                const hex = roleColorHexFromInt(r.color);
                return (
                    <span key={r.role_id} className="inline-flex items-center gap-1 max-w-[140px] text-[10.5px] leading-none px-1.5 py-[3px] rounded-full bg-cl-raise/60 border border-cl-border/60 text-cl-muted">
                        <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: hex ?? 'var(--cl-faint)' }} />
                        <span className="truncate">{r.name}</span>
                    </span>
                );
            })}
            {more > 0 && <span className="text-[10.5px] text-cl-faint">+{more}</span>}
        </div>
    );
};
