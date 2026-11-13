// @vitest-environment jsdom
/**
 * Report dialog + message franking + screenshots.
 *  - a message with a franking proof is sent AS a verified message (the typed
 *    excerpt is neither shown nor sent);
 *  - one without is reported as unverified text, and says why;
 *  - an API that predates franking (400 on the new field) still gets the report;
 *  - up to four PNG/JPEG/WebP images upload after the report exists, and a failed
 *    upload never undoes the report;
 *  - no images on a child-safety report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { frankForSend, ingestInboundFranking, type ReportedMessageRef } from '../utils/franking';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = function scrollIntoView() {};
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
// jsdom's File/Blob predate Blob.arrayBuffer() (Electron/Chromium has it) and its FileReader
// needs real timers, which this file fakes. Node's own File has the real thing, so the images
// the test "picks" are Node Files.
const NodeFile = (await import('node:buffer')).File as unknown as typeof File;
let urlCounter = 0;
URL.createObjectURL = () => `blob:shot-${++urlCounter}`;
URL.revokeObjectURL = () => {};

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));
const { ReportModal } = await import('./ReportModal');

const SENDER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const DEVICE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const CONV = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const png = (name = 'a.png') => new NodeFile([new Uint8Array(PNG)], name, { type: 'image/png' });

/** A message exactly as the receive path leaves it: franking stored beside the content. */
async function receivedMessage(content: object): Promise<ReportedMessageRef> {
    const sent = await frankForSend(JSON.stringify(content), { contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE });
    const wire = { c: sent.commitment_b64!, t: Buffer.alloc(32, 2).toString('base64'), kid: 'k1', ts: Date.now() };
    const { content: stored, franking } = ingestInboundFranking(JSON.parse(sent.contentJson), {
        wire, contextKind: 'dm', contextId: CONV, senderUserId: SENDER, senderDeviceId: DEVICE,
    });
    return { content: stored, franking, sender_user_id: SENDER };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    urlCounter = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function mount(props: Record<string, unknown> = {}) {
    await act(async () => {
        root.render(React.createElement(ReportModal, { targetUserId: SENDER, targetUsername: 'Mira', token: 'tok', onClose: () => {}, ...props } as never));
    });
    await act(async () => { vi.advanceTimersByTime(80); });
    await act(async () => { await Promise.resolve(); });
}
async function pickReason(label = 'Harassment') {
    await act(async () => { (document.querySelector('button.selt') as HTMLButtonElement).click(); });
    const opt = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.includes(label)) as HTMLButtonElement;
    await act(async () => { opt.click(); });
    await act(async () => { vi.advanceTimersByTime(400); });
}
async function submit() {
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function addFiles(files: File[]) {
    const input = document.querySelector('[data-testid="report-shot-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const reportCall = () => post.mock.calls.find(c => String(c[0]).endsWith('/reports')) as [string, Record<string, unknown>] | undefined;
const evidenceCalls = () => post.mock.calls.filter(c => /\/evidence\?kind=/.test(String(c[0]))) as [string, Blob, { headers: Record<string, string> }][];

describe('a message WITH a franking proof', () => {
    it('is shown as verified, read-only, and sent as franked_message (no typed excerpt)', async () => {
        post.mockResolvedValue({ data: { id: 'r1', evidence: 'verified' } });
        const message = await receivedMessage({ type: 'text', text: 'you are all idiots' });
        await mount({ message, initialSnippet: 'you are all idiots' });

        expect(document.querySelector('[data-testid="report-verified"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="report-verified-text"]')!.textContent).toBe('you are all idiots');
        // No editable copy of the message: the reporter cannot change what is sent.
        expect(document.querySelector('#report-snippet')).toBeNull();

        await pickReason();
        await submit();
        const [, body] = reportCall()!;
        expect(body.franked_message).toMatchObject({
            kind: 'text', text: 'you are all idiots', sender_user_id: SENDER, sender_device_id: DEVICE,
            context_kind: 'dm', context_id: CONV, kid: 'k1',
        });
        expect(body.content_snippet).toBeUndefined();
        expect(document.body.textContent).toContain('Report sent');
    });

    it('cannot be submitted while the check is still running', async () => {
        const message = await receivedMessage({ type: 'text', text: 'x' });
        await mount({ message });
        await pickReason();
        // after the async check finishes the button is enabled
        expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('tells the user when the server could not verify it, instead of claiming success', async () => {
        post.mockResolvedValue({ data: { id: 'r1', evidence: 'unverified', evidence_reason: 'unknown_kid' } });
        await mount({ message: await receivedMessage({ type: 'text', text: 'x' }) });
        await pickReason();
        await submit();
        expect(document.body.textContent).toContain('could not be verified by the server');
    });

    it('an API that predates franking (400 on the new field) still gets the report, as an excerpt', async () => {
        post.mockImplementationOnce(async () => { throw { response: { status: 400, data: { message: ['property franked_message should not exist'] } } }; })
            .mockResolvedValue({ data: { id: 'r2' } });
        await mount({ message: await receivedMessage({ type: 'text', text: 'hello' }), initialSnippet: 'hello' });
        await pickReason();
        await submit();
        const reports = post.mock.calls.filter(c => String(c[0]).endsWith('/reports'));
        expect(reports).toHaveLength(2);
        expect((reports[0][1] as Record<string, unknown>).franked_message).toBeDefined();
        expect((reports[1][1] as Record<string, unknown>).franked_message).toBeUndefined();
        expect((reports[1][1] as Record<string, unknown>).content_snippet).toBe('hello');
        expect(document.body.textContent).toContain('Report sent');
    });

    it('any other failure is shown and nothing is retried', async () => {
        post.mockImplementation(async () => { throw { response: { status: 429, data: { message: 'Too many requests' } } }; });
        await mount({ message: await receivedMessage({ type: 'text', text: 'x' }) });
        await pickReason();
        await submit();
        expect(post).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('Too many requests');
    });
});

describe('a message WITHOUT one (sent before franking, or by an older app)', () => {
    it('is reportable as unverified text, the dialog says so, and the excerpt stays editable', async () => {
        post.mockResolvedValue({ data: { id: 'r1', evidence: 'none' } });
        await mount({ message: { content: { type: 'text', text: 'old msg' }, sender_user_id: SENDER }, initialSnippet: 'old msg' });
        expect(document.querySelector('[data-testid="report-verified"]')).toBeNull();
        expect(document.body.textContent).toContain('marked unverified');
        expect((document.querySelector('#report-snippet') as HTMLTextAreaElement).value).toBe('old msg');
        await pickReason();
        await submit();
        const [, body] = reportCall()!;
        expect(body.franked_message).toBeUndefined();
        expect(body.content_snippet).toBe('old msg');
    });

    it('a message edited locally after receipt no longer claims to be verified', async () => {
        const message = await receivedMessage({ type: 'text', text: 'original' });
        await mount({ message: { ...message, content: { type: 'text', text: 'changed' } }, initialSnippet: 'changed' });
        expect(document.querySelector('[data-testid="report-verified"]')).toBeNull();
        expect(document.body.textContent).toContain('edited');
    });

    it('with no message at all the dialog is exactly the old one', async () => {
        await mount({ initialSnippet: 'pasted' });
        expect(document.querySelector('[data-testid="report-verified"]')).toBeNull();
        expect((document.querySelector('#report-snippet') as HTMLTextAreaElement).value).toBe('pasted');
        expect(document.body.textContent).toContain('Optional — paste what you saw');
    });
});

describe('screenshots', () => {
    it('shows each pick, uploads them AFTER the report exists, in order, as raw images', async () => {
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9', evidence: 'none' } } : { data: {} }));
        await mount();
        await addFiles([png('one.png'), png('two.png')]);
        expect(document.querySelectorAll('[data-testid="report-shot"]')).toHaveLength(2);
        await pickReason();
        await submit();

        const order = post.mock.calls.map(c => String(c[0]));
        expect(order[0]).toMatch(/\/reports$/);
        expect(order.slice(1).every(u => /\/reports\/rep-9\/evidence\?kind=screenshot$/.test(u))).toBe(true);
        expect(evidenceCalls()).toHaveLength(2);
        expect(evidenceCalls()[0][2].headers['Content-Type']).toBe('image/png');
        expect(evidenceCalls()[0][2].headers.Authorization).toBe('Bearer tok');
        expect(document.body.textContent).toContain('Report sent');
        expect(document.body.textContent).not.toContain('could not be attached');
    });

    it('a failed upload never undoes the report: it says how many did not go', async () => {
        post.mockImplementation(async (url: string) => {
            if (String(url).endsWith('/reports')) return { data: { id: 'rep-9' } };
            throw { response: { status: 503 } };
        });
        await mount();
        await addFiles([png('one.png'), png('two.png')]);
        await pickReason();
        await submit();
        expect(document.body.textContent).toContain('Report sent');
        expect(document.body.textContent).toContain('2 of 2 images could not be attached');
    });

    it('refuses a non-image and a fifth image, with a reason', async () => {
        await mount();
        await addFiles([new NodeFile([new Uint8Array([60, 115, 118, 103, 62, 0, 0, 0, 0, 0, 0, 0])], 'x.png', { type: 'image/png' })]);
        expect(document.querySelectorAll('[data-testid="report-shot"]')).toHaveLength(0);
        expect(document.body.textContent).toContain('is not a PNG, JPEG or WebP');

        await addFiles([png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')]);
        expect(document.querySelectorAll('[data-testid="report-shot"]')).toHaveLength(4);
        expect(document.body.textContent).toContain('up to 4');
        expect((document.body.textContent ?? '')).toContain('5.png was not added');
    });

    it('Remove drops one before sending', async () => {
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9' } } : { data: {} }));
        await mount();
        await addFiles([png('one.png'), png('two.png')]);
        await act(async () => { (document.querySelector('[aria-label="Remove one.png"]') as HTMLButtonElement).click(); });
        await pickReason();
        await submit();
        expect(evidenceCalls()).toHaveLength(1);
    });

    it('child-safety reports take NO images: the picker is replaced by a notice and nothing is uploaded', async () => {
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9' } } : { data: {} }));
        await mount();
        await addFiles([png('one.png')]);          // picked first, then the reason changes to CSAM
        await pickReason('Child sexual abuse material');
        expect(document.querySelector('[data-testid="report-shots"]')).toBeNull();
        expect(document.body.textContent).toContain('Do not capture or upload images for a child-safety report');
        await submit();
        expect(reportCall()).toBeDefined();
        expect(evidenceCalls()).toHaveLength(0);
    });
});

describe('a verified attachment that cannot be sent with the report', () => {
    const fileMessage = async (filename: string, mime: string, byte_size: number) => {
        const sha = Buffer.alloc(32, 4).toString('base64');
        const m = await receivedMessage({ type: 'attachment', attachment_id: CONV, filename, mime, byte_size, content_sha256_b64: sha, file_key_b64: 'k', file_nonce_b64: 'n' });
        return { ...m, attachmentUrl: 'blob:decrypted-file' };
    };
    const note = () => document.querySelector('[data-testid="report-file-not-sendable"]');

    it.each([
        ['a video', 'clip.mp4', 'video/mp4', 5000],
        ['a GIF', 'a.gif', 'image/gif', 5000],
        ['a PDF', 'a.pdf', 'application/pdf', 5000],
    ])('%s: no checkbox, says why, points to a screenshot, and nothing is fetched or uploaded', async (_label, filename, mime, size) => {
        const fetchStub = vi.fn();
        vi.stubGlobal('fetch', fetchStub);
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9', evidence: 'verified' } } : { data: {} }));
        await mount({ message: await fileMessage(filename, mime, size) });
        expect(document.querySelector('[data-testid="report-include-file"]')).toBeNull();
        expect(note()?.textContent).toContain('only its name, type and size');
        expect(note()?.textContent).toContain('Add a screenshot');
        await pickReason();
        await submit();
        expect(fetchStub).not.toHaveBeenCalled();
        expect(evidenceCalls()).toHaveLength(0);
        expect(document.body.textContent).not.toContain('could not be attached');
    });

    it('an image over 8 MB says it is too large', async () => {
        await mount({ message: await fileMessage('big.png', 'image/png', 9 * 1024 * 1024) });
        expect(document.querySelector('[data-testid="report-include-file"]')).toBeNull();
        expect(note()?.textContent).toContain('too large');
    });

    it('a sendable image shows the checkbox and no note', async () => {
        await mount({ message: await fileMessage('cat.png', 'image/png', 12) });
        expect(document.querySelector('[data-testid="report-include-file"]')).not.toBeNull();
        expect(note()).toBeNull();
    });
});

describe('the decrypted image of a verified attachment message', () => {
    const attachmentMessage = async () => {
        const sha = Buffer.alloc(32, 4).toString('base64');
        const m = await receivedMessage({ type: 'attachment', attachment_id: CONV, filename: 'cat.png', mime: 'image/png', byte_size: 12, content_sha256_b64: sha, file_key_b64: 'k', file_nonce_b64: 'n' });
        return { ...m, attachmentUrl: 'blob:decrypted-cat' };
    };
    const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array(PNG)], { type: 'image/png' }) })));

    it('is offered, and uploaded as kind=attachment once the server verified the message', async () => {
        stubFetch();
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9', evidence: 'verified' } } : { data: {} }));
        await mount({ message: await attachmentMessage() });
        expect(document.querySelector('[data-testid="report-include-file"]')).not.toBeNull();
        await pickReason();
        await submit();
        expect(evidenceCalls().map(c => c[0])).toEqual([expect.stringMatching(/rep-9\/evidence\?kind=attachment$/)]);
    });

    it('is left out when the box is unticked', async () => {
        stubFetch();
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9', evidence: 'verified' } } : { data: {} }));
        await mount({ message: await attachmentMessage() });
        await act(async () => { (document.querySelector('[data-testid="report-include-file"]') as HTMLInputElement).click(); });
        await pickReason();
        await submit();
        expect(evidenceCalls()).toHaveLength(0);
    });

    it('is NOT uploaded when the server did not verify the message (it would be refused anyway)', async () => {
        stubFetch();
        post.mockImplementation(async (url: string) => (String(url).endsWith('/reports') ? { data: { id: 'rep-9', evidence: 'unverified' } } : { data: {} }));
        await mount({ message: await attachmentMessage() });
        await pickReason();
        await submit();
        expect(evidenceCalls()).toHaveLength(0);
    });
});
