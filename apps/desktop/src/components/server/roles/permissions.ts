/**
 * Permission tables used by role editors. Grouping here drives the visual
 * sections in the permissions sub-tab.
 *
 * The BITS are imported from `@cipherline/shared`, never re-declared. This file
 * used to spell every bit out again as a literal (`bit: 1n << 21n`), which is a
 * silent-drift hazard: the shared contract is the thing the API resolves
 * against, so a local literal that disagrees with it mislabels a chip and the
 * type checker has nothing to say about it. Keying off `Permissions[key]`
 * makes a typo'd or renamed permission a compile error instead.
 */

import { Permissions, type PermissionKey } from '@cipherline/shared';

/** The two channel shapes a permission override editor exists for. */
export type ChannelKind = 'text' | 'huddle';

/** Where a permission sits inside the channel override editor. */
export type ChannelPermSection = 'access' | 'participate' | 'moderate';

export interface PermissionDescriptor {
    key: PermissionKey;
    label: string;
    bit: bigint;
    danger?: boolean;
    description?: string;
    // ── Channel override editor metadata ──────────────────────────────────
    // A descriptor appears in a channel/category override editor when its
    // GROUP lists that channel kind (see PermissionGroup.channelKinds) or it
    // opts in itself here. The group path is deliberately the default: a new
    // permission added to the "Text Channels" or "Voice & Calls" group shows
    // up in the channel editors with no further edits.
    /** Opt this descriptor into channel kinds its group does not cover. */
    channelKinds?: ChannelKind[];
    /** Opt OUT: the bit sits in a channel group but is only ever checked
     *  server-wide (`requireServerPermission`), so a channel override on it
     *  would silently do nothing. */
    serverOnly?: boolean;
    /** Editor section; defaults to 'participate'. */
    channelSection?: ChannelPermSection;
    /** Per-kind wording where the role-editor label reads wrong in a channel. */
    channelLabel?: Partial<Record<ChannelKind, string>>;
    channelDescription?: Partial<Record<ChannelKind, string>>;
}

export interface PermissionGroup {
    title: string;
    permissions: PermissionDescriptor[];
    /** Channel kinds whose override editor shows this whole group. */
    channelKinds?: ChannelKind[];
}

/** All server-wide + channel + voice permissions shown in the role editor,
 *  grouped under headings for visual scannability. */
