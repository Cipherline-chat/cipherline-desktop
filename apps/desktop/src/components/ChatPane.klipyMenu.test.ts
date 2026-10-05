import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, './ChatPane.tsx'), 'utf8');
const start = src.indexOf('const handleContextMenu = (e: React.MouseEvent, msg: any)');
const menu = src.slice(start, start + 14000);

describe('message right-click menu — KLIPY GIFs', () => {
    it('offers Copy GIF link (the KLIPY media URL) and Save GIF / Remove from saved GIFs', () => {
        expect(menu).toContain("label: 'Copy GIF link'");
        expect(menu).toContain('writeToClipboard(klipyRef.media.url)');
        expect(menu).toContain("'Remove from favorites' : 'Favorite GIF'");
        expect(menu).toContain('addKlipyFavorite(klipyRef)');
    });

    it('does not offer "Copy Text" for a GIF (it has no text)', () => {
        expect(menu).toContain('if (isTextLike && !isKlipyGif) {');
    });

    it('keeps Save for me / Save to server for a GIF — the message saves and expires like text', () => {
        expect(menu).not.toContain('Saving unavailable');
        expect(menu).toContain("const saveAction = (isTextLike || (isAttachment && attId)) ? serverSaveActionFor(msg.id) : 'hidden';");
        expect(menu).toContain('if (isTextLike) retention.saveMessage(msg.id);');
    });

    it('lets a report carry the GIF reference instead of an empty snippet', () => {
        expect(menu).toContain('[KLIPY GIF');
    });
});

describe('hover bar + pasted links — KLIPY GIFs', () => {
    it('classifies a sent KLIPY GIF as text-like in the chat row, so Pin, Save and the expiry countdown all apply', () => {
        expect(src).toContain('const isTextLike = isTextLikeMessageType(msg.content?.type);');
        expect(src).not.toContain('isKlipyGifMsg');
    });

    it('routes a pasted KLIPY media link to the KLIPY embed, not the generic image-link fetcher that stores bytes', () => {
        expect(src).toContain('if (isKlipyMediaUrl(url)) return <KlipyLinkEmbed url={url} />;');
    });
});

describe('GIF wording — "favorites", not "saved"', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');
    const picker = read('./GifPicker.tsx');
    it('the picker tab, empty states and search placeholder say Favorites', () => {
        expect(picker).toContain("`Favorites${gifs.length ? ` · ${gifs.length}` : ''}`");
        expect(picker).toContain('Show favorites');
        expect(picker).toContain("'Search your favorites'");
        expect(picker).not.toMatch(/saved GIFs/i);
    });
    it('the right-click and hover wording is "Favorite GIF" / "Remove from favorites"', () => {
        expect(src).toContain("'Remove from favorites' : 'Favorite GIF'");
        expect(read('./KlipyGifEmbed.tsx')).toContain("'Remove from favorites' : 'Favorite GIF'");
    });
});

describe('saved indicator follows the same per-chat retention as the sweep', () => {
    it('isEffectiveMsgSaved / isEffectiveAttachSaved use the shared resolver, and tap-to-save reads the effective state', () => {
        expect(src).toContain('resolveChatMessageRetention(retention.policy, convType, channelMessageRetention)');
        expect(src).toContain('resolveChatAttachmentRetention(retention.policy, convType, channelAttachmentRetention)');
        expect(src).toContain("if (isEffectiveMsgSaved(msg.id, msg.content?.type === 'klipy_gif')) retention.unsaveMessage(msg.id);");
        expect(src).not.toContain('if (retention.isMessageSaved(msg.id)) retention.unsaveMessage(msg.id);');
    });
});
