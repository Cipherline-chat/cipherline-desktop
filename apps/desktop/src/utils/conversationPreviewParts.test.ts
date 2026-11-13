import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewParts } from '../utils/conversationPreviewParts';

// Owner, 2026-11-08: a custom emoji in the DM / group list preview showed as
// `:test_emoji:`; it now draws as the emoji. Only personal (My Emojis) ids can
// be drawn without a server context.

const P = 'p_0123456789abcdef0123456789abcdef';
const S = '11111111-2222-3333-4444-555555555555';

describe('previewParts', () => {
    it('splits a personal emoji out of the text, keeping the text around it', () => {
        expect(previewParts(`hi <:test_emoji:${P}> there`)).toEqual([
            { kind: 'text', text: 'hi ' },
            { kind: 'emoji', id: P, label: 'test_emoji' },
            { kind: 'text', text: ' there' },
        ]);
    });

    it('an emoji-only message is one emoji part', () => {
        expect(previewParts(`<:test_emoji:${P}>`)).toEqual([{ kind: 'emoji', id: P, label: 'test_emoji' }]);
    });

    it('leaves a server emoji (no context to draw it in a DM) and mentions inside the text runs', () => {
        const t = `<:party:${S}> <@u:${S}:Shinobi>`;
        expect(previewParts(t)).toEqual([{ kind: 'text', text: t }]);
    });

    it('positive control: plain text is one text part; empty / non-string input yields nothing', () => {
        expect(previewParts('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
        expect(previewParts('')).toEqual([]);
        expect(previewParts(undefined)).toEqual([]);
    });
});

describe('wiring', () => {
    it('the conversation rail renders text previews through ConversationPreviewText', () => {
        const src = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        expect(src).toContain('<ConversationPreviewText');
        expect(src).toContain('text={clipForPreview(lastMsg.content.text)}');
    });
});