export const PERMISSION_GROUPS: PermissionGroup[] = [
    {
        title: 'General Server',
        permissions: [
            { key: 'ADMINISTRATOR',   label: 'Administrator',   bit: Permissions.ADMINISTRATOR, danger: true,
              description: 'Bypasses every other permission. Grant only to fully trusted roles.' },
            { key: 'MANAGE_SERVER',   label: 'Manage Server',   bit: Permissions.MANAGE_SERVER,
              description: 'Edit server name, icon, banner.' },
            { key: 'MANAGE_ROLES',    label: 'Manage Roles',    bit: Permissions.MANAGE_ROLES,
              description: 'Create, edit, delete, and assign roles below their own.' },
            { key: 'MANAGE_CHANNELS', label: 'Manage Channels', bit: Permissions.MANAGE_CHANNELS,
              description: 'Create, edit, delete channels & categories.',
              // Per-channel only for Calls: renameCall / destroyCall check it
              // with requireChannelPermission. Channel CRUD checks it server-wide.
              channelKinds: ['huddle'], channelSection: 'moderate',
              channelLabel: { huddle: 'Manage Calls' },
              channelDescription: { huddle: 'Rename or end calls in this channel.' } },
            { key: 'VIEW_AUDIT_LOG',  label: 'View Audit Log',  bit: Permissions.VIEW_AUDIT_LOG,
              description: 'Read the moderation history.' },
            { key: 'CREATE_INVITE',   label: 'Create Invite',   bit: Permissions.CREATE_INVITE,
              description: 'Generate invite links to this server.' },
            { key: 'MANAGE_EMOJIS',   label: 'Manage Emojis',   bit: Permissions.MANAGE_EMOJIS,
              description: 'Add, rename, and delete this server\'s custom emojis.' },
        ],
    },
    {
        title: 'Membership',
        permissions: [
            { key: 'KICK_MEMBERS',     label: 'Kick Members',      bit: Permissions.KICK_MEMBERS,
              description: 'Remove members from the server.' },
            { key: 'BAN_MEMBERS',      label: 'Ban Members',       bit: Permissions.BAN_MEMBERS,
              description: 'Permanently remove members and prevent re-joining.' },
            { key: 'MUTE_MEMBERS',     label: 'Mute Members (Text)', bit: Permissions.MUTE_MEMBERS,
              description: 'Server-wide text timeout — disables sending messages.' },
            { key: 'CHANGE_NICKNAME',  label: 'Change Own Nick',   bit: Permissions.CHANGE_NICKNAME,
              description: 'Change your own nickname on this server.' },
            { key: 'MANAGE_NICKNAMES', label: 'Manage Nicknames',  bit: Permissions.MANAGE_NICKNAMES,
              description: "Edit other members' nicknames." },
        ],
    },
    {
        title: 'Text Channels',
        channelKinds: ['text'],
        permissions: [
            { key: 'VIEW_CHANNEL',         label: 'View Channels',        bit: Permissions.VIEW_CHANNEL,
              description: 'See text channels.',
              channelKinds: ['huddle'], channelSection: 'access',
              channelLabel: { text: 'View Channel', huddle: 'View Calls Channel' },
              channelDescription: {
                  text: 'See this channel in the list.',
                  huddle: 'See this Calls channel and who is in its calls.',
              } },
            { key: 'SEND_MESSAGES',        label: 'Send Messages',        bit: Permissions.SEND_MESSAGES,
              channelDescription: { text: 'Post messages.' } },
            { key: 'MANAGE_MESSAGES',      label: 'Manage Messages',      bit: Permissions.MANAGE_MESSAGES,
              description: "Delete others' messages, and pin messages (pinning also saves the message to the server).", channelSection: 'moderate' },
            { key: 'SAVE_MESSAGES',        label: 'Save Messages to Server', bit: Permissions.SAVE_MESSAGES,
              description: 'Save messages to server — keep a message permanently instead of deleting it after 30 days. Saved messages count toward the server\'s storage.',
              channelSection: 'moderate',
              channelDescription: { text: 'Keep a message permanently instead of deleting it after 30 days.' } },
            { key: 'EMBED_LINKS',          label: 'Embed Links',          bit: Permissions.EMBED_LINKS,
              channelDescription: { text: 'Show link previews.' } },
            { key: 'ATTACH_FILES',         label: 'Attach Files',         bit: Permissions.ATTACH_FILES,
              channelDescription: { text: 'Upload files and images.' } },
            { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', bit: Permissions.READ_MESSAGE_HISTORY,
              channelSection: 'access',
              channelDescription: { text: 'Read messages sent before they opened the channel.' } },
            { key: 'MENTION_EVERYONE',     label: 'Mention @everyone',    bit: Permissions.MENTION_EVERYONE,
              description: 'Notify everyone or all online members at once.' },
            { key: 'ADD_REACTIONS',        label: 'Add Reactions',        bit: Permissions.ADD_REACTIONS,
              channelDescription: { text: 'React to messages.' } },
        ],
    },
    {
        title: 'Voice & Calls',
        channelKinds: ['huddle'],
        permissions: [
            { key: 'CONNECT',          label: 'Connect',          bit: Permissions.CONNECT,
              description: 'Join voice channels and Calls-channel calls.', channelSection: 'access',
              channelDescription: { huddle: 'Join or start calls in this channel.' } },
            { key: 'SPEAK',            label: 'Speak',            bit: Permissions.SPEAK,
              channelDescription: { huddle: 'Unmute their microphone.' } },
            { key: 'VIDEO',            label: 'Video',            bit: Permissions.VIDEO,
              channelDescription: { huddle: 'Turn their camera on.' } },
            { key: 'SCREEN_SHARE',     label: 'Screen Share',     bit: Permissions.SCREEN_SHARE,
              channelDescription: { huddle: 'Share their screen.' } },
            { key: 'ANNOTATE',         label: 'Annotate',         bit: Permissions.ANNOTATE,
              description: 'Ask to draw on a camera or screen share during a call. The person streaming still has to approve each request.' },
            { key: 'PRIORITY_SPEAKER', label: 'Priority Speaker', bit: Permissions.PRIORITY_SPEAKER,
              description: "Lowers others' volume while you speak.", channelSection: 'moderate' },
            // Both are checked server-wide only (moderation.service /
            // huddles.service → requireServerPermission), so a per-channel
            // override on either would silently do nothing.
            { key: 'DEAFEN_MEMBERS',   label: 'Deafen Members',   bit: Permissions.DEAFEN_MEMBERS, serverOnly: true,
              description: "Server-mute a participant's audio, video, or screen share in voice calls." },
            { key: 'MOVE_MEMBERS',     label: 'Move Members',     bit: Permissions.MOVE_MEMBERS, serverOnly: true,
              description: 'Drag someone from one call into another — even a full one. They still need Connect on the destination.' },
        ],
    },
];

