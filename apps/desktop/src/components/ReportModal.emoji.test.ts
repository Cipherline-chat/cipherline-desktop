// @vitest-environment jsdom
/**
 * Report dialog + custom emoji in the reported message (utils/reportEmoji.ts):
 *  - the preview draws each `<:name:id>` token as its picture and lists
 *    "Emoji in this message" with what our team will see;
 *  - personal emoji images (only this device has them) upload after the report
 *    exists, to the report's emoji route, capped and only for emoji that are in
 *    the reported message;
 *  - server emoji are NOT uploaded (the API copies its own image);
 *  - nothing on a child-safety report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { frankForSend, ingestInboundFranking, type ReportedMessageRef } from '../utils/franking';
import { personalEmojiIdFromBytes } from '../utils/personalEmoji/token';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = function scrollIntoView() {};
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
let urlCounter = 0;
URL.createObjectURL = () => `blob:emoji-${++urlCounter}`;
URL.revokeObjectURL = () => {};

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));
// The real EmojiImage decrypts through the network loader; the preview only needs to know it was asked.
vi.mock('./server/EmojiImage', () => ({
    EmojiImage: (p: { name: string; attachmentId: string }) => React.createElement('img', { 'data-testid': 'server-emoji-img', alt: p.name, 'data-att': p.attachmentId }),
    EmojiPlaceholder: () => null,
    MissingEmojiPlaceholder: () => null,
}));
const { ReportModal } = await import('./ReportModal');
const { emojiListCache } = await import('../utils/emojiListCache');

const SENDER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const DEVICE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const CONV = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SRV_EMOJI = '0f1e2d3c-4b5a-4968-8776-655443322110';
const png = (n: number) => { const b = new Uint8Array(24); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[8] = n; return b; };

async function receivedMessage(content: object, franked = true): Promise<ReportedMessageRef> {
    if (!franked) return { content, franking: null, sender_user_id: SENDER };
    const sent = await frankForSend(JSON.stringify(content), { contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE });
    const wire = { c: sent.commitment_b64!, t: Buffer.alloc(32, 2).toString('base64'), kid: 'k1', ts: Date.now() };
    const { content: stored, franking } = ingestInboundFranking(JSON.parse(sent.contentJson), {
        wire, contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE,
    });
    return { content: stored, franking, sender_user_id: SENDER };
}

let root: Root;
let host: HTMLDivElement;
let mine: { id: string; bytes: Uint8Array };
let notHere: { id: string; bytes: Uint8Array };
let store: { read: ReturnType<typeof vi.fn> };
beforeEach(async () => {
    vi.useFakeTimers();
    post.mockReset();
    urlCounter = 0;
    mine = { bytes: png(1), id: '' };
    mine.id = await personalEmojiIdFromBytes(mine.bytes);
    notHere = { bytes: png(2), id: '' };
    notHere.id = await personalEmojiIdFromBytes(notHere.bytes);
    store = { read: vi.fn(async (id: string) => (id === mine.id ? mine.bytes : null)) };
    emojiListCache.set('srv-1', [{
        emoji_id: SRV_EMOJI, server_id: 'srv-1', name: 'clown', attachment_id: 'att-1', key_b64: 'k', nonce_b64: 'n',
        animated: false, created_by: null, created_at: '2026-11-01T00:00:00Z',
    }]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; emojiListCache.delete('srv-1'); vi.useRealTimers(); });

async function settle(n = 8) { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); }
/** The personal-emoji image is decrypted asynchronously (WebCrypto + blob URL), which on a loaded machine can take
 *  longer than a fixed number of microtask ticks. Wait (fake-timer aware) until the message preview has drawn it. */
async function waitForEmojiPreview() {
    await vi.waitFor(async () => {
        await act(async () => { await Promise.resolve(); });
        if (!document.querySelector('[data-testid="report-verified-text"] [data-testid="report-emoji-img"]')) throw new Error('emoji preview not drawn yet');
    }, { timeout: 15_000, interval: 20 });
}
async function mount(props: Record<string, unknown> = {}) {
    await act(async () => {
        root.render(React.createElement(ReportModal, { targetUserId: SENDER, targetUsername: 'Mira', token: 'tok', onClose: () => {}, emojiStore: store, ...props } as never));
    });
    await act(async () => { vi.advanceTimersByTime(80); });
    await settle();
}
async function pickReason(label = 'Harassment') {
    await act(async () => { (document.querySelector('button.selt') as HTMLButtonElement).click(); });
    const opt = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes(label)) as HTMLButtonElement;
    await act(async () => { opt.click(); });
    await act(async () => { vi.advanceTimersByTime(400); });
    await settle();
}
async function submit() {
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle(12);
}
const emojiCalls = () => post.mock.calls.filter(c => /\/reports\/[^/]+\/emoji\?/.test(String(c[0]))) as [string, Blob, { headers: Record<string, string> }][];
const rows = () => [...document.querySelectorAll('[data-testid="report-emoji-row"]')] as HTMLElement[];

