// Server permissions bitfield — Discord-style.
//
// One source of truth shared between API and desktop. The wire format is a
// bigint stringified as a decimal string (Postgres `bigint`, JS `BigInt`).
// 32 bits used today; the field is bigint so we can grow to 64 without a
// migration when we add things like `MANAGE_THREADS`, `USE_APPLICATION`, etc.
//
// Layout:
//   0–15  : server-wide permissions (apply across the whole server)
//   16–23 : per-channel permissions (resolved against ChannelOverride)
//   24–31 : voice-channel permissions (31 = START_CALLS)
//   30    : SAVE_MESSAGES — a per-channel permission that lives here only
//           because the 16–23 block is full. The ranges are documentation;
//           the resolver applies overrides to every bit alike.
//
// `ADMINISTRATOR` is the trump card — anyone with that bit (or the server
// owner role) bypasses every other check. Keep it gated behind `MANAGE_ROLES`
// so only a server admin can grant it.

const PermissionBits = {
    // Server-wide (bits 0–15)
    ADMINISTRATOR:        1n << 0n,   // bypass all checks; trump card
    MANAGE_SERVER:        1n << 1n,   // edit name / icon / banner
    MANAGE_ROLES:         1n << 2n,   // create/edit/assign roles below own highest
    MANAGE_CHANNELS:      1n << 3n,   // create/edit/delete channels + overrides
    KICK_MEMBERS:         1n << 4n,
    BAN_MEMBERS:          1n << 5n,
    CREATE_INVITE:        1n << 6n,
    MUTE_MEMBERS:         1n << 7n,   // server-wide text timeout
    VIEW_AUDIT_LOG:       1n << 8n,
    CHANGE_NICKNAME:      1n << 9n,   // own nickname
    MANAGE_NICKNAMES:     1n << 10n,  // others' nicknames
    // Bits 11 and 12 were DEAFEN_MEMBERS / MOVE_MEMBERS. They were RENAMED, not
    // moved: the bit values are what roles and channel overrides store, so
    // every stored grant keeps working. The old names live on as deprecated
    // aliases below (see "Deprecated aliases").
    //
    // MODERATE_CALL_MEDIA — the four media controls in a call participant's
    // menu: Server Mute, Server Deafen, Disable Video, Disable Screen Share.
    // (It was "Deafen Members", which only named one of the four.)
    MODERATE_CALL_MEDIA:  1n << 11n,
    // MANAGE_CALL_MEMBERS — move a member between calls AND disconnect them
    // from a call. (It was "Move Members".)
    MANAGE_CALL_MEMBERS:  1n << 12n,
    // Add, rename, and delete this server's custom emojis. Deliberately
    // separate from MANAGE_SERVER so emoji curation can be delegated
    // without also handing over the server's name/icon/banner.
    // USING an emoji needs nothing new — SEND_MESSAGES and ADD_REACTIONS
    // already gate posting and reacting.
    MANAGE_EMOJIS:        1n << 13n,

    // Per-channel (bits 16–23) — resolved against ChannelOverride allow/deny
    VIEW_CHANNEL:         1n << 16n,
    SEND_MESSAGES:        1n << 17n,
    MANAGE_MESSAGES:      1n << 18n,  // pin / delete others' messages (pinning also server-saves)
    EMBED_LINKS:          1n << 19n,
    ATTACH_FILES:         1n << 20n,
    READ_MESSAGE_HISTORY: 1n << 21n,
    MENTION_EVERYONE:     1n << 22n,
    ADD_REACTIONS:        1n << 23n,

    // Voice (bits 24–31)
    CONNECT:              1n << 24n,  // join voice channel
    SPEAK:                1n << 25n,  // unmute mic
    VIDEO:                1n << 26n,
    SCREEN_SHARE:         1n << 27n,
    PRIORITY_SPEAKER:     1n << 28n,
    // May REQUEST to annotate (draw on) a camera or screen share in this
    // channel's calls. The streamer's per-person grant is still required;
    // this bit only gates who can ask. See docs/video-annotation-design.md.
    ANNOTATE:             1n << 29n,

    // Per-channel (overflow — see the layout note above).
    // Server-save a channel message: keep it permanently instead of letting
    // it expire 30 days after it was sent. Separate from MANAGE_MESSAGES
    // (which gates PIN) so saving can be delegated without handing over
    // moderator deletes. Pinning still saves on its own — every pinned
    // message is saved — so MANAGE_MESSAGES alone can pin (and thereby save)
    // but cannot save or unsave an unpinned message.
    SAVE_MESSAGES:        1n << 30n,

    // Voice (continued). START a new call in a Calls channel — spawning a
    // fresh call session (POST /huddles/:hid/calls, and a moderator's
    // move-into-an-empty-Calls-channel, which spawns one). Distinct from
    // CONNECT, which still gates JOINING a call that is already running: a
    // member with CONNECT but not START_CALLS can hop into any live call but
    // cannot open a new one. Both are required to start. Persistent voice
    // channels are NOT affected — they are always-on rooms, and CONNECT alone
    // still gets you in (see docs/start-calls-permission.md).
    //
    // Backward compatibility: until apps/api/src/migrations/sql/
    // 20261012-start-calls-permission-backfill.sql has run, the API treats
    // every member's START_CALLS as equal to their CONNECT (the old rule),
    // so rolling the code before the SQL locks nobody out.
    START_CALLS:          1n << 31n,
} as const;