/** Flat list — used as a backing array when iteration order matters. */
export const SERVER_PERMISSIONS: PermissionDescriptor[] =
    PERMISSION_GROUPS.flatMap(g => g.permissions);

// ──────────────────────────────────────────────────────────────────────────
// Channel / category override editor tables — DERIVED, never hand-listed.
//
// These used to be three separate hand-written lists (here, and one inside
// each of the two channel dialogs) that had already drifted: the dialogs'
// Calls list silently lacked ANNOTATE. Deriving them from PERMISSION_GROUPS
// means a permission added to a channel group reaches every override editor.
// ──────────────────────────────────────────────────────────────────────────

/** One row of the channel override editor. */
export interface ChannelPermRow {
    key: PermissionKey;
    bit: bigint;
    label: string;
    description?: string;
    section: ChannelPermSection;
}

export interface ChannelPermSectionGroup {
    section: ChannelPermSection;
    title: string;
    permissions: ChannelPermRow[];
}

const SECTION_ORDER: ChannelPermSection[] = ['access', 'participate', 'moderate'];
const SECTION_TITLES: Record<ChannelKind, Record<ChannelPermSection, string>> = {
    text:   { access: 'Access', participate: 'Messaging', moderate: 'Moderation' },
    huddle: { access: 'Access', participate: 'In a call', moderate: 'Moderation' },
};

const appliesToKind = (group: PermissionGroup, p: PermissionDescriptor, kind: ChannelKind): boolean => {
    if (p.serverOnly) return false;
    return !!group.channelKinds?.includes(kind) || !!p.channelKinds?.includes(kind);
};

/** The override editor's rows for one channel kind, in role-editor order. */
export const channelPermissionRows = (kind: ChannelKind): ChannelPermRow[] => {
    const out: ChannelPermRow[] = [];
    const seen = new Set<string>();
    for (const g of PERMISSION_GROUPS) {
        for (const p of g.permissions) {
            if (!appliesToKind(g, p, kind) || seen.has(p.key)) continue;
            seen.add(p.key);
            out.push({
                key: p.key,
                bit: p.bit,
                label: p.channelLabel?.[kind] ?? p.label,
                description: p.channelDescription?.[kind] ?? p.description,
                section: p.channelSection ?? 'participate',
            });
        }
    }
    return out;
};

/** The same rows bucketed into the editor's sections (empty sections dropped). */
export const channelPermissionSections = (kind: ChannelKind): ChannelPermSectionGroup[] => {
    const rows = channelPermissionRows(kind);
    return SECTION_ORDER
        .map(section => ({
            section,
            title: SECTION_TITLES[kind][section],
            permissions: rows.filter(r => r.section === section),
        }))
        .filter(g => g.permissions.length > 0);
};

