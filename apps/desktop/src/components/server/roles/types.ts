/**
 * Shared types used across the roles/ folder. The shape mirrors the API row
 * (`apps/api/src/entities/role.entity.ts`).
 */

export interface Role {
    role_id: string;
    name: string;
    color: number;        // 24-bit packed RGB; -1 = no colour
    position: number;     // higher = higher priority (Discord semantics)
    permissions: string;  // BigInt encoded as decimal string over the wire
    mentionable: boolean;
    hoisted: boolean;     // legacy — universal top-role grouping ignores this
    is_everyone: boolean;
}

/** Sub-tab keys inside the role editor. */
export type RoleEditorSubTab = 'display' | 'permissions' | 'members';
