import { describe, it, expect } from 'vitest';
import { buildWireText, buildEmojiWireText, tokenMapsFromWireText } from './composerWireText';
import { mentionsToDisplayText } from './mentionTokens';

/**
 * Opening an EDIT on a sent message is a full round trip through this
 * boundary: wire -> display (into the textarea) -> wire (on save).
 *
 * It used to lose every mention. The composer's label->token maps are
 * normally filled as the user picks from the autocomplete, and an edit starts
 * with text nobody picked anything for — so `buildWireText` had nothing to
 * substitute and saved the mention as literal `@name`. The mention stopped
 * being a mention and stopped notifying whoever it named, silently, on save.
 * (Worse, the textarea showed the raw `<@u:ID:name>` token, so the user was
 * editing around wire format they should never have seen.)
 *
 * These tests are written as the round trip rather than against either
 * function alone, because either one can look correct in isolation while the
 * pair loses data.
 */
const UID = 'd43f9e1a-2dfd-482a-9d81-a1bb4afe7313';
const RID = '8c1f0b22-77aa-4e10-9f3d-0b5c2ea41d66';
const EID = 'e91c0d55-1a2b-4c3d-8e9f-aa0b1c2d3e4f';

/** wire -> display -> wire, exactly as startEdit + the send path do it. */
function editRoundTrip(wire: string): string {
    const seeds = tokenMapsFromWireText(wire);
    const display = mentionsToDisplayText(wire);
    return buildEmojiWireText(buildWireText(display, seeds.mentions), seeds.emojis);
}

describe('edit round trip', () => {
    it('preserves a user mention', () => {
        const wire = `<@u:${UID}:Shinobi> test`;
        expect(mentionsToDisplayText(wire)).toBe('@Shinobi test');
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('preserves a role mention', () => {
        const wire = `ping <@r:${RID}:Mods> please`;
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('preserves a custom emoji', () => {
        const wire = `nice <:party:${EID}>`;
        expect(mentionsToDisplayText(wire)).toBe('nice :party:');
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('preserves @everyone and @here without needing a map entry', () => {
        // They are literal in the wire format, so the trip is a no-op — but
        // only as long as nothing tries to "resolve" them on the way through.
        const wire = '@everyone and @here';
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('preserves all four kinds in one message', () => {
        const wire = `<@u:${UID}:Shinobi> <@r:${RID}:Mods> @everyone <:party:${EID}> ship it`;
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('preserves the same mention repeated', () => {
        const wire = `<@u:${UID}:Shinobi> and <@u:${UID}:Shinobi> again`;
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('leaves a message with no tokens completely alone', () => {
        const wire = 'just some text with an @ and a : in it';
        expect(editRoundTrip(wire)).toBe(wire);
    });

    it('drops a mention the user actually deleted, and keeps the rest', () => {
        // The point of seeding from the message rather than pinning the
        // original: editing must still be editing. Deleting the text of a
        // mention has to delete the mention.
        const wire = `<@u:${UID}:Shinobi> <@r:${RID}:Mods> hi`;
        const seeds = tokenMapsFromWireText(wire);
        const edited = mentionsToDisplayText(wire).replace('@Shinobi ', '');
        expect(buildWireText(edited, seeds.mentions)).toBe(`<@r:${RID}:Mods> hi`);
    });

    it('does not rewrite a bare @word that merely starts with a known label', () => {
        // buildWireText's lookahead. "@Shinobis" is a different word and must
        // stay plain text, or editing would invent a mention nobody typed.
        const seeds = tokenMapsFromWireText(`<@u:${UID}:Shinobi> x`);
        expect(buildWireText('@Shinobis x', seeds.mentions)).toBe('@Shinobis x');
        expect(buildWireText('@Shinobi x', seeds.mentions)).toBe(`<@u:${UID}:Shinobi> x`);
    });
});

describe('tokenMapsFromWireText', () => {
    it('separates mentions from emoji into the two maps the send path expects', () => {
        const { mentions, emojis } = tokenMapsFromWireText(
            `<@u:${UID}:Shinobi> <@r:${RID}:Mods> <:party:${EID}> @everyone`,
        );
        expect(mentions).toEqual({
            Shinobi: `<@u:${UID}:Shinobi>`,
            Mods: `<@r:${RID}:Mods>`,
        });
        // Keyed by the DISPLAY form including its colons — that is what
        // buildEmojiWireText matches on.
        expect(emojis).toEqual({ ':party:': `<:party:${EID}>` });
    });

    it('returns empty maps for text with nothing to recover', () => {
        expect(tokenMapsFromWireText('plain')).toEqual({ mentions: {}, emojis: {} });
    });
});
