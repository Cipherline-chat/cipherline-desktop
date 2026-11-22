/**
 * Role ICONS and GRADIENT role colours — the client half of the role-icons
 * feature (API: RolesService.setRoleIcon / clearRoleIcon, UpdateRoleDto
 * `secondary_color` / `icon_emoji`).
 *
 *   - Gradient: a role with BOTH `color` and `secondary_color` paints member
 *     names as a left-to-right text gradient. Both stops go through
 *     readableNameColor (so Light / Midnight keep them readable), high-contrast
 *     themes get the solid primary colour (the accessible fallback), and
 *     Windows forced-colours mode drops the gradient in CSS (role-style.css).
 *   - Icon: the member's HIGHEST role that has one (Discord parity), an emoji
 *     or an uploaded image (encrypted like a server emoji; the key rides on
 *     the role row and the blob loads through serverEmojiLoader).
 *
 * Owner decision 2026-11-22: icons show in the member list, profile role pills
 * and the role editor — NOT next to message author names in chat. Gradients do
 * show on chat author names.
 *
 * Every field is optional: an API that predates the feature sends none, and
 * everything here degrades to the plain single-colour behaviour.
 */
import type { CSSProperties } from 'react';
import type { Theme } from '../theme/themes';
import { getTheme } from '../theme/engine';
import { readableNameColor, roleColorHexFromInt } from './roleColor';
import type { EmojiImageRef } from './serverEmojiLoader';

export interface RoleDecorFields {
    role_id: string;
    name: string;
    color: number;
    position: number;
    is_everyone: boolean;
    secondary_color?: number | null;
    icon_emoji?: string | null;
    icon_attachment_id?: string | null;
    icon_key_b64?: string | null;
    icon_nonce_b64?: string | null;
}

/** The fields roleIconOf reads — narrower than RoleDecorFields so a
 *  profile/picker role shape without position/@everyone also fits. */
export type RoleIconFields = Pick<RoleDecorFields, 'role_id' | 'name' | 'icon_emoji' | 'icon_attachment_id' | 'icon_key_b64' | 'icon_nonce_b64'> & { is_everyone?: boolean };

export type RoleIcon =
    | { kind: 'emoji'; emoji: string; roleName: string; roleId: string }
    | { kind: 'image'; ref: EmojiImageRef; roleName: string; roleId: string };

/** Longest emoji string we will render as an icon (matches the API cap). */
export const ROLE_ICON_EMOJI_MAX_UNITS = 32;

const isPackedRgb = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffff;

/** The gradient's END colour as a hex, or null when the role is solid: no
 *  primary colour, no/invalid secondary, or the two are the same colour. */
export function roleSecondaryHex(role: Pick<RoleDecorFields, 'color' | 'secondary_color'> | null | undefined): string | null {
    if (!role || role.color === -1 || !isPackedRgb(role.secondary_color)) return null;
    const primary = roleColorHexFromInt(role.color);
    const secondary = roleColorHexFromInt(role.secondary_color);
    return primary && secondary && primary !== secondary ? secondary : null;
}

/** The role's icon, or null. An image needs all three of id/key/nonce. */
export function roleIconOf(role: RoleIconFields | null | undefined, serverId: string | null): RoleIcon | null {
    if (!role || role.is_everyone) return null;
    const emoji = role.icon_emoji;
    if (typeof emoji === 'string' && emoji.length > 0 && emoji.length <= ROLE_ICON_EMOJI_MAX_UNITS) {
        return { kind: 'emoji', emoji, roleName: role.name, roleId: role.role_id };
    }
    if (role.icon_attachment_id && role.icon_key_b64 && role.icon_nonce_b64) {
        return {
            kind: 'image',
            roleName: role.name,
            roleId: role.role_id,
            ref: { serverId, attachmentId: role.icon_attachment_id, keyB64: role.icon_key_b64, nonceB64: role.icon_nonce_b64 },
        };
    }
    return null;
}

/** The member's highest role that carries an icon (@everyone never does). */
export function getTopIconRole<R extends RoleDecorFields>(roleIds: ReadonlyArray<string>, roles: ReadonlyArray<R>): R | null {
    let best: R | null = null;
    for (const r of roles) {
        if (r.is_everyone || !roleIds.includes(r.role_id)) continue;
        if (!roleIconOf(r, null)) continue;
        if (!best || r.position > best.position) best = r;
    }
    return best;
}

