/**
 * MOCK Discord channel history, hand-built in the shape of the real REST
 * responses (GET /channels/:id/messages, GET /channels/:id/messages/pins).
 * Made-up people and text; nothing here came from a real server and no real
 * token is involved. Used by the tests and the screenshot harness.
 */
const sf = (n: number) => String(900000000000000000n + BigInt(n));
export const MOCK_TEXT_CHANNEL = '800000000000000011';

export const PEOPLE = {
    alex: { id: sf(1), username: 'alex_92', global_name: 'Alex', avatar: 'a'.repeat(32), discriminator: '0' },
    sam: { id: sf(2), username: 'samwise.k', global_name: 'Sam', avatar: null, discriminator: '0' },
    riley: { id: sf(3), username: 'riley', global_name: 'Riley Q', avatar: 'b'.repeat(32), discriminator: '0' },
    farmbot: { id: sf(4), username: 'FarmBot', global_name: null, avatar: null, bot: true, discriminator: '1234' },
};

/** Newest is "now - 1h"; the window rule counts back from it. */
export function mockChannelMessages(now = Date.parse('2026-11-20T18:00:00.000Z')) {
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const msgs = [
        { id: sf(100), type: 0, content: 'Welcome to the co-op! Rules are in <#800000000000000011>, ping <@&800000000000000003> if stuck.', timestamp: at(60 * 24 * 3), author: PEOPLE.alex, mentions: [], pinned: true, attachments: [], embeds: [] },
        { id: sf(101), type: 7, content: '', timestamp: at(60 * 24 * 2), author: PEOPLE.riley, mentions: [], attachments: [], embeds: [] },
        { id: sf(102), type: 0, content: 'Harvest went great this year **really** great. @everyone come see', timestamp: at(60 * 24 * 2 - 5), author: PEOPLE.sam, mentions: [], attachments: [
            { id: sf(500), filename: 'pumpkins.png', size: 4096, url: `https://cdn.discordapp.com/attachments/${MOCK_TEXT_CHANNEL}/${sf(500)}/pumpkins.png?ex=1&is=2&hm=abc`, content_type: 'image/png' },
        ], embeds: [] },
        { id: sf(103), type: 19, content: 'Nice! <@' + PEOPLE.sam.id + '> those are huge :pumpkin: <:Tractor:800000000000000041>', timestamp: at(60 * 24 * 2 - 10), author: PEOPLE.riley, mentions: [PEOPLE.sam], message_reference: { type: 0, message_id: sf(102) }, attachments: [], embeds: [] },
        { id: sf(104), type: 0, content: 'Weather report', timestamp: at(60 * 24), author: PEOPLE.farmbot, mentions: [], attachments: [], embeds: [
            { type: 'rich', title: 'Tomorrow', description: 'Sunny, 21 °C', fields: [{ name: 'Wind', value: '8 km/h' }], footer: { text: 'FarmBot' } },
        ] },
        { id: sf(105), type: 0, content: 'Edited to fix a typo', edited_timestamp: at(100), timestamp: at(120), author: PEOPLE.alex, mentions: [], attachments: [], embeds: [] },
        { id: sf(106), type: 0, content: '', timestamp: at(90), author: PEOPLE.sam, mentions: [], flags: 1 << 13, attachments: [
            { id: sf(501), filename: 'voice-message.ogg', size: 2048, url: `https://cdn.discordapp.com/attachments/${MOCK_TEXT_CHANNEL}/${sf(501)}/voice-message.ogg?ex=1&is=2&hm=abc`, content_type: 'audio/ogg' },
        ], embeds: [] },
        { id: sf(107), type: 0, content: '', timestamp: at(80), author: PEOPLE.riley, mentions: [], attachments: [], embeds: [], poll: {
            question: { text: 'Next crop?' }, answers: [{ answer_id: 1, poll_media: { text: 'Corn' } }, { answer_id: 2, poll_media: { text: 'Beans' } }],
            results: { answer_counts: [{ id: 1, count: 4 }, { id: 2, count: 2 }] },
        } },
        { id: sf(108), type: 0, content: 'See you all at the market', timestamp: at(60), author: PEOPLE.alex, mentions: [], pinned: true, attachments: [], embeds: [], sticker_items: [{ name: 'wave', format_type: 1 }] },
    ];
    return msgs.reverse(); // newest first, as Discord pages them
}

/** A pin older than the 30-day window (always imported) plus one inside it. */
export function mockPins(now = Date.parse('2026-11-20T18:00:00.000Z')) {
    const old = {
        id: sf(50), type: 0, content: 'Founding post: be kind, share seeds.', timestamp: new Date(now - 90 * 24 * 3600_000).toISOString(),
        author: PEOPLE.alex, mentions: [], attachments: [], embeds: [], pinned: true,
    };
    const inWindow = mockChannelMessages(now).find(m => m.id === sf(108))!;
    const first = mockChannelMessages(now).find(m => m.id === sf(100))!;
    return {
        items: [
            { pinned_at: new Date(now - 3600_000).toISOString(), message: inWindow },
            { pinned_at: new Date(now - 2 * 24 * 3600_000).toISOString(), message: first },
            { pinned_at: new Date(now - 80 * 24 * 3600_000).toISOString(), message: old },
        ],
        has_more: false,
    };
}

export const MOCK_IDS = { sf };
