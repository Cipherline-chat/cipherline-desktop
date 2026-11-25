// @vitest-environment jsdom
/**
 * "Always a thumbnail" on the RECEIVER (embeds-always-thumb), mounted for
 * real. Old messages (and older senders) without a picture, and pictures that
 * decode to one flat colour (Medal's black first frame), get the designed card
 * picture, drawn locally: no request of any kind. A thumbnail still being
 * decrypted shows nothing meanwhile (no designed flash). A GIF loop shows the
 * sender's picture of it until it plays.
 *
 * jsdom has no canvas, so the drawing itself (designedPictureUrl) and the
 * flatness read (statsOf) are stand-ins here; their real versions run in the
 * real-Electron harness (screenshots).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinkEmbed } from '@cipherline/shared';
import { Blob as NodeBlob } from 'node:buffer';

(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;
vi.hoisted(() => {
    const w = globalThis as unknown as { window?: { matchMedia?: unknown } };
    if (w.window && typeof w.window.matchMedia !== 'function') {
        w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
});
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: 'known' } }),
    useShowEmbeds: () => true,
}));
const dl = vi.hoisted(() => ({ pending: true }));
vi.mock('../../utils/attachmentDownload', () => ({
    downloadEncryptedAttachment: () => new Promise(() => { /* still downloading */ }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));
const design = vi.hoisted(() => ({ specs: [] as { label: string; play?: boolean; color?: string; icon?: unknown }[] }));
vi.mock('../../utils/linkEmbeds/designedThumb', async (orig) => {
    const real = await orig<typeof import('../../utils/linkEmbeds/designedThumb')>();
    return {
        ...real,
        designedPictureUrl: (spec: { label: string; play?: boolean; color?: string; icon?: unknown }) => {
            design.specs.push(spec);
            return `data:image/png;base64,DESIGNED${spec.play ? 'PLAY' : 'CARD'}`;
        },
    };
});
const flat = vi.hoisted(() => ({ next: null as null | { mean: number; std: number } }));
vi.mock('../../utils/linkEmbeds/thumb', async (orig) => {
    const real = await orig<typeof import('../../utils/linkEmbeds/thumb')>();
    return { ...real, statsOf: () => flat.next };
});

import { SenderEmbed } from './SenderEmbed';
import { MessageEmbed } from './MessageEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { bytesToBase64 } from '../../utils/linkEmbeds/thumb';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { clearDecryptedMediaCache } from '../../utils/decryptedMediaCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...new Array(40).fill(7)]);
const inlineThumb = { mime: 'image/webp' as const, width: 320, height: 180, inline_b64: bytesToBase64(WEBP) };

