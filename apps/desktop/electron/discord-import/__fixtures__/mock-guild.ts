/**
 * A MOCK Discord guild, hand-built in the shape of the real REST responses
 * (GET /guilds/:id and GET /guilds/:id/channels). Used by the tests; nothing
 * here came from a real server and no real token is involved.
 */
const G = '800000000000000001';
const sf = (n: number) => String(800000000000000000n + BigInt(n));
const bit = (n: number) => 1 << n;

export const MOCK_GUILD_ID = G;
export const MOCK_ROLE_MOD = sf(3);
export const MOCK_BOT_ROLE = sf(5);

export const mockGuild = () => ({
    id: G, name: 'Pixel Farm Co-op', description: 'A made-up server for tests',
    icon: 'a_1234abcd', banner: 'bnr5678', splash: null, discovery_splash: null,
    verification_level: 2, default_message_notifications: 1, explicit_content_filter: 2,
    afk_channel_id: sf(15), afk_timeout: 300, system_channel_id: sf(11), system_channel_flags: 0,
    preferred_locale: 'en-US', features: ['COMMUNITY', 'WELCOME_SCREEN_ENABLED'],
    premium_tier: 2, premium_subscription_count: 9, vanity_url_code: 'pixelfarm', rules_channel_id: sf(11),
    roles: [
        { id: G, name: '@everyone', permissions: String(bit(10) | bit(11) | bit(16) | bit(20) | bit(21)), position: 0, color: 0, hoist: false, managed: false, mentionable: false },
        { id: sf(2), name: 'Farmhand', permissions: String(bit(10) | bit(11) | bit(6)), position: 1, color: 3447003, hoist: true, managed: false, mentionable: true },
        { id: sf(3), name: 'Moderator', permissions: String(bit(1) | bit(22) | bit(23) | bit(13)) + '', position: 3, color: 15158332, hoist: true, managed: false, mentionable: true },
        { id: sf(4), name: 'Owner', permissions: String(bit(3)), position: 4, color: 0, hoist: false, managed: false, mentionable: false },
        { id: sf(5), name: 'Helper Bot', permissions: '8', position: 2, color: 0, hoist: false, managed: true, mentionable: false },
    ],
    emojis: [
        { id: sf(40), name: 'party_parrot', animated: true, managed: false, available: true },
        { id: sf(41), name: 'Tractor', animated: false, managed: false, available: true },
        { id: sf(42), name: 'locked_one', animated: false, managed: false, available: false },
    ],
    stickers: [{ id: sf(50) }, { id: sf(51) }],
});

const ow = (id: string, type: 0 | 1, allow: number, deny: number) => ({ id, type, allow: String(allow), deny: String(deny) });
const V = bit(10);
const S = bit(11);

export const mockChannels = () => [
    { id: sf(10), type: 4, name: 'INFO', position: 0, parent_id: null, permission_overwrites: [] },
    { id: sf(11), type: 0, name: '\u{1F4DC}・rules', position: 0, parent_id: sf(10), topic: 'Be kind', nsfw: false, rate_limit_per_user: 10, permission_overwrites: [ow(G, 0, 0, S)] },
    { id: sf(12), type: 5, name: 'announcements', position: 1, parent_id: sf(10), permission_overwrites: [] },
    { id: sf(13), type: 4, name: 'STAFF', position: 1, parent_id: null, permission_overwrites: [ow(G, 0, 0, V), ow(MOCK_ROLE_MOD, 0, V, 0)] },
    { id: sf(14), type: 0, name: 'mod-chat', position: 0, parent_id: sf(13), topic: null, permission_overwrites: [ow(G, 0, 0, V), ow(MOCK_ROLE_MOD, 0, V, 0), ow(MOCK_BOT_ROLE, 0, V, 0), ow('900000000000000009', 1, V, 0)] },
    { id: sf(15), type: 2, name: 'AFK', position: 0, parent_id: sf(10), user_limit: 0, permission_overwrites: [] },
    { id: sf(16), type: 15, name: 'help-forum', position: 2, parent_id: sf(10), permission_overwrites: [] },
    { id: sf(17), type: 13, name: 'Town Hall', position: 3, parent_id: sf(10), permission_overwrites: [] },
    { id: sf(18), type: 0, name: 'general', position: 0, parent_id: null, topic: 'Say hi', permission_overwrites: [] },
];

export const mockMe = () => ({ id: sf(900), username: 'Cipherline Importer', bot: true });
/** GET /oauth2/applications/@me: the bot's application (modern app: id = bot id), both privileged intents on (the _LIMITED flags). */
export const mockApp = (flags = (1 << 15) | (1 << 19)) => ({ id: sf(900), name: 'Cipherline Importer', flags, bot_public: true });
export const mockGuildList = () => [
    { id: G, name: 'Pixel Farm Co-op', owner: true, icon: 'a_1234abcd', permissions: '2147483647' },
    { id: sf(777), name: 'Second Guild', owner: false, icon: null, permissions: '66560' },
];

/** GET /guilds/:id/members (mock): two people with roles, one with only a nickname, one plain, and a bot. */
export const MOCK_MEMBER_SAM = '900000000000000001';
export const MOCK_MEMBER_ALEX = '900000000000000002';
export const MOCK_MEMBER_OVERWRITE = '900000000000000009';
export const MOCK_BANNED = '900000000000000066';
export const mockMembers = () => [
    { user: { id: MOCK_MEMBER_SAM, username: 'sam' }, roles: [MOCK_ROLE_MOD, sf(2)], nick: 'Sammy' },
    { user: { id: MOCK_MEMBER_ALEX, username: 'alex' }, roles: [sf(2)], nick: null },
    { user: { id: '900000000000000003', username: 'quiet' }, roles: [], nick: 'Q' },
    { user: { id: '900000000000000004', username: 'plain' }, roles: [] },
    { user: { id: MOCK_MEMBER_OVERWRITE, username: 'trusted' }, roles: [], communication_disabled_until: '2999-01-01T00:00:00Z' },
    { user: { id: sf(900), username: 'Cipherline Importer', bot: true }, roles: [MOCK_BOT_ROLE] },
];
/** GET /guilds/:id/bans (mock). */
export const mockBans = () => [
    { user: { id: MOCK_BANNED, username: 'spammer' }, reason: 'Spam links' },
    { user: { id: '900000000000000067', username: 'badbot', bot: true }, reason: null },
];