// ── Deprecated aliases ──────────────────────────────────────────────────────
// `MOVE_MEMBERS` and `DEAFEN_MEMBERS` are the pre-rename names for bits 12 and
// 11. They resolve to exactly the same bigint, so older code, tests and the
// mobile client keep compiling and keep meaning the same thing.
//
// They are defined NON-ENUMERABLE on purpose: `Permissions` is iterated
// (ALL_PERMISSIONS below, the role editor's one-chip-per-bit grid, "who holds
// this bit" checks), and an enumerable alias would make every bit appear twice.
// Property access (`Permissions.MOVE_MEMBERS`) is unaffected. New code must use
// MANAGE_CALL_MEMBERS / MODERATE_CALL_MEDIA.
type DeprecatedPermissionAliases = {
    /** @deprecated Renamed to `MANAGE_CALL_MEMBERS` (same bit, 1n << 12n). */
    readonly MOVE_MEMBERS: bigint;
    /** @deprecated Renamed to `MODERATE_CALL_MEDIA` (same bit, 1n << 11n). */
    readonly DEAFEN_MEMBERS: bigint;
};

export const Permissions: typeof PermissionBits & DeprecatedPermissionAliases =
    Object.defineProperties({ ...PermissionBits } as typeof PermissionBits, {
        MOVE_MEMBERS:   { value: PermissionBits.MANAGE_CALL_MEMBERS, enumerable: false },
        DEAFEN_MEMBERS: { value: PermissionBits.MODERATE_CALL_MEDIA, enumerable: false },
    }) as typeof PermissionBits & DeprecatedPermissionAliases;

/** The canonical permission names — one per bit. The deprecated aliases are
 *  deliberately not part of this type. */
export type PermissionKey = keyof typeof PermissionBits;

// Compute ALL_PERMISSIONS as the OR of every defined bit. Anyone holding this
// (e.g. ADMINISTRATOR or the server owner) is treated as having every right.
export const ALL_PERMISSIONS: bigint = Object.values(Permissions)
    .reduce((acc, bit) => acc | bit, 0n);

// Default permissions assigned to the auto-created `@everyone` role on
// server creation. Mirrors Discord's defaults: members can view, talk, react,
// connect to voice, and change their own nickname. They CANNOT manage roles,
// channels, kick/ban, or mention @everyone — those bits must be granted
// explicitly via a custom role or override.
export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
    Permissions.VIEW_CHANNEL
    | Permissions.SEND_MESSAGES
    | Permissions.READ_MESSAGE_HISTORY
    | Permissions.ADD_REACTIONS
    | Permissions.EMBED_LINKS
    | Permissions.ATTACH_FILES
    | Permissions.CHANGE_NICKNAME
    | Permissions.CONNECT
    | Permissions.START_CALLS
    | Permissions.SPEAK
    | Permissions.VIDEO
    | Permissions.ANNOTATE
    | Permissions.SCREEN_SHARE
    | Permissions.CREATE_INVITE;

// ──────────────────────────────────────────────────────────────────────────
// Helpers — used by both API (permission resolver) and desktop (UI gating).
// All operate on bigints so the same code runs on both sides.
// ──────────────────────────────────────────────────────────────────────────

/** Test whether `perms` includes `bit`. Pure bitwise AND. */
export const hasPermission = (perms: bigint, bit: bigint): boolean =>
    (perms & bit) === bit;

/** True if the holder has ADMINISTRATOR — bypasses all other checks. */
export const isAdministrator = (perms: bigint): boolean =>
    hasPermission(perms, Permissions.ADMINISTRATOR);

/**
 * Apply a single (allow, deny) override pair to a base permission set.
 * Algorithm matches Discord's spec: deny first, then allow. So an explicit
 * allow on a custom role beats a deny inherited from @everyone.
 */
export const applyOverride = (perms: bigint, allow: bigint, deny: bigint): bigint =>
    (perms & ~deny) | allow;

/**
 * Serialise/deserialise across the wire. Postgres bigint and JSON both want
 * strings (JSON.stringify can't handle BigInt). Use these at the boundary.
 */
export const permsToString = (perms: bigint): string => perms.toString(10);
export const permsFromString = (s: string | null | undefined): bigint => {
    if (!s) return 0n;
    try { return BigInt(s); } catch { return 0n; }
};
