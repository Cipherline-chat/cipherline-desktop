import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { replyQuoteLine } from './replyQuoteLine';

const snip = (c: { text?: unknown }) => (typeof c.text === 'string' ? c.text.trim() : '');

// Owner, 2026-11-16: "replies to images should just say 'image' with the name
// of the person who sent it. and files can say attachment."
describe('replyQuoteLine', () => {
    it('image attachments say Image (any image/* type, any case)', () => {
        for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'IMAGE/WEBP']) {
            expect(replyQuoteLine({ type: 'attachment', mime }, snip)).toBe('Image');
        }
    });
    it('every other file says Attachment, never its filename', () => {
        for (const mime of ['application/pdf', 'video/mp4', 'audio/ogg', '', undefined]) {
            expect(replyQuoteLine({ type: 'attachment', mime }, snip)).toBe('Attachment');
        }
    });
    it('GIF picker messages say GIF; text keeps its snippet; nothing loaded says Original message', () => {
        expect(replyQuoteLine({ type: 'klipy_gif' }, snip)).toBe('GIF');
        expect(replyQuoteLine({ type: 'text', text: ' hello ' }, snip)).toBe('hello');
        expect(replyQuoteLine({ type: 'text', text: '' }, snip)).toBe('Original message');
        expect(replyQuoteLine(undefined, snip)).toBe('Original message');
    });
    it('ChatPane builds the quote line through it', () => {
        const src = readFileSync(resolve(__dirname, '../components/ChatPane.tsx'), 'utf8');
        expect(src).toContain("const replyLine = replyQuoteLine(replyTarget?.content, c => previewSnippet(toPlainText(c.text)));");
    });
});
