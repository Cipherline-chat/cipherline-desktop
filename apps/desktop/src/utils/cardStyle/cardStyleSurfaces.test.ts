/**
 * Where card styles render, and who may post them (composer gate).
 *
 * Cards render in the chat message ROW only (DMs and channels). Notifications,
 * reply quotes, the pinned panel, search results, the long-message reader,
 * link previews and everything else stay plain. Proven structurally: the
 * renderer (MessageCard / resolveMessageCard) is imported only by the row
 * body and the card editor's own UI, ChatPane resolves a card exactly once
 * (inside the text body), and the reply quote / notification / quote-line
 * helpers produce plain strings from styled content.
 *
 * The one other place a card is drawn is the AUTHOR's composer while a style
 * is set for their next message (ComposerCardSurface, 2026-11-18): it builds
 * the card element with the same cardElementProps as MessageCard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Permissions, ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import { replyQuoteLine } from '../replyQuoteLine';
import { toPlainText } from '../messagePreviewText';
import { cardStylePostingGate } from './cardStyleGate';
import { cardStyleEditField, cardStyleSendField, cardStyleLabel } from './composerCardStyle';
import { CARD_STYLE_TEMPLATES } from './cardStyleTemplates';

const SRC = join(__dirname, '..', '..');
function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out); }
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
    }
    return out;
}

describe('cards render in the message row only', () => {
    it('only the row, the editor UI, the composer control and Settings use the renderer', () => {
        const users = walk(SRC)
            .filter(f => /<MessageCard\b|resolveMessageCard\(/.test(readFileSync(f, 'utf8')))
            .map(f => f.slice(SRC.length + 1))
            .sort();
        expect(users).toEqual([
            'components/ChatPane.tsx',
            'components/composer/FormatToolbar.tsx',
            'components/messageCard/CardStyleEditor.tsx',
            'components/settings/panes/MessageStylesSettings.tsx',
            'utils/cardStyle/cardStyleReact.ts', // defines resolveMessageCard
        ]);
    });

    it('the card element is built in ONE place: MessageCard and the composer\'s live preview both spread cardElementProps', () => {
        const users = walk(SRC)
            .filter(f => /cardElementProps\(/.test(readFileSync(f, 'utf8')))
            .map(f => f.slice(SRC.length + 1))
            .sort();
        expect(users).toEqual([
            'components/messageCard/ComposerCardSurface.tsx',
            'components/messageCard/MessageCard.tsx',
            'utils/cardStyle/cardStyleReact.ts', // defines it
        ]);
        // The live preview (the author's own next message) lives only in ChatPane's composer.
        const previewUsers = walk(SRC)
            .filter(f => /<ComposerCardSurface\b/.test(readFileSync(f, 'utf8')))
            .map(f => f.slice(SRC.length + 1));
        expect(previewUsers).toEqual(['components/ChatPane.tsx']);
    });

    it('ChatPane resolves a card exactly once, in the text body, never in the reply quote', () => {
        const cp = readFileSync(join(SRC, 'components', 'ChatPane.tsx'), 'utf8');
        expect(cp.match(/resolveMessageCard\(/g)).toHaveLength(1);
        expect(cp.match(/<MessageCard /g)).toHaveLength(1);
        const quoteStart = cp.indexOf('data-testid="reply-quote"');
        const bodyStart = cp.indexOf('{/* Body */}');
        expect(quoteStart).toBeGreaterThan(0);
        expect(bodyStart).toBeGreaterThan(quoteStart);
        expect(cp.slice(quoteStart, bodyStart)).not.toMatch(/MessageCard|card_style|resolveCard/);
        const cardAt = cp.indexOf('const card = resolveMessageCard(');
        expect(cardAt).toBeGreaterThan(bodyStart);
    });

    it('reply quotes and notification previews are plain strings for a styled message', () => {
        const styled = { type: 'text', text: '# Rules\n**Be kind**', card_style: CARD_STYLE_TEMPLATES[0].style };
        const line = replyQuoteLine(styled, (c) => toPlainText(String(c.text ?? '')));
        expect(typeof line).toBe('string');
        expect(line).not.toMatch(/card_style|#151d36|theme\(/);
        expect(toPlainText(styled.text)).not.toMatch(/\*\*|#/);
    });

    it('the pinned panel, search and the long-message reader never import the renderer', () => {
        for (const f of ['components/PinnedMessagesPanel.tsx', 'components/LongMessage.tsx']) {
            const t = readFileSync(join(SRC, f), 'utf8');
            expect(t, f).not.toMatch(/MessageCard|cardStyle|card_style/);
        }
    });
});

describe('composer gate (who may post a styled message here)', () => {
    const chan = (perms: bigint | undefined, server: 'on' | 'no_animation' | 'off' | null = 'on') =>
        cardStylePostingGate({ isServerChannel: true, serverMessageStyles: server, channelPermissions: perms });
    it('DMs and groups: anyone', () => {
        expect(cardStylePostingGate({ isServerChannel: false, serverMessageStyles: undefined, channelPermissions: undefined }).allowed).toBe(true);
    });
    it('a server channel needs STYLE_MESSAGES there; @everyone does not have it by default', () => {
        expect(chan(DEFAULT_EVERYONE_PERMISSIONS)).toMatchObject({ allowed: false, reason: expect.stringMatching(/Style Messages permission/) });
        expect(chan(DEFAULT_EVERYONE_PERMISSIONS | Permissions.STYLE_MESSAGES).allowed).toBe(true);
        expect(chan(ALL_PERMISSIONS).allowed).toBe(true); // administrator / owner
    });
    it('strict while permissions are loading', () => {
        expect(chan(undefined).allowed).toBe(false);
    });
    it('server setting Off hides styling even for holders; No animation does not', () => {
        expect(chan(ALL_PERMISSIONS, 'off')).toMatchObject({ allowed: false, reason: expect.stringMatching(/turned off/) });
        expect(chan(ALL_PERMISSIONS, 'no_animation').allowed).toBe(true);
    });
});

describe('composer wire fields', () => {
    const st = CARD_STYLE_TEMPLATES[0].style;
    it('a new message carries card_style only when styled', () => {
        expect(cardStyleSendField({ style: st })).toEqual({ card_style: st });
        expect(cardStyleSendField(null)).toEqual({});
    });
    it('an edit carries card_style only when it was changed (null = remove)', () => {
        expect(cardStyleEditField(false, { style: st })).toEqual({});
        expect(cardStyleEditField(true, { style: st })).toEqual({ card_style: st });
        expect(cardStyleEditField(true, null)).toEqual({ card_style: null });
    });
    it('labels name the template, the saved style, or Custom', () => {
        expect(cardStyleLabel(st)).toBe('Rules');
        expect(cardStyleLabel({ v: 1, text: '#ffffff' }, [{ id: 'a', name: 'Mod notes', style: { v: 1, text: '#ffffff' } }])).toBe('Mod notes');
        expect(cardStyleLabel({ v: 1, text: '#fefefe' })).toBe('Custom');
        expect(cardStyleLabel(null)).toBeNull();
    });
});