/** The member's highest COLOURED role (same rule as getTopColoredRole) — its
 *  secondary colour is the member's gradient end. */
function topColoredRole<R extends RoleDecorFields>(roleIds: ReadonlyArray<string>, roles: ReadonlyArray<R>): R | null {
    let best: R | null = null;
    for (const r of roles) {
        if (r.is_everyone || r.color === -1 || !roleIds.includes(r.role_id)) continue;
        if (!best || r.position > best.position) best = r;
    }
    return best;
}

export interface MemberRoleDecor {
    /** Gradient end colour of the member's colour role, or null (solid). */
    secondary: string | null;
    /** Icon of the member's highest icon-bearing role, or null. */
    icon: RoleIcon | null;
}

/** userId -> decor, for every member that has a gradient or an icon. Members
 *  with neither are omitted (callers treat a miss as "plain"). */
export function buildMemberRoleDecor(
    members: ReadonlyArray<{ user_id: string; role_ids?: ReadonlyArray<string> | null }>,
    roles: ReadonlyArray<RoleDecorFields>,
    serverId: string | null,
): Record<string, MemberRoleDecor> {
    const out: Record<string, MemberRoleDecor> = {};
    if (!roles.length) return out;
    const anyDecor = roles.some(r => roleSecondaryHex(r) || roleIconOf(r, null));
    if (!anyDecor) return out;
    for (const m of members) {
        const ids = m.role_ids ?? [];
        if (!ids.length) continue;
        const secondary = roleSecondaryHex(topColoredRole(ids, roles));
        const icon = roleIconOf(getTopIconRole(ids, roles), serverId);
        if (secondary || icon) out[m.user_id] = { secondary, icon };
    }
    return out;
}

/** userId -> gradient end hex (chat author names need only this). */
export function buildMemberRoleSecondary(
    members: ReadonlyArray<{ user_id: string; role_ids?: ReadonlyArray<string> | null }>,
    roles: ReadonlyArray<RoleDecorFields>,
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!roles.some(r => roleSecondaryHex(r))) return out;
    for (const m of members) {
        const s = roleSecondaryHex(topColoredRole(m.role_ids ?? [], roles));
        if (s) out[m.user_id] = s;
    }
    return out;
}

/** Themes at or above this name contrast are the high-contrast ones: they get
 *  the solid primary colour instead of a gradient. */
export const HIGH_CONTRAST_NAME_MIN = 8;

export interface RoleNameStyle {
    className?: string;
    style: CSSProperties;
}

/**
 * Props for a role-coloured NAME element. Solid colour exactly as before when
 * there is no gradient; otherwise the `cl-role-gradient` class (role-style.css)
 * plus its two stops as custom properties, with `color` still set to the
 * readable primary — that is what forced-colours mode, text selection and any
 * child icon (currentColor) fall back to.
 */
export function roleNameStyle(
    primary: string | null | undefined,
    secondary: string | null | undefined,
    fallback: string,
    theme: Theme = getTheme(),
): RoleNameStyle {
    const p = readableNameColor(primary ?? null, theme);
    if (!p) return { style: { color: fallback } };
    if (!secondary || theme.contrast === 'high' || theme.nameMinContrast >= HIGH_CONTRAST_NAME_MIN) return { style: { color: p } };
    const s = readableNameColor(secondary, theme) ?? p;
    if (s.toLowerCase() === p.toLowerCase()) return { style: { color: p } };
    return {
        className: 'cl-role-gradient',
        style: { color: p, ['--cl-role-a' as string]: p, ['--cl-role-b' as string]: s } as CSSProperties,
    };
}

/** A CSS background for a role's colour SWATCH (dot / chip): the gradient when
 *  it has one, the solid colour otherwise, null for "no colour". */
export function roleSwatchBackground(role: Pick<RoleDecorFields, 'color' | 'secondary_color'>): string | null {
    const primary = roleColorHexFromInt(role.color);
    if (!primary) return null;
    const secondary = roleSecondaryHex(role);
    return secondary ? `linear-gradient(135deg, ${primary}, ${secondary})` : primary;
}
