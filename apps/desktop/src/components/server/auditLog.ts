/**
 * Server Settings → Audit Log: turns one `audit_log_entries` row into a human
 * sentence, an icon key, a tone and a few detail lines.
 *
 * Pure (no React, no I/O) so every action's wording is unit-tested
 * (auditLog.test.ts). The server is the source of truth for WHAT happened; this
 * file only words it. Two rules:
 *
 *  - It must NEVER throw. A row from a newer server (an action this client has
 *    never heard of), an older row with a thinner payload, or a payload of an
 *    unexpected shape all render as a sensible generic sentence.
 *  - It only ever shows server metadata the API stored (names, ids resolved to
 *    names, flags, permission names). Nothing here can reveal message content:
 *    the log never holds any.
 */
import { PERMISSION_GROUPS } from './roles/permissions';
import { slowmodeLabel } from '@cipherline/shared';

export type AuditIcon =
    | 'userPlus' | 'userMinus' | 'ban' | 'mute' | 'nickname' | 'shield' | 'role'
    | 'hash' | 'folder' | 'layout' | 'divider' | 'permissions' | 'server' | 'crown'
    | 'link' | 'smile' | 'pin' | 'save' | 'phone' | 'info';

export type AuditTone = 'ok' | 'danger' | 'accent' | 'neutral';

export interface AuditEntryLike {
    id: string;
    action: string;
    actor_user_id?: string;
    actor_username?: string | null;
    target_user_id?: string | null;
    target_username?: string | null;
    target_role_id?: string | null;
    target_channel_id?: string | null;
    target_role_name?: string | null;
    target_channel_name?: string | null;
    /** id -> current display name, for every id this entry mentions (API-resolved). */
    names?: Record<string, string> | null;
    data_jsonb?: unknown;
    created_at: string;
}

export interface AuditDescription {
    icon: AuditIcon;
    tone: AuditTone;
    /** "Alice gave Bob the Moderator role" */
    sentence: string;
    /** Extra lines under the sentence (diffs, reasons, moves). Capped. */
    details: string[];
}

const MAX_DETAILS = 8;

// ── Filter ────────────────────────────────────────────────────────────────

export interface AuditFilterOption { value: string; label: string }

