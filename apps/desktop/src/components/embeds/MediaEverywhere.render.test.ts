// @vitest-environment jsdom
/**
 * THE HARD RULE (2026-11-24, embeds-media-everywhere; the owner's "invisible
 * message"): a message's link text is ALWAYS visible unless an embed actually
 * rendered real content. A failed, pending or blocked embed leaves the link
 * visible, and nothing ever collapses to an empty row.
 *
 * Mounted for real, the way ChatPane draws a message (`.cl-msg-col` with the
 * text in `.cl-bare-media-text` when bareMediaLink.ts says so, then the
 * `.cl-embed-row`), over every embed kind x failure mode:
 *   - "rendered" (the CSS hides the text) only when `[data-embed-rendered]` is
 *     present, which embeds set ONLY with real pixels on screen;
 *   - every other state shows SOMETHING visible besides the text (a card, a
 *     placeholder, a poster), never an empty embed row.
 * The CSS rule itself is asserted from styles/formatting.css; its effect is
 * proven in the real Electron harness (harness/media-everywhere-electron.mjs).
 *
 * POSITIVE CONTROL: the OLD rule (hide by the URL's shape) would have hidden
 * the text of the expired Discord link that then rendered nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'fs';
import * as path from 'path';
import type { LinkEmbed } from '@cipherline/shared';
import { Blob as NodeBlob } from 'node:buffer';

(globalThis as unknown as { Blob: unknown }).Blob = NodeBlob;

const env = vi.hoisted(() => {
    const w = globalThis as unknown as { window?: { matchMedia?: unknown } };
    if (w.window && typeof w.window.matchMedia !== 'function') {
        w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
    return { show: true, autoLoad: 'known' as 'known' | 'always' | 'never', klipy: false };
});
vi.mock('../../hooks/usePrivacySettings', () => ({
    usePrivacySettings: () => ({ settings: { imageAutoLoad: env.autoLoad } }),
    useShowEmbeds: () => env.show,
}));
vi.mock('../../hooks/useWindowFocus', () => ({ useWindowFocus: () => true }));
vi.mock('../../hooks/useGifSettings', async (orig) => ({ ...(await orig<object>()), useGifSettings: () => ({ settings: { klipyEnabled: env.klipy } }) }));
const dl = vi.hoisted(() => ({ calls: [] as string[], mode: 'fail' as 'fail' | 'hang' }));
vi.mock('../../utils/attachmentDownload', () => ({
    downloadEncryptedAttachment: async (id: string) => { dl.calls.push(id); if (dl.mode === 'hang') return new Promise(() => {}); throw new Error('gone'); },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));

import { SenderEmbed } from './SenderEmbed';
import { MessageEmbed } from './MessageEmbed';
import { EmbedPlaybackContext, PlaybackScope } from './embedPlayback';
import { isBareMediaLinkMessage } from '../../utils/formatting/bareMediaLink';
import { isImageUrl } from '../../utils/imageHosts';
import { _resetAutoLoadLimiterForTests } from '../../utils/autoLoadLimiter';
import { clearDecryptedMediaCache } from '../../utils/decryptedMediaCache';
import { clearRemoteImageCache } from '../../utils/remoteImageCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const DISCORD_GIF = 'https://cdn.discordapp.com/attachments/1083749285425856633/1176234513312391178/cat.gif?ex=656a5c4b&is=6557e74b&hm=2b0ef6b2';
const FILE = { attachment_id: '11111111-2222-4333-8444-555555555555', file_key_b64: `${'A'.repeat(43)}=`, file_nonce_b64: 'B'.repeat(16), byte_size: 95920 };
const GIF_PIXELS = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]);

let root: Root | null = null;
let host: HTMLDivElement;
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
    env.show = true; env.autoLoad = 'known'; env.klipy = false;
    dl.calls.length = 0; dl.mode = 'fail';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api = {
        fetchBinary: vi.fn(async () => { throw new Error('HTTP 404'); }),
        registerMedia: vi.fn(async () => ({ ok: false })),
        registerClipMedia: vi.fn(async () => ({ ok: false })),
        resolveClipMedia: vi.fn(async () => ({ ok: false, reason: 'failed' })),
        youtubeOEmbed: vi.fn(async () => null),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    URL.createObjectURL = vi.fn(() => `blob:test/${Math.random().toString(36).slice(2)}`);
    URL.revokeObjectURL = vi.fn();
    _resetAutoLoadLimiterForTests();
    clearDecryptedMediaCache();
    clearRemoteImageCache();
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

/** A message as ChatPane draws it: the text (wrapped when bare media), then the embed row. */
function Message({ text, embeds, sender }: { text: string; embeds?: LinkEmbed[]; sender?: LinkEmbed }) {
    const bare = isBareMediaLinkMessage(text, embeds);
    const body = h('div', { className: 'cl-msg-body', 'data-testid': 'text' }, h('a', { href: text.trim() }, text));
    return h('div', { className: 'cl-msg-col' },
        bare ? h('div', { className: 'cl-bare-media-text' }, body) : body,
        h(EmbedPlaybackContext.Provider, { value: new PlaybackScope() },
            h('div', { className: 'cl-embed-row' }, sender ? h(SenderEmbed, { embed: sender }) : h(MessageEmbed, { url: text.trim() }))));
}

