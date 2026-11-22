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
    /** Gradient end colour (packed RGB, -1/absent = solid). Newer APIs only. */
    secondary_color?: number;
    /** Role icon: a single unicode emoji, or an uploaded image (id + the
     *  server-held key/nonce). At most one is set. Newer APIs only. */
    icon_emoji?: string | null;
    icon_attachment_id?: string | null;
    icon_key_b64?: string | null;
    icon_nonce_b64?: string | null;
}

/** Sub-tab keys inside the role editor. */
export type RoleEditorSubTab = 'display' | 'permissions' | 'members';