/** Groups for the action filter. A value is an exact action; '' = everything. */
export const AUDIT_FILTER_OPTIONS: AuditFilterOption[] = [
    { value: '', label: 'All actions' },
    { value: 'member.role_added', label: 'Role given to a member' },
    { value: 'member.role_removed', label: 'Role removed from a member' },
    { value: 'role.create', label: 'Role created' },
    { value: 'role.update', label: 'Role edited' },
    { value: 'role.delete', label: 'Role deleted' },
    { value: 'channel.create', label: 'Channel created' },
    { value: 'channel.update', label: 'Channel edited' },
    { value: 'channel.delete', label: 'Channel deleted' },
    { value: 'channel.reorder', label: 'Channels reordered or moved' },
    { value: 'channel.override.update', label: 'Channel permissions changed' },
    { value: 'channel.override.delete', label: 'Channel permissions removed' },
    { value: 'category.create', label: 'Category created' },
    { value: 'category.update', label: 'Category edited' },
    { value: 'category.delete', label: 'Category deleted' },
    { value: 'category.reorder', label: 'Categories reordered' },
    { value: 'category.override.update', label: 'Category permissions changed' },
    { value: 'category.override.delete', label: 'Category permissions removed' },
    { value: 'subcategory.create', label: 'Sub-category created' },
    { value: 'subcategory.update', label: 'Sub-category edited' },
    { value: 'subcategory.move', label: 'Sub-category moved' },
    { value: 'subcategory.delete', label: 'Sub-category deleted' },
    { value: 'divider.create', label: 'Divider created' },
    { value: 'divider.update', label: 'Divider edited' },
    { value: 'divider.delete', label: 'Divider deleted' },
    { value: 'layout.update', label: 'Channel list rearranged' },
    { value: 'server.update', label: 'Server settings changed' },
    { value: 'server.transfer_ownership', label: 'Ownership transferred' },
    { value: 'member.kick', label: 'Member kicked' },
    { value: 'member.ban', label: 'Member banned' },
    { value: 'member.unban', label: 'Member unbanned' },
    { value: 'member.mute', label: 'Member muted' },
    { value: 'member.unmute', label: 'Member unmuted' },
    { value: 'member.nickname_set', label: 'Nickname changed' },
    { value: 'member.call_mute', label: 'Call mute / deafen' },
    { value: 'member.join', label: 'Member joined' },
    { value: 'member.leave', label: 'Member left' },
    { value: 'invite.create', label: 'Invite created' },
    { value: 'invite.delete', label: 'Invite deleted' },
    { value: 'emoji.create', label: 'Emoji added' },
    { value: 'emoji.update', label: 'Emoji renamed' },
    { value: 'emoji.delete', label: 'Emoji deleted' },
    { value: 'channel.pin.create', label: 'Message pinned' },
    { value: 'channel.pin.delete', label: 'Message unpinned' },
    { value: 'channel.save.create', label: 'Message saved to server' },
    { value: 'channel.save.delete', label: 'Message un-saved' },
    { value: 'import.start', label: 'Message import started' },
    { value: 'import.complete', label: 'Message import finished' },
    { value: 'import.cancel', label: 'Message import stopped' },
    { value: 'import.save', label: 'Imported messages saved' },
    { value: 'huddle.call.spawn', label: 'Call started' },
    { value: 'huddle.call.rename', label: 'Call renamed' },
    { value: 'huddle.call.destroy', label: 'Call ended' },
    { value: 'huddle.member.move', label: 'Member moved between calls' },
    { value: 'huddle.member.disconnect', label: 'Member disconnected from a call' },
];

