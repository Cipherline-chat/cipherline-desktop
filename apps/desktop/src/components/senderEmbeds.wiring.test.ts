/**
 * ChatPane is too large to mount in a unit test; these pin the phase-3 wiring
 * the behaviour suites (useComposerEmbeds, prepare, SenderEmbed,
 * linkEmbedBackupTransfer) rely on, so a refactor cannot silently drop it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

describe('ChatPane: sender-built link previews', () => {
    it('builds previews only while the setting allows it and links may be sent here', () => {
        expect(src).toMatch(/useComposerEmbeds\(\s*inputText,\s*hasUrlInInput && !blockedByEmbed && linkPreviewsEnabled\(\)/);
        expect(src).toContain('<ComposerEmbedPreviews embeds={linkPreviews} />');
    });

    it('both text sends (channel and DM) carry the embeds; an edit always states them', () => {
        expect(src).toMatch(/const linkEmbeds = await outgoingLinkEmbeds\(wireText, editingId, \(u\) => \{ lateUrls = u; \}\);/);
        const textBuilders = src.match(/type: 'text', text: wireText,[^\n]*/g) ?? [];
        expect(textBuilders.length).toBe(2);
        for (const b of textBuilders) expect(b).toContain('...embedsField');
        expect(src).toMatch(/type: 'edit', target_id: editingId, text: wireText,[^\n]*embeds: linkEmbeds \}\)/);
    });

    it('the send never waits past the deadline', () => {
        expect(src).toMatch(/takeAndFinalize\(wireText, linkPreviews\.take, upload, SEND_DEADLINE_MS, editTargetId \? undefined : onLate\)/);
    });

    it('renders only validated sender embeds, against the links in the text; others keep the local embed', () => {
        expect(src).toMatch(/const sent = senderEmbedsFor\(text, msg\.content\.embeds, allUrls\);/);
        expect(src).toContain('<SenderEmbed');
        expect(src).toContain('<MessageEmbed key={i} url={u} />');
    });

    it('Remove embed is offered on own, delivered messages only', () => {
        expect(src).toMatch(/onRemove=\{isMe && !undelivered \? \(\) => removeLinkEmbed\(msg, u\) : undefined\}/);
        expect(src).toMatch(/removeLinkEmbed,\s*\n?\s*saveMessage: retention\.saveMessage/);
    });

    it('a DM edit applies the edit\'s embeds (withEditEmbeds)', () => {
        expect(dash).toMatch(/withEditEmbeds\(withEditCardStyle\(withEditFont\(/);
    });
});