/** Every bit the editor for this kind shows — the scope of "Allow all" etc. */
export const channelPermissionMask = (kind: ChannelKind): bigint =>
    channelPermissionRows(kind).reduce((m, r) => m | r.bit, 0n);

/** Flat text-channel list (derived; kept for older callers and tests). */
export const TEXT_CHANNEL_PERMS: { key: PermissionKey; label: string; bit: bigint }[] =
    channelPermissionRows('text').map(({ key, label, bit }) => ({ key, label, bit }));

/** Flat Calls-channel list (derived; kept for older callers and tests). */
export const VOICE_CHANNEL_PERMS: { key: PermissionKey; label: string; bit: bigint }[] =
    channelPermissionRows('huddle').map(({ key, label, bit }) => ({ key, label, bit }));

/** 3-state override: allow overrides deny; neutral inherits from role. */
export type Override3 = 'allow' | 'deny' | 'neutral';

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers for the permissions editor.
//
// These are split out of the component so the bit arithmetic is unit-testable
// without a DOM. All of it is bigint: the shared contract already uses bits up
// to 29 and reserves room to 63, and JS bitwise operators (`|`, `&`, `~`, `<<`)
// coerce their operands to SIGNED 32-bit — so doing any of this on `number`
// would silently corrupt CONNECT(24) … ANNOTATE(29) and break outright at 31.
// Never widen these signatures to `number`.
// ──────────────────────────────────────────────────────────────────────────

/** Flip one bit in a role's own permission bitfield. */
export const togglePermissionBit = (bits: bigint, bit: bigint): bigint =>
    (bits & bit) === bit ? bits & ~bit : bits | bit;

/**
 * How one permission chip should read for a given role.
 *
 * The API resolves a member's server permissions as a plain OR of @everyone
 * plus every role they hold (`PermissionsService.resolveServerPermissions`), so
 * these three facts are genuinely independent and all three matter to the
 * person editing the role:
 *
 *  - `own`         — this role's OWN bitfield grants it. This is the only thing
 *                    the editor can actually change, so it is what the chip's
 *                    on/off state must show.
 *  - `viaEveryone` — @everyone grants it, so every member already has it. Since
 *                    resolution is an OR, clearing `own` will NOT take it away;
 *                    that needs a per-channel deny override or an edit to
 *                    @everyone itself.
 *  - `effective`   — what members of this role end up with.
 *
 * The editor used to conflate all three into one "enabled" boolean AND refuse
 * to toggle anything with `viaEveryone`, which made a permission the role
 * explicitly holds indistinguishable from one it does not, and left ~13 of the
 * 28 chips (every `DEFAULT_EVERYONE_PERMISSIONS` bit) permanently unclickable.
 */
export interface PermissionChipState {
    own: boolean;
    viaEveryone: boolean;
    effective: boolean;
}

export const permissionChipState = (
    roleBits: bigint,
    everyoneBits: bigint,
    bit: bigint,
    isEveryoneRole: boolean,
): PermissionChipState => {
    const own = (roleBits & bit) === bit;
    // The @everyone role IS the base, so nothing is "inherited" when editing it.
    const viaEveryone = !isEveryoneRole && (everyoneBits & bit) === bit;
    return { own, viaEveryone, effective: own || viaEveryone };
};

/** Per-group tallies for the section header counter. */
export const countGroup = (
    group: PermissionGroup,
    roleBits: bigint,
    everyoneBits: bigint,
    isEveryoneRole: boolean,
): { own: number; viaEveryoneOnly: number; total: number } => {
    let own = 0;
    let viaEveryoneOnly = 0;
    for (const p of group.permissions) {
        const s = permissionChipState(roleBits, everyoneBits, p.bit, isEveryoneRole);
        if (s.own) own++;
        else if (s.viaEveryone) viaEveryoneOnly++;
    }
    return { own, viaEveryoneOnly, total: group.permissions.length };
};

/** Parse a wire-format permission bitfield, defaulting to none. */
export const parsePermissions = (s: string | null | undefined): bigint => {
    if (!s) return 0n;
    try { return BigInt(s); } catch { return 0n; }
};