// ── Small, throw-proof readers ────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Server setting "Message styles" (card styles in channels), as the settings UI names it. */
function messageStylesLabel(v: unknown): string {
    return v === 'off' ? 'Off' : v === 'no_animation' ? 'No animation' : 'On';
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

let LABELS: Map<string, string> | null = null;
/** "MANAGE_ROLES" -> "Manage Roles"; an unknown key is humanised, never dropped. */
/** role.update `icon` before/after: an emoji, `image:<attachment id>`, or null. */
function roleIconChange(before: unknown, after: unknown): string {
    const isImage = (v: unknown) => typeof v === 'string' && v.startsWith('image:');
    if (after === null || after === undefined) return 'Icon removed';
    if (isImage(after)) return before === null || before === undefined ? 'Icon image added' : 'Icon image changed';
    return `Icon set to ${String(after)}`;
}

export function permissionLabel(key: string): string {
    if (!LABELS) {
        LABELS = new Map();
        for (const g of PERMISSION_GROUPS) for (const p of g.permissions) LABELS.set(p.key, p.label);
    }
    return LABELS.get(key) ?? humanize(key);
}

function humanize(s: string): string {
    const t = s.replace(/[._]+/g, ' ').trim().toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Unknown action';
}

/** "future.thing_happened" -> "Future thing happened". Used for unknown actions. */
export function humanizeAction(action: string): string {
    return humanize(typeof action === 'string' ? action : '');
}

const list = (xs: string[]): string => xs.map(permissionLabel).join(', ');

function fmtDuration(seconds: number): string {
    if (seconds % 86400 === 0) { const d = seconds / 86400; return `${d} day${d === 1 ? '' : 's'}`; }
    if (seconds % 3600 === 0) { const h = seconds / 3600; return `${h} hour${h === 1 ? '' : 's'}`; }
    if (seconds % 60 === 0) { const m = seconds / 60; return `${m} minute${m === 1 ? '' : 's'}`; }
    return `${seconds} seconds`;
}

// ── The describer ─────────────────────────────────────────────────────────

export function describeAuditEntry(e: AuditEntryLike): AuditDescription {
    try {
        return describe(e);
    } catch {
        return fallback(e);
    }
}

function fallback(e: AuditEntryLike): AuditDescription {
    const who = (e && typeof e.actor_username === 'string' && e.actor_username) || 'Someone';
    return { icon: 'info', tone: 'neutral', sentence: `${who}: ${humanizeAction(e?.action)}`, details: [] };
}

function describe(e: AuditEntryLike): AuditDescription {
    const d = obj(e.data_jsonb);
    const names = obj(e.names) as Record<string, string>;
    const nameOf = (id: unknown, alt: string): string => {
        const k = str(id);
        return (k && names[k]) || alt;
    };
    const actor = e.actor_username || 'Someone';
    const target = e.target_username || 'a member';
    const details: string[] = [];
    const out = (icon: AuditIcon, tone: AuditTone, sentence: string): AuditDescription =>
        ({ icon, tone, sentence, details: details.slice(0, MAX_DETAILS) });
    const reason = str(d.reason);
    if (reason) details.push(`Reason: ${reason}`);

    const roleName = e.target_role_name || nameOf(e.target_role_id, str(d.role_name) ?? str(d.name) ?? 'a role');
    const chanName = e.target_channel_name || nameOf(e.target_channel_id, str(d.name) ?? 'a channel');
    const channelLabel = (n: string) => `#${n}`;
    const catName = (id: unknown, alt = 'a category') => nameOf(id, alt);
    const containerName = (id: unknown) => (id === null || id === undefined || id === '' ? 'the top level' : `"${catName(id)}"`);

    switch (e.action) {
        // ── Members ──
        case 'member.join': return out('userPlus', 'ok', `${actor} joined the server`);
        case 'member.leave': return out('userMinus', 'neutral', `${actor} left the server`);
        case 'member.kick': return out('userMinus', 'danger', `${actor} kicked ${target}`);
        case 'member.ban': return out('ban', 'danger', `${actor} banned ${target}`);
        case 'member.unban': return out('ban', 'ok', `${actor} unbanned ${target}`);
        case 'member.mute': {
            const secs = num(d.duration_seconds);
            if (secs) details.unshift(`For ${fmtDuration(secs)}`);
            return out('mute', 'danger', `${actor} muted ${target}`);
        }
        case 'member.unmute': return out('mute', 'ok', `${actor} unmuted ${target}`);
        case 'member.nickname_set': {
            const before = str(d.before);
            const after = str(d.after);
            if (!after) return out('nickname', 'neutral', `${actor} cleared ${target}'s nickname`);
            if (before) details.unshift(`"${before}" to "${after}"`);
            return out('nickname', 'neutral', `${actor} changed ${target}'s nickname to "${after}"`);
        }
        case 'member.call_mute': {
            const track = str(d.track_type);
            const on = d.muted === true;
            const what = track === 'deafen' ? 'deafened' : track === 'video' ? 'turned off the camera of' : track === 'screenshare' ? 'stopped the screen share of' : 'muted';
            if (!on) {
                const un = track === 'deafen' ? 'undeafened' : track === 'video' ? 'allowed the camera of' : track === 'screenshare' ? 'allowed the screen share of' : 'unmuted';
                return out('mute', 'ok', `${actor} ${un} ${target} in calls`);
            }
            return out('mute', 'danger', `${actor} ${what} ${target} in calls`);
        }
        case 'member.role_added':
            return out('role', 'ok', `${actor} gave ${target} the ${roleName} role`);
        case 'member.role_removed':
            return out('role', 'danger', `${actor} removed the ${roleName} role from ${target}`);

        // ── Roles ──
        case 'role.create': {
            const n = str(d.name) ?? roleName;
            const p = strs(d.permissions);
            if (p.length) details.push(`Permissions: ${list(p)}`);
            if (d.hoisted === true) details.push('Shown separately in the member list');
            if (d.mentionable === true) details.push('Anyone can mention it');
            return out('role', 'ok', `${actor} created the role "${n}"`);
        }
        case 'role.update': {
            const n = str(d.name) ?? roleName;
            const before = obj(d.before);
            const after = obj(d.after);
            for (const k of Object.keys(after)) {
                if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
                if (k === 'name') details.push(`Name: "${String(before[k])}" to "${String(after[k])}"`);
                else if (k === 'color') details.push('Colour changed');
                else if (k === 'secondary_color') details.push(after[k] === -1 ? 'Gradient removed' : before[k] === -1 || before[k] === undefined ? 'Gradient added' : 'Gradient colour changed');
                else if (k === 'icon') details.push(roleIconChange(before[k], after[k]));
                else if (k === 'hoisted') details.push(after[k] ? 'Now shown separately in the member list' : 'No longer shown separately');
                else if (k === 'mentionable') details.push(after[k] ? 'Now mentionable by anyone' : 'No longer mentionable');
                else if (k === 'position') details.push('Moved in the role order');
                else if (k === 'permissions') details.push('Permissions changed');
            }
            if (strs(d.permissions_added).length) details.push(`Gained: ${list(strs(d.permissions_added))}`);
            if (strs(d.permissions_removed).length) details.push(`Lost: ${list(strs(d.permissions_removed))}`);
            return out('role', 'accent', `${actor} edited the role "${n}"`);
        }
        case 'role.delete': return out('role', 'danger', `${actor} deleted the role "${str(d.name) ?? roleName}"`);

        // ── Channels ──
        case 'channel.create': {
            const kind = str(d.kind) === 'huddle' ? 'Calls channel' : str(d.kind) === 'voice' ? 'voice channel' : 'channel';
            if (num(d.slowmode_seconds)) details.push(`Slowmode: ${slowmodeLabel(num(d.slowmode_seconds) ?? 0).toLowerCase()}`);
            if (d.age_restricted === true) details.push('Age-restricted (18+)');
            return out('hash', 'ok', `${actor} created the ${kind} ${channelLabel(str(d.name) ?? chanName)}`);
        }
        case 'channel.update': {
            const before = obj(d.before);
            const after = obj(d.after);
            const nowName = str(after.name) ?? chanName;
            const changed = Object.keys(after).filter(k => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
            const lines: string[] = [];
            for (const k of changed) {
                if (k === 'name') lines.push(`Renamed ${channelLabel(String(before.name))} to ${channelLabel(String(after.name))}`);
                else if (k === 'icon_name' || k === 'icon_emoji') lines.push('Icon changed');
                else if (k === 'topic') lines.push('Topic changed');
                else if (k === 'parent_category_id') lines.push(`Moved from ${containerName(before.parent_category_id)} to ${containerName(after.parent_category_id)}`);
                else if (k === 'position') lines.push('Moved in the list');
                else if (k === 'call_naming') lines.push('Call naming changed');
                else if (k === 'end_call_when_starter_leaves') lines.push(after[k] ? 'Calls now end when the starter leaves' : 'Calls no longer end when the starter leaves');
                else if (k === 'member_limit' || k === 'max_calls') lines.push('Limits changed');
                else if (k === 'slowmode_seconds') lines.push(num(after[k]) ? `Slowmode set to ${slowmodeLabel(num(after[k]) ?? 0).toLowerCase()}` : 'Slowmode turned off');
                else if (k === 'age_restricted') lines.push(after[k] ? 'Channel marked age-restricted (18+)' : 'Channel is no longer age-restricted');
            }
            const only = new Set(changed.map(k => (k === 'icon_name' || k === 'icon_emoji') ? 'icon' : k));
            if (only.size === 1 && only.has('name')) return out('hash', 'accent', `${actor} renamed ${channelLabel(String(before.name))} to ${channelLabel(String(after.name))}`);
            if (only.size === 1 && only.has('icon')) return out('hash', 'accent', `${actor} changed the icon of ${channelLabel(nowName)}`);
            if (only.size === 1 && only.has('parent_category_id')) return out('hash', 'accent', `${actor} moved ${channelLabel(nowName)} from ${containerName(before.parent_category_id)} to ${containerName(after.parent_category_id)}`);
            details.push(...lines);
            return out('hash', 'accent', `${actor} edited ${channelLabel(nowName)}`);
        }
        case 'channel.delete': {
            const extra = num(d.server_saved_destroyed);
            if (extra) details.push(`${extra} server-saved message${extra === 1 ? '' : 's'} removed with it`);
            return out('hash', 'danger', `${actor} deleted ${channelLabel(str(d.name) ?? chanName)}`);
        }
        case 'channel.reorder': {
            pushMoves(details, d, nameOf, containerName);
            const n = num(d.count);
            return out('layout', 'neutral', `${actor} reordered the channels${n ? ` (${n} listed)` : ''}`);
        }
        case 'channel.override.update': {
            overrideLines(details, d);
            return out('permissions', 'accent', `${actor} changed the permissions of ${overrideTarget(d, names)} on ${channelLabel(chanName)}`);
        }
        case 'channel.override.delete': {
            overrideLines(details, d);
            return out('permissions', 'neutral', `${actor} removed the permission override of ${overrideTarget(d, names)} on ${channelLabel(chanName)}`);
        }

        // ── Categories and sub-categories ──
        case 'category.create': return out('folder', 'ok', `${actor} created the category "${str(d.name) ?? catName(d.category_id)}"`);
        case 'category.update': return categoryEdit('category', actor, d, nameOf, details, out);
        case 'category.delete': {
            if (d.with_contents === true) {
                contentsLines(details, d);
                return out('folder', 'danger', `${actor} deleted the category "${str(d.name) ?? catName(d.category_id)}" and everything in it`);
            }
            const subs = num(d.promoted_subcategories);
            if (subs) details.push(`${subs} sub-categor${subs === 1 ? 'y' : 'ies'} moved up to the top level`);
            return out('folder', 'danger', `${actor} deleted the category "${str(d.name) ?? catName(d.category_id)}"`);
        }
        case 'category.reorder': {
            const cats = Array.isArray(d.categories) ? d.categories : [];
            for (const c of cats) { const n = str(obj(c).name); if (n) details.push(`Moved "${n}"`); }
            return out('layout', 'neutral', `${actor} reordered the categories`);
        }
        case 'category.override.update': {
            overrideLines(details, d);
            return out('permissions', 'accent', `${actor} changed the permissions of ${overrideTarget(d, names)} on the category "${catName(d.category_id)}"`);
        }
        case 'category.override.delete': {
            overrideLines(details, d);
            return out('permissions', 'neutral', `${actor} removed the permission override of ${overrideTarget(d, names)} on the category "${catName(d.category_id)}"`);
        }
        case 'subcategory.create': {
            const parent = containerName(d.parent_category_id);
            return out('folder', 'ok', `${actor} created the sub-category "${str(d.name) ?? catName(d.category_id, 'a sub-category')}" in ${parent}`);
        }
        case 'subcategory.update': return categoryEdit('sub-category', actor, d, nameOf, details, out);
        case 'subcategory.move': {
            const before = obj(d.before);
            const after = obj(d.after);
            const n = str(d.name) ?? str(after.name) ?? catName(d.category_id, 'a sub-category');
            const to = after.parent_category_id ?? null;
            const from = before.parent_category_id ?? null;
            if (str(before.name) && str(after.name) && before.name !== after.name) details.push(`Renamed from "${String(before.name)}"`);
            if (!to) return out('folder', 'accent', `${actor} moved the sub-category "${n}" out to the top level`);
            if (!from) return out('folder', 'accent', `${actor} made the category "${n}" a sub-category of ${containerName(to)}`);
            return out('folder', 'accent', `${actor} moved the sub-category "${n}" into ${containerName(to)}`);
        }
        case 'subcategory.delete': {
            if (d.with_contents === true) {
                contentsLines(details, d);
                return out('folder', 'danger', `${actor} deleted the sub-category "${str(d.name) ?? catName(d.category_id, 'a sub-category')}" and everything in it`);
            }
            const parent = str(d.parent_category_id);
            if (parent) details.push(`Its contents moved up into ${containerName(parent)}`);
            return out('folder', 'danger', `${actor} deleted the sub-category "${str(d.name) ?? catName(d.category_id, 'a sub-category')}"`);
        }

        // ── Dividers and the list layout ──
        case 'divider.create': return out('divider', 'ok', `${actor} created ${dividerName(d)}${panelNote(d)}`);
        case 'divider.update': {
            const before = obj(d.before);
            const after = obj(d.after);
            for (const k of Object.keys(after)) {
                if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue;
                if (k === 'label') details.push(`Label: "${String(before.label ?? '')}" to "${String(after.label ?? '')}"`);
                else if (k === 'style') details.push(`Style: ${String(before.style)} to ${String(after.style)}`);
                else if (k === 'color') details.push('Colour changed');
            }
            return out('divider', 'accent', `${actor} edited ${dividerName({ ...d, label: str(after.label) ?? d.label })}${panelNote(d)}`);
        }
        case 'divider.delete': return out('divider', 'danger', `${actor} deleted ${dividerName(d)}${panelNote(d)}`);
        case 'layout.update': {
            const moves = Array.isArray(d.moves) ? d.moves : [];
            const re = num(d.reordered);
            if (moves.length === 1 && num(d.moved) === 1) {
                const m = obj(moves[0]);
                const kind = m.kind === 'subcategory' ? 'sub-category' : m.kind === 'divider' ? 'divider' : 'channel';
                const nm = str(m.name) ?? `a ${kind}`;
                const shown = kind === 'channel' ? `#${nm}` : `"${nm}"`;
                if (re) details.push(`${re} other item${re === 1 ? '' : 's'} changed position`);
                return out('layout', 'accent', `${actor} moved the ${kind} ${shown} into ${containerName(m.to)}`);
            }
            pushMoves(details, d, nameOf, containerName);
            if (re) details.push(`${re} item${re === 1 ? '' : 's'} changed position`);
            return out('layout', 'neutral', `${actor} rearranged the channel list`);
        }

        // ── Server ──
        case 'server.update': {
            if (d.created === true) {
                return out('server', 'ok', `${actor} created the server${str(d.source) ? ' from a template' : ''}`);
            }
            const before = obj(d.before);
            const after = obj(d.after);
            for (const k of Object.keys(after)) {
                if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue;
                if (k === 'name') details.push(`Name: "${String(before.name)}" to "${String(after.name)}"`);
                else if (k === 'description') details.push('Description changed');
                else if (k === 'icon_attachment') details.push(after[k] ? 'Icon changed' : 'Icon removed');
                else if (k === 'banner_attachment') details.push(after[k] ? 'Banner changed' : 'Banner removed');
                else if (k === 'default_notification_level') details.push(`Default notifications: ${String(before[k])} to ${String(after[k])}`);
                else if (k === 'message_styles') details.push(`Message styles: ${messageStylesLabel(before[k])} to ${messageStylesLabel(after[k])}`);
                else if (k === 'system_channel_id') details.push(after[k] ? `System messages now go to ${channelLabel(nameOf(after[k], 'a channel'))}` : 'System messages turned off');
            }
            return out('server', 'accent', `${actor} changed the server settings`);
        }
        case 'server.transfer_ownership': {
            const prev = str(d.previous_owner_user_id);
            if (prev && names[prev]) details.push(`Previous owner: ${names[prev]}`);
            return out('crown', 'accent', `${actor} transferred ownership to ${target}`);
        }

        // ── Invites, emojis ──
        case 'invite.create': {
            const max = num(d.max_uses);
            if (max) details.push(`${max} use${max === 1 ? '' : 's'} allowed`);
            if (str(d.expires_at)) details.push('Expires');
            return out('link', 'ok', `${actor} created an invite link`);
        }
        case 'invite.delete': return out('link', 'danger', `${actor} deleted an invite link`);
        case 'emoji.create': return out('smile', 'ok', `${actor} added the emoji :${str(d.name) ?? 'emoji'}:`);
        case 'emoji.update': return out('smile', 'accent', `${actor} renamed the emoji :${str(d.before) ?? 'emoji'}: to :${str(d.after) ?? 'emoji'}:`);
        case 'emoji.delete': return out('smile', 'danger', `${actor} deleted the emoji :${str(d.name) ?? 'emoji'}:`);

        // ── Pins and server saves (never their content) ──
        case 'channel.pin.create': return out('pin', 'neutral', `${actor} pinned a message in ${channelLabel(chanName)}`);
        case 'channel.pin.delete': return out('pin', 'neutral', `${actor} unpinned a message in ${channelLabel(chanName)}`);
        case 'channel.pin.autoremove_on_delete': return out('pin', 'neutral', `A pin in ${channelLabel(chanName)} was removed with its message`);
        case 'channel.save.create': return out('save', 'neutral', `${actor} saved a message to the server in ${channelLabel(chanName)}`);
        case 'channel.save.delete': return out('save', 'neutral', `${actor} removed a server-saved message in ${channelLabel(chanName)}`);

        // ── Message-history import (counts only, never content) ──
        case 'import.start': {
            const n = typeof d.channels === 'number' ? d.channels : null;
            return out('save', 'accent', `${actor} started importing message history${n !== null ? ` into ${n} channel${n === 1 ? '' : 's'}` : ''}`);
        }
        case 'import.complete': {
            const n = typeof d.rows === 'number' ? d.rows : null;
            return out('save', 'ok', `${actor} finished importing message history${n !== null ? ` (${n.toLocaleString()} message${n === 1 ? '' : 's'})` : ''}`);
        }
        case 'import.cancel': {
            const n = typeof d.deleted === 'number' ? d.deleted : 0;
            return out('save', 'danger', `${actor} stopped a message import${n > 0 ? ` and deleted ${n.toLocaleString()} imported message${n === 1 ? '' : 's'}` : ''}`);
        }
        case 'import.save': {
            const n = typeof d.count === 'number' ? d.count : 0;
            return out(d.pinned ? 'pin' : 'save', 'neutral', `${actor} ${d.pinned ? 'saved and pinned' : 'saved'} ${n.toLocaleString()} imported message${n === 1 ? '' : 's'} in ${channelLabel(chanName)}`);
        }

        // ── Calls ──
        case 'huddle.call.spawn': return out('phone', 'ok', `${actor} started a call${str(d.name) ? ` "${String(d.name)}"` : ''} in ${channelLabel(chanName)}`);
        case 'huddle.call.rename': return out('phone', 'neutral', `${actor} renamed a call in ${channelLabel(chanName)} to "${str(d.after) ?? 'a new name'}"`);
        case 'huddle.call.destroy': {
            const r = str(d.reason);
            if (r) details.push(`Reason: ${r.replace(/_/g, ' ')}`);
            return out('phone', 'danger', `A call in ${channelLabel(chanName)} was ended${e.actor_username ? ` by ${actor}` : ''}`);
        }
        case 'huddle.member.move': return out('phone', 'neutral', `${actor} moved ${target} into a call in ${channelLabel(chanName)}`);
        case 'huddle.member.disconnect': return out('phone', 'danger', `${actor} disconnected ${target} from a call in ${channelLabel(chanName)}`);

        default:
            return fallback(e);
    }
}

// ── Shared pieces ─────────────────────────────────────────────────────────

function dividerName(d: Obj): string {
    const label = str(d.label);
    return label ? `the divider "${label}"` : 'a divider';
}

function panelNote(d: Obj): string {
    return d.list_kind === 'calls' ? ' in the Calls panel' : '';
}

function overrideTarget(d: Obj, names: Record<string, string>): string {
    const id = str(d.target_id);
    const kind = d.target_kind === 'member' ? 'member' : 'role';
    const nm = id ? names[id] : undefined;
    if (kind === 'member') return nm ?? 'a member';
    return nm ? `the ${nm} role` : 'a role';
}

function overrideLines(details: string[], d: Obj): void {
    const allow = strs(d.allow_names);
    const deny = strs(d.deny_names);
    if (allow.length) details.push(`Allowed: ${list(allow)}`);
    if (deny.length) details.push(`Denied: ${list(deny)}`);
    const bAllow = strs(d.before_allow_names);
    const bDeny = strs(d.before_deny_names);
    if (bAllow.length || bDeny.length) {
        const parts: string[] = [];
        if (bAllow.length) parts.push(`allowed ${list(bAllow)}`);
        if (bDeny.length) parts.push(`denied ${list(bDeny)}`);
        details.push(`Before: ${parts.join('; ')}`);
    }
}

function pushMoves(
    details: string[], d: Obj,
    nameOf: (id: unknown, alt: string) => string,
    containerName: (id: unknown) => string,
): void {
    const moves = Array.isArray(d.moves) ? d.moves : [];
    for (const raw of moves) {
        const m = obj(raw);
        const kind = m.kind === 'subcategory' ? 'sub-category' : m.kind === 'divider' ? 'divider' : 'channel';
        const nm = str(m.name) ?? nameOf(m.id, `a ${kind}`);
        const shown = kind === 'channel' ? `#${nm}` : `"${nm}"`;
        details.push(`Moved ${kind} ${shown} from ${containerName(m.from)} to ${containerName(m.to)}`);
    }
    const total = num(d.moved);
    if (total && total > moves.length) details.push(`...and ${total - moves.length} more`);
}

/** What a "delete with contents" took with it: counts, then the channel names. */
function contentsLines(details: string[], d: Obj): void {
    const parts = [
        [num(d.channels_deleted), 'channel', 'channels'],
        [num(d.subcategories_deleted), 'sub-category', 'sub-categories'],
        [num(d.dividers_deleted), 'divider', 'dividers'],
    ] as const;
    const said = parts.filter(([n]) => !!n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    if (said.length) details.push(`Deleted ${said.join(', ')}`);
    const chans = Array.isArray(d.channels) ? d.channels : [];
    for (const c of chans) { const n = str(obj(c).name); if (n) details.push(`#${n}`); }
    if (d.truncated === true) details.push('…and more');
    const saved = num(d.server_saved_destroyed);
    if (saved) details.push(`${saved} server-saved message${saved === 1 ? '' : 's'} destroyed`);
    const calls = num(d.calls_ended);
    if (calls) details.push(`${calls} live call${calls === 1 ? '' : 's'} ended`);
}

function categoryEdit(
    kind: 'category' | 'sub-category', actor: string, d: Obj,
    nameOf: (id: unknown, alt: string) => string,
    details: string[],
    out: (icon: AuditIcon, tone: AuditTone, sentence: string) => AuditDescription,
): AuditDescription {
    const before = obj(d.before);
    const after = obj(d.after);
    const now = str(d.name) ?? str(after.name) ?? nameOf(d.category_id, `a ${kind}`);
    if (str(before.name) && str(after.name) && before.name !== after.name) {
        return out('folder', 'accent', `${actor} renamed the ${kind} "${String(before.name)}" to "${String(after.name)}"`);
    }
    if (JSON.stringify(before.icon_name ?? null) !== JSON.stringify(after.icon_name ?? null)) details.push('Icon changed');
    // Divider categories: the header look.
    const styleBefore = str(before.header_style);
    const styleAfter = str(after.header_style);
    if (!styleBefore && styleAfter) details.push(`Now a divider category (${styleAfter} style)`);
    else if (styleBefore && !styleAfter) details.push('Now an ordinary category');
    else if (styleBefore && styleAfter && styleBefore !== styleAfter) details.push(`Divider style changed from ${styleBefore} to ${styleAfter}`);
    if (styleBefore && styleAfter && JSON.stringify(before.header_color ?? null) !== JSON.stringify(after.header_color ?? null)) details.push('Divider colour changed');
    return out('folder', 'accent', `${actor} edited the ${kind} "${now}"`);
}