async function mount(el: React.ReactElement) { await act(async () => { root!.render(el); }); await flush(); }

/** Visible verdict for one mounted message. */
function verdict() {
    const row = host.querySelector('.cl-embed-row')!;
    const rendered = !!row.querySelector('[data-embed-rendered="media"]');
    const hidesText = !!host.querySelector('.cl-msg-col .cl-bare-media-text') && rendered;
    const textInDom = !!host.querySelector('[data-testid="text"] a');
    // Something the reader can see in the embed row: a card, a placeholder / button, a picture.
    const embedVisible = row.childElementCount > 0 && !!row.querySelector('img, video, button, [data-embed-fallback], .cl-se, [data-embed], a, span');
    return { rendered, textVisible: textInDom && !hidesText, embedVisible };
}

/** THE RULE: text visible, or real content rendered. And never an empty row. */
function assertRule(v: ReturnType<typeof verdict>, label: string) {
    expect(v.textVisible || v.rendered, `${label}: neither the link nor real content`).toBe(true);
    if (!v.rendered) expect(v.textVisible, `${label}: link hidden without content`).toBe(true);
    expect(v.textVisible || v.embedVisible, `${label}: an empty row`).toBe(true);
}

describe('the hard rule: link text visible unless an embed really rendered', () => {
    it('expired Discord GIF link (main answers 404): the visible link card, the link stays', async () => {
        await mount(h(Message, { text: DISCORD_GIF }));
        const v = verdict();
        assertRule(v, 'expired discord');
        expect(v.rendered).toBe(false);
        expect(host.querySelector('[data-embed-fallback="failed"]')).toBeTruthy();
    });

    it('a picture that decodes to NOTHING (an HTML page behind an image link, 0x0): the card, never a 0-size image', async () => {
        api.fetchBinary.mockResolvedValue({ bytes: new TextEncoder().encode('<!doctype html><html></html>'), mimeType: 'image/gif' });
        await mount(h(Message, { text: 'https://cdn.discordapp.com/attachments/1/2/a.gif' }));
        const img = host.querySelector('img')!;
        expect(img).toBeTruthy();
        // jsdom: naturalWidth is 0 → the load handler must treat it as failure.
        await act(async () => { img.dispatchEvent(new Event('load')); });
        await flush();
        const v = verdict();
        assertRule(v, 'zero-size decode');
        expect(host.querySelector('[data-embed-fallback="failed"]')).toBeTruthy();
    });

    it('an image error event: the card', async () => {
        api.fetchBinary.mockResolvedValue({ bytes: GIF_PIXELS, mimeType: 'image/png' });
        await mount(h(Message, { text: 'https://cdn.discordapp.com/attachments/1/2/a.png' }));
        await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
        await flush();
        assertRule(verdict(), 'img error');
        expect(host.querySelector('[data-embed-fallback="failed"]')).toBeTruthy();
    });

    it('PENDING (the fetch never answers): the skeleton AND the link', async () => {
        api.fetchBinary.mockReturnValue(new Promise(() => {}));
        await mount(h(Message, { text: DISCORD_GIF }));
        const v = verdict();
        assertRule(v, 'pending');
        expect(v.rendered).toBe(false);
    });

    it('BLOCKED (an unknown host under "known hosts only"): the Load image button AND the link', async () => {
        await mount(h(Message, { text: 'https://pics.random.example/cat.gif' }));
        expect(api.fetchBinary).not.toHaveBeenCalled();
        const v = verdict();
        assertRule(v, 'blocked');
        expect(host.querySelector('button')?.textContent).toMatch(/Load image/);
    });

    it('embeds turned OFF: the embed row is empty, so the link MUST be visible', async () => {
        env.show = false;
        await mount(h(Message, { text: DISCORD_GIF }));
        const v = verdict();
        expect(v.rendered).toBe(false);
        expect(v.textVisible).toBe(true);
    });

    it('RENDERED: a picture that really decoded marks itself; only then may the bare link text hide', async () => {
        api.fetchBinary.mockResolvedValue({ bytes: GIF_PIXELS, mimeType: 'image/png' });
        await mount(h(Message, { text: 'https://cdn.discordapp.com/attachments/1/2/a.png' }));
        const img = host.querySelector('img')!;
        Object.defineProperty(img, 'naturalWidth', { value: 64 });
        Object.defineProperty(img, 'naturalHeight', { value: 48 });
        await act(async () => { img.dispatchEvent(new Event('load')); });
        await flush();
        const v = verdict();
        expect(v.rendered).toBe(true);
        expect(v.textVisible).toBe(false); // hidden by the CSS rule, legitimately
    });

    it('sender embed with a COPY whose download fails, no picture: the card; with the sender\'s picture: the picture', async () => {
        const e: LinkEmbed = { url: DISCORD_GIF, kind: 'image', site: 'cdn.discordapp.com', media: { url: DISCORD_GIF, mime: 'image/gif', width: 128, height: 128, animated: true, file: FILE } };
        await mount(h(Message, { text: DISCORD_GIF, embeds: [e], sender: e }));
        assertRule(verdict(), 'copy failed');
        expect(host.querySelector('[data-embed-fallback="failed"]')).toBeTruthy();
        // Never Discord: only our attachment download.
        expect(api.fetchBinary).not.toHaveBeenCalled();
        expect(dl.calls).toEqual([FILE.attachment_id]);
    });

    it('sender embed with a COPY still decrypting: a skeleton in the GIF\'s own box, and the link', async () => {
        dl.mode = 'hang';
        const e: LinkEmbed = { url: DISCORD_GIF, kind: 'image', site: 'cdn.discordapp.com', media: { url: DISCORD_GIF, mime: 'image/gif', width: 128, height: 128, file: FILE } };
        await mount(h(Message, { text: DISCORD_GIF, embeds: [e], sender: e }));
        const v = verdict();
        assertRule(v, 'copy pending');
        expect(v.rendered).toBe(false);
        expect(api.fetchBinary).not.toHaveBeenCalled();
    });

    it('KLIPY page link, viewer NOT opted in: tap-to-load, the link visible, nothing loaded from KLIPY', async () => {
        const url = 'https://klipy.com/gifs/livvy-dunne';
        const e: LinkEmbed = { url, kind: 'image', site: 'KLIPY', title: 'KLIPY: Livvy Dunne GIF', media: { url: 'https://static2.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/1d/1b/H3If9Bb35lxCdqQAOo.gif', mime: 'image/gif', width: 281, height: 374, animated: true } };
        await mount(h(Message, { text: url, embeds: [e], sender: e }));
        const v = verdict();
        assertRule(v, 'klipy not opted in');
        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toMatch(/KLIPY/);
    });

    it('a GIF loop on any site that fails to register: the card (GifLoopEmbed returned null before)', async () => {
        env.autoLoad = 'always';
        const url = 'https://cdn.example/v/loop';
        const e: LinkEmbed = { url, kind: 'video', site: 'cdn.example', media: { url, mime: 'video/mp4', loop: true, width: 320, height: 240 } };
        await mount(h(Message, { text: url, embeds: [e], sender: e }));
        assertRule(verdict(), 'loop failed');
        expect(api.registerMedia).toHaveBeenCalledWith(url, 'video');
        expect(host.querySelector('[data-embed-fallback]')).toBeTruthy();
    });

    it('a Tenor loop that cannot resolve: the card, not nothing', async () => {
        const url = 'https://tenor.com/view/morning-cat-gif-3162456205570563299';
        await mount(h(Message, { text: url }));
        assertRule(verdict(), 'tenor failed');
        expect(host.querySelector('[data-embed-fallback]')).toBeTruthy();
    });

    it('a video with a copy: the clip card is visible (videos load on click), the link visible', async () => {
        const url = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=656a5c4b&is=6557e74b&hm=2b';
        const e: LinkEmbed = { url, kind: 'video', site: 'cdn.discordapp.com', media: { url, mime: 'video/mp4', width: 192, height: 108, duration_s: 20, file: { ...FILE, byte_size: 112893 } } };
        await mount(h(Message, { text: url, embeds: [e], sender: e }));
        assertRule(verdict(), 'video copy idle');
        expect(dl.calls).toEqual([]); // nothing before play
    });
});

