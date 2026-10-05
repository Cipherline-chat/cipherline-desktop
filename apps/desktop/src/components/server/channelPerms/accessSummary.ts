/**
 * Glue between the draft (what the editor holds) and the resolver preview
 * (what it means), plus the one-line "who can see / who can post" summary
 * the quick-create screen shows under the preset picker.
 */

import { Permissions } from '@cipherline/shared';
import type { ChannelKind } from '../roles/permissions';
import { resolveEffective, type PermOverride, type PermTier, type ResolveContext } from './effectivePermissions';
import { parseKey, type DraftMap } from './overrideDraft';

/** The editor's draft as a resolver tier. `omitKey` drops one target — that
 *  is exactly "what would this target get if it were left on Inherit". */
export const tierFromDraft = (
    kind: PermTier['kind'],
    label: string,
    draft: DraftMap,
    omitKey?: string,
): PermTier => ({
    kind,
    label,
    overrides: Object.entries(draft)
        .filter(([k]) => k !== omitKey)
        .map(([k, b]): PermOverride => ({ ...parseKey(k), allow: b.allow, deny: b.deny })),
});

export interface AccessSummary {
    /** 'everyone', or the display names of the roles that get it (highest first). */
    see: 'everyone' | string[];
    /** Post (text) / speak (Calls), among those who can see. */
    talk: 'everyone' | string[];
    /** Members given access by a member override, by count. */
    memberGrants: number;
    /** Roles with ADMINISTRATOR (see everything regardless). */
    admins: string[];
}

/**
 * Who can see / talk, resolved per role through the SAME resolver as the
 * editor rows — so the summary can never disagree with them.
 *
 * "Everyone" means the @everyone role alone gets it (a member with no roles).
 */
export function summarizeAccess(ctx: ResolveContext, kind: ChannelKind): AccessSummary {
    const seeBits = kind === 'huddle' ? Permissions.VIEW_CHANNEL | Permissions.CONNECT : Permissions.VIEW_CHANNEL;
    const talkBit = kind === 'huddle' ? Permissions.SPEAK : Permissions.SEND_MESSAGES;
    const everyone = ctx.roles.find(r => r.is_everyone);
    const others = [...ctx.roles].filter(r => !r.is_everyone).sort((a, b) => b.position - a.position);

    const admins: string[] = [];
    const see: string[] = [];
    const talk: string[] = [];
    for (const r of others) {
        const res = resolveEffective(ctx, { kind: 'role', roleId: r.role_id });
        if (res.shortCircuit === 'admin') { admins.push(r.name); continue; }
        if (res.has(seeBits)) {
            see.push(r.name);
            if (res.has(talkBit)) talk.push(r.name);
        }
    }
    const ev = everyone ? resolveEffective(ctx, { kind: 'role', roleId: everyone.role_id }) : null;
    const evSees = !!ev && ev.has(seeBits);
    const evTalks = evSees && !!ev && ev.has(talkBit);

    const lastTier = ctx.tiers[ctx.tiers.length - 1];
    const memberGrants = lastTier
        ? lastTier.overrides.filter(o => o.target_kind === 'member' && (o.allow & Permissions.VIEW_CHANNEL) !== 0n).length
        : 0;

    return {
        see: evSees ? 'everyone' : see,
        talk: evTalks ? 'everyone' : talk,
        memberGrants,
        admins,
    };
}

/** Human line, e.g. "Visible to @Moderator, @Helper and admins · only @Moderator can post". */
export function describeAccess(s: AccessSummary, kind: ChannelKind): string {
    const verb = kind === 'huddle' ? 'talk' : 'post';
    const list = (names: string[]) => names.map(n => (n.startsWith('@') ? n : `@${n}`));
    const join = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

    if (s.see === 'everyone') {
        if (s.talk === 'everyone') return `Everyone can see it and ${verb}`;
        const who = [...list(s.talk), ...(s.admins.length ? ['admins'] : [])];
        return `Everyone can see it · only ${who.length ? join(who) : 'admins'} can ${verb}`;
    }
    const who = [
        ...list(s.see),
        ...(s.memberGrants ? [`${s.memberGrants} member${s.memberGrants === 1 ? '' : 's'}`] : []),
        ...(s.admins.length ? ['admins'] : []),
    ];
    const base = `Private — visible to ${who.length ? join(who) : 'the owner only'}`;
    if (s.talk === 'everyone') return base;
    const talkers = Array.isArray(s.talk) ? s.talk : [];
    const seers = Array.isArray(s.see) ? s.see : [];
    if (talkers.length === seers.length) return base;
    return `${base} · only ${talkers.length ? join(list(talkers)) : 'admins'} can ${verb}`;
}