let root: Root | null = null;
let host: HTMLDivElement;
let netFetch: ReturnType<typeof vi.fn>;
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api = {
        fetchBinary: vi.fn(async () => { throw new Error('must not be called'); }),
        youtubeOEmbed: vi.fn(async () => null),
        resolveClipMedia: vi.fn(() => new Promise(() => {})),
        registerMedia: vi.fn(async () => ({ ok: false })),
        registerClipMedia: vi.fn(() => new Promise(() => {})),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    netFetch = vi.fn(async () => { throw new Error('no network in this test'); });
    (window as unknown as { fetch: unknown }).fetch = netFetch;
    URL.createObjectURL = vi.fn(() => `blob:test/${Math.random().toString(36).slice(2)}`);
    URL.revokeObjectURL = vi.fn();
    design.specs = [];
    flat.next = null;
    dl.pending = true;
    _resetAutoLoadLimiterForTests();
    clearDecryptedMediaCache();
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(node: React.ReactElement) {
    act(() => { root!.render(h(EmbedPlaybackContext.Provider, { value: new PlaybackScope() }, node)); });
}

const MEDAL_OLD: LinkEmbed = {
    url: 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', kind: 'video', site: 'Medal', title: 'wyw my sweetie', tag: 'Valorant',
    media: { url: 'https://cdn.medal.tv/mediac/x.mp4', mime: 'video/mp4', width: 1920, height: 1080 },
};

describe('receiver: every embed draws a picture', () => {
    it('an old clip message with no picture: the designed poster (play layout), no request', async () => {
        render(h(SenderEmbed, { embed: MEDAL_OLD, layout: 'expanded' }));
        await flush();
        const card = host.querySelector('[data-embed="clip"]')!;
        expect(card.getAttribute('data-picture')).toBe('designed');
        expect(card.querySelector('img[data-designed]')?.getAttribute('src')).toBe('data:image/png;base64,DESIGNEDPLAY');
        expect(design.specs.at(-1)).toMatchObject({ label: 'Medal', play: true });
        expect(netFetch).not.toHaveBeenCalled();
        expect(api.registerClipMedia).not.toHaveBeenCalled();
        expect(api.resolveClipMedia).not.toHaveBeenCalled();
    });

    it('a thumbnail still decrypting: nothing meanwhile (no designed flash)', async () => {
        const e: LinkEmbed = { ...MEDAL_OLD, thumb: { mime: 'image/webp', width: 920, height: 518, attachment_id: '11111111-2222-4333-8444-555555555555', file_key_b64: `${'A'.repeat(43)}=`, file_nonce_b64: 'B'.repeat(16), byte_size: 30_000 } };
        render(h(SenderEmbed, { embed: e, layout: 'expanded' }));
        await flush();
        expect(host.querySelector('[data-embed="clip"]')!.getAttribute('data-picture')).toBe('none');
        expect(host.querySelector('img[data-designed]')).toBeNull();
    });

    it('a picture that decodes to black (the Medal first frame an older sender sent): replaced by the designed poster', async () => {
        render(h(SenderEmbed, { embed: { ...MEDAL_OLD, thumb: inlineThumb }, layout: 'expanded' }));
        await flush();
        const card = host.querySelector('[data-embed="clip"]')!;
        const real = card.querySelector('img:not([data-designed])') as HTMLImageElement;
        expect(real.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
        // It decodes: one flat colour.
        flat.next = { mean: 0, std: 0 };
        await act(async () => { real.dispatchEvent(new Event('load')); });
        await flush();
        expect(card.getAttribute('data-picture')).toBe('designed');
        expect(card.querySelector('img:not([data-designed])')).toBeNull();
    });

    it('POSITIVE CONTROL: a picture that decodes to a real frame is shown, and no designed picture', async () => {
        render(h(SenderEmbed, { embed: { ...MEDAL_OLD, thumb: inlineThumb }, layout: 'expanded' }));
        await flush();
        const card = host.querySelector('[data-embed="clip"]')!;
        flat.next = { mean: 96, std: 40 };
        await act(async () => { (card.querySelector('img:not([data-designed])') as HTMLImageElement).dispatchEvent(new Event('load')); });
        await flush();
        expect(card.getAttribute('data-picture')).toBe('real');
        expect(card.querySelector('img[data-designed]')).toBeNull();
    });

    it('a web card with no picture (older message / wall): the designed picture as its hero, Island in Expanded, Ambient in Compact', async () => {
        const card: LinkEmbed = { url: 'https://example.com/', kind: 'card', site: 'example.com', title: 'Example Domain', color: '#336699' };
        render(h(SenderEmbed, { embed: card, layout: 'expanded' }));
        await flush();
        let el = host.querySelector('[data-embed="web"]')!;
        expect(el.getAttribute('data-picture')).toBe('designed');
        expect(el.getAttribute('data-embed-style')).toBe('island');
        expect(el.querySelector('.cl-se-hero img')?.getAttribute('src')).toBe('data:image/png;base64,DESIGNEDCARD');
        expect(design.specs.at(-1)).toMatchObject({ label: 'example.com', color: '#336699', play: false });
        render(h(SenderEmbed, { embed: card, layout: 'compact' }));
        await flush();
        el = host.querySelector('[data-embed="web"]')!;
        expect(el.getAttribute('data-embed-style')).toBe('ambient');
        expect(netFetch).not.toHaveBeenCalled();
    });

    it('a sender\'s designed picture is drawn as sent (marked designed)', async () => {
        render(h(SenderEmbed, { embed: { url: 'https://example.com/', kind: 'card', site: 'example.com', thumb: { ...inlineThumb, width: 640, height: 360, designed: true } }, layout: 'expanded' }));
        await flush();
        const el = host.querySelector('[data-embed="web"]')!;
        expect(el.getAttribute('data-picture')).toBe('designed');
        expect(el.querySelector('.cl-se-hero img')?.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
    });

    it('a link with no sender preview at all (a direct .mp4 from an older app): the designed poster, no request', async () => {
        render(h(MessageEmbed, { url: 'https://cdn.example/clips/match-point.mp4' }));
        await flush();
        const card = host.querySelector('[data-embed="video"]')!;
        expect(card.getAttribute('data-picture')).toBe('designed');
        expect(api.registerMedia).not.toHaveBeenCalled();
        expect(netFetch).not.toHaveBeenCalled();
    });

    it('a GIF loop shows the sender\'s picture of it until it plays', async () => {
        const gif: LinkEmbed = {
            url: 'https://giphy.com/gifs/cat-JIX9t2j0ZTN9S', kind: 'video', site: 'GIPHY',
            media: { url: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4', mime: 'video/mp4', width: 480, height: 270, loop: true }, thumb: inlineThumb,
        };
        render(h(SenderEmbed, { embed: gif, layout: 'expanded' }));
        await flush();
        const el = host.querySelector('[data-embed="gif-loop"]')!;
        expect(el.getAttribute('data-picture')).toBe('real');
        expect(el.querySelector('img[data-gif-poster]')?.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
    });
});
