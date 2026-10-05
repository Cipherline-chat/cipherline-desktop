/**
 * One-click access presets for a new (or existing) channel / category.
 *
 * Every preset is just a DraftMap — it goes through the same reducer as a
 * hand edit, so it is fully editable afterwards and undoable. Nothing here
 * is hard-coded to role names: "staff" is derived from what each of the
 * server's actual roles is allowed to do.
 */

import { Permissions, isAdministrator } from '@cipherline/shared';
import type { ChannelKind } from '../roles/permissions';
import type { PermRole } from './effectivePermissions';
import { memberKey, roleKey, type DraftMap, type OverrideBits } from './overrideDraft';

export type PresetId = 'public' | 'private' | 'readonly' | 'staff';

/** Server-wide bits that mark a role as "staff" for the presets. */
export const STAFF_SIGNAL_PERMISSIONS =
    Permissions.MANAGE_SERVER
    | Permissions.MANAGE_ROLES
    | Permissions.MANAGE_CHANNELS
    | Permissions.MANAGE_MESSAGES
    | Permissions.KICK_MEMBERS
    | Permissions.BAN_MEMBERS
    | Permissions.MUTE_MEMBERS
    | Permissions.DEAFEN_MEMBERS
    | Permissions.MOVE_MEMBERS;

/**
 * Roles a preset should treat as staff, in hierarchy order: any non-@everyone
 * role holding a moderation/management bit. ADMINISTRATOR roles are left out
 * on purpose — overrides never apply to them (they see and do everything
 * anyway), so an override row for them would be dead weight.
 */
export const staffRoleIds = (roles: readonly PermRole[]): string[] =>
    [...roles]
        .filter(r => !r.is_everyone && !isAdministrator(r.permissions) && (r.permissions & STAFF_SIGNAL_PERMISSIONS) !== 0n)
        .sort((a, b) => b.position - a.position)
        .map(r => r.role_id);

export interface PresetInput {
    kind: ChannelKind;
    everyoneRoleId: string;
    /** Roles (and members) that keep access / keep talking. */
    roleIds: readonly string[];
    memberIds?: readonly string[];
    /** Is VIEW_CHANNEL denied to @everyone by an inherited (category) override?
     *  "Public" then has to allow it back explicitly. */
    everyoneViewInheritedDenied?: boolean;
}

/** The bits a "read-only" preset takes away from everyone and gives staff. */
export const readonlyBits = (kind: ChannelKind): bigint =>
    kind === 'huddle'
        ? Permissions.SPEAK | Permissions.VIDEO | Permissions.SCREEN_SHARE
        : Permissions.SEND_MESSAGES;

export function buildPreset(id: PresetId, input: PresetInput): DraftMap {
    const out: Record<string, OverrideBits> = {};
    const ev = roleKey(input.everyoneRoleId);
    const V = Permissions.VIEW_CHANNEL;
    const grant = (bits: bigint) => {
        for (const rid of input.roleIds) if (rid !== input.everyoneRoleId) out[roleKey(rid)] = { allow: bits, deny: 0n };
        for (const uid of input.memberIds ?? []) out[memberKey(uid)] = { allow: bits, deny: 0n };
    };
    switch (id) {
        case 'public':
            if (input.everyoneViewInheritedDenied) out[ev] = { allow: V, deny: 0n };
            break;
        case 'private':
        case 'staff':
            out[ev] = { allow: 0n, deny: V };
            grant(V);
            break;
        case 'readonly': {
            const bits = readonlyBits(input.kind);
            out[ev] = { allow: input.everyoneViewInheritedDenied ? V : 0n, deny: bits };
            grant(bits);
            break;
        }
    }
    return out;
}

export interface DetectedPreset {
    id: PresetId | 'custom';
    /** For private/staff/readonly: who was granted access. */
    roleIds: string[];
    memberIds: string[];
}

/**
 * Which preset (if any) a draft is exactly — so the preset picker can show
 * the current state instead of forgetting it the moment you edit a row.
 */
export function detectPreset(
    draft: DraftMap,
    ctx: { kind: ChannelKind; everyoneRoleId: string; staffIds: readonly string[]; mask: bigint },
): DetectedPreset {
    const V = Permissions.VIEW_CHANNEL;
    const ev = roleKey(ctx.everyoneRoleId);
    const visible = (b: OverrideBits | undefined) => ({ allow: (b?.allow ?? 0n) & ctx.mask, deny: (b?.deny ?? 0n) & ctx.mask });
    const entries = Object.entries(draft)
        .map(([k, b]) => [k, visible(b)] as const)
        .filter(([, b]) => b.allow !== 0n || b.deny !== 0n);
    const others = entries.filter(([k]) => k !== ev);
    const evBits = visible(draft[ev]);
    const roleIds = others.filter(([k]) => k.startsWith('role:')).map(([k]) => k.slice(5));
    const memberIds = others.filter(([k]) => k.startsWith('member:')).map(([k]) => k.slice(7));
    const onlyGrant = (bits: bigint) => others.every(([, b]) => b.allow === bits && b.deny === 0n);
    const custom: DetectedPreset = { id: 'custom', roleIds, memberIds };

    if (entries.length === 0) return { id: 'public', roleIds: [], memberIds: [] };
    if (others.length === 0 && evBits.allow === V && evBits.deny === 0n) return { id: 'public', roleIds: [], memberIds: [] };

    if (evBits.allow === 0n && evBits.deny === V && onlyGrant(V)) {
        const sameAsStaff = memberIds.length === 0
            && roleIds.length === ctx.staffIds.length
            && roleIds.every(r => ctx.staffIds.includes(r));
        return { id: sameAsStaff && roleIds.length > 0 ? 'staff' : 'private', roleIds, memberIds };
    }
    const ro = readonlyBits(ctx.kind);
    if (evBits.deny === ro && (evBits.allow === 0n || evBits.allow === V) && onlyGrant(ro)) {
        return { id: 'readonly', roleIds, memberIds };
    }
    return custom;
}