describe('a verified message with a server emoji and personal emoji', () => {
    const text = () => `you <:clown:${SRV_EMOJI}> are <:mine:${mine.id}> and <:gone:${notHere.id}>`;

    it('draws the emoji in the message preview instead of raw tokens', async () => {
        await mount({ message: await receivedMessage({ type: 'text', text: text() }) });
        await waitForEmojiPreview();
        const box = document.querySelector('[data-testid="report-verified-text"]')!;
        expect(box.textContent).not.toContain('<:');
        const personalImg = box.querySelector(`[data-testid="report-emoji-img"][data-emoji-id="${mine.id}"]`) as HTMLImageElement;
        expect(personalImg).not.toBeNull();
        expect(personalImg.getAttribute('src')).toMatch(/^blob:emoji-/);
        expect(personalImg.getAttribute('alt')).toBe(':mine:');
        expect(box.querySelector('[data-testid="server-emoji-img"]')?.getAttribute('alt')).toBe('clown');
        // Not on this device: shown by name, not as a raw token and not as nothing.
        expect(box.querySelector('[data-testid="report-emoji-missing"]')?.textContent).toBe(':gone:');
    });

    it('lists "Emoji in this message" with what our team will see of each', async () => {
        await mount({ message: await receivedMessage({ type: 'text', text: text() }) });
        await waitForEmojiPreview();
        const list = rows();
        expect(list.map(r => r.getAttribute('data-emoji-source'))).toEqual(['server', 'personal', 'personal']);
        expect(list[0].textContent).toContain(':clown:');
        expect(list[0].textContent).toContain('our team sees Cipherline’s copy');
        expect(list[1].textContent).toContain('this image is sent with your report');
        expect(list[2].textContent).toContain('not on this device, only its name is sent');
        expect(document.querySelector('[data-testid="report-emoji"]')!.closest('.dlg-field, div')!.parentElement!.textContent).toContain('1 image included');
    });

    it('uploads ONLY the personal emoji this device has, after the report exists; server emoji are not uploaded', async () => {
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'r1', evidence: 'verified' } } : { data: {} }));
        await mount({ message: await receivedMessage({ type: 'text', text: text() }) });
        await pickReason();
        await submit();
        const calls = emojiCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toMatch(new RegExp(`/reports/r1/emoji\\?emoji_id=${mine.id}&emoji_name=mine$`));
        expect(calls[0][1].size).toBe(mine.bytes.length);
        expect(calls[0][2].headers['Content-Type']).toBe('image/png');
        // Order: the report first, then the emoji.
        const order = post.mock.calls.map(c => String(c[0]));
        expect(order.findIndex(u => u.endsWith('/reports'))).toBeLessThan(order.findIndex(u => u.includes('/emoji?')));
        expect(post.mock.calls.some(c => String(c[0]).includes(SRV_EMOJI))).toBe(false);
        expect(document.body.textContent).toContain('Report sent');
    });

    it('a failed emoji upload never undoes the report, and says so', async () => {
        post.mockImplementation(async (url: string) => {
            if (String(url).endsWith('/reports')) return { data: { id: 'r1', evidence: 'verified' } };
            throw new Error('503');
        });
        await mount({ message: await receivedMessage({ type: 'text', text: text() }) });
        await pickReason();
        await submit();
        expect(document.body.textContent).toContain('Report sent');
        expect(document.body.textContent).toContain('1 of 1 emoji image could not be attached');
    });

    it('nothing is uploaded on a child-safety report, and the list says names only', async () => {
        post.mockResolvedValue({ data: { id: 'r1', evidence: 'verified' } });
        await mount({ message: await receivedMessage({ type: 'text', text: text() }) });
        await pickReason('Child sexual abuse');
        expect(rows()[1].textContent).toContain('only its name is sent with this kind of report');
        expect(document.querySelector('[data-testid="report-emoji-list"] [data-testid="report-emoji-img"]')).toBeNull();
        await submit();
        expect(emojiCalls()).toHaveLength(0);
    });
});

describe('only emoji in the reported message are included', () => {
    it('an unverified message: an emoji the reporter removes from the excerpt is not sent', async () => {
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'r2', evidence: 'none' } } : { data: {} }));
        const t = `look <:mine:${mine.id}>`;
        await mount({ message: await receivedMessage({ type: 'text', text: t }, false), initialSnippet: t });
        expect(rows()).toHaveLength(1);
        const ta = document.querySelector('#report-snippet') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        await act(async () => { setter.call(ta, 'look'); ta.dispatchEvent(new Event('input', { bubbles: true })); });
        await settle();
        expect(rows()).toHaveLength(0);
        await pickReason();
        await submit();
        expect(emojiCalls()).toHaveLength(0);
    });

    it('control: a report with no message (Report User) never reads the emoji store', async () => {
        await mount({ initialSnippet: `<:mine:${mine.id}>` });
        expect(rows()).toHaveLength(0);
        expect(store.read).not.toHaveBeenCalled();
    });

    it('control: a plain-text message shows no emoji section', async () => {
        await mount({ message: await receivedMessage({ type: 'text', text: 'no emoji' }) });
        expect(document.querySelector('[data-testid="report-emoji"]')).toBeNull();
        expect(document.querySelector('[data-testid="report-verified-text"]')!.textContent).toBe('no emoji');
    });
});