describe('the CSS rule and the bare-link decision', () => {
    it('formatting.css hides .cl-bare-media-text only under a rendered embed', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'formatting.css'), 'utf8');
        expect(css).toContain('.cl-msg-col:has(.cl-embed-row [data-embed-rendered="media"]) .cl-bare-media-text{display:none}');
        // No other rule hides it.
        expect(css.match(/cl-bare-media-text/g)).toHaveLength(1);
    });

    it('bare media links: direct images, GIF hosts, sender image / loop embeds; not pages, not text + link', () => {
        expect(isBareMediaLinkMessage(DISCORD_GIF)).toBe(true);
        expect(isBareMediaLinkMessage('https://tenor.com/view/morning-cat-gif-3162456205570563299')).toBe(true);
        const k: LinkEmbed = { url: 'https://klipy.com/gifs/livvy-dunne', kind: 'image', media: { url: 'https://static2.klipy.com/a.gif', mime: 'image/gif' } };
        expect(isBareMediaLinkMessage('https://klipy.com/gifs/livvy-dunne', [k])).toBe(true);
        expect(isBareMediaLinkMessage('https://klipy.com/gifs/livvy-dunne')).toBe(false);
        expect(isBareMediaLinkMessage(`look ${DISCORD_GIF}`)).toBe(false);
        expect(isBareMediaLinkMessage('https://example.com/article')).toBe(false);
    });

    it('POSITIVE CONTROL: the old rule hid the expired Discord link by its shape while its embed rendered nothing', async () => {
        await mount(h(Message, { text: DISCORD_GIF }));
        const oldRuleHides = /^https?:\/\/\S+$/.test(DISCORD_GIF) && isImageUrl(DISCORD_GIF);
        expect(oldRuleHides).toBe(true);
        expect(verdict().rendered).toBe(false); // → under the old rule: an invisible row
    });
});
