// @vitest-environment jsdom
/**
 * "Import from a Discord template" inside Create Server, mounted for real with
 * the API calls faked by the real preview the API produces for
 * discord.new/BX8jqYy8vu3y. What must hold:
 *   - the option is offered from "Create a Server" and Back returns to it;
 *   - a link that can't be a template never reaches the API;
 *   - preview: editable name (pre-filled), the channel tree split into text /
 *     Calls with private markers, roles, warnings, and a keyboard-operable
 *     "What won't be imported" disclosure;
 *   - Create sends ONLY { code, name } (no blueprint) and closes the modal;
 *   - preview / import failures show their copy and keep the user's place;
 *   - "Use a different link" goes back to the link step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

vi.mock('../../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));

const { CreateServerModal } = await import('./CreateServerModal');
type Preview = import('../../utils/discordTemplate').DiscordTemplatePreview;
// jsdom's import.meta.url is not a file: URL — resolve from the package root
// vitest runs in (apps/desktop).
const PREVIEW = JSON.parse(readFileSync(
    join(process.cwd(), 'src/utils/__fixtures__/discordTemplatePreview.BX8.json'), 'utf8',
)) as Preview;

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
const onCreateServer = vi.fn();
const onPreviewTemplate = vi.fn();
const onImportTemplate = vi.fn();

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const f of [onClose, onCreateServer, onPreviewTemplate, onImportTemplate]) f.mockReset();
    onPreviewTemplate.mockResolvedValue(PREVIEW);
    onImportTemplate.mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const btn = (re: RegExp) => Array.from(document.querySelectorAll('button')).find(b => re.test(b.textContent ?? '') || re.test(b.getAttribute('aria-label') ?? '')) as HTMLButtonElement | undefined;
const input = (label: RegExp) => {
    const l = Array.from(document.querySelectorAll('label')).find(x => label.test(x.textContent ?? ''))!;
    return document.getElementById(l.htmlFor) as HTMLInputElement;
};
function type(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() {
    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
}
async function click(b: HTMLButtonElement | undefined) {
    expect(b).toBeDefined();
    await act(async () => { b!.click(); });
    await flush();
}
async function mount() {
    act(() => root.render(React.createElement(CreateServerModal, {
        onClose, onCreateServer, onPreviewTemplate, onImportTemplate, token: 'tok',
    })));
    await flush();
    // Let ClModal's open-time auto-focus (one animation frame) happen first, as
    // it always has by the time a person has pasted a link.
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
}
async function toPreview() {
    await mount();
    await click(btn(/Import from a Discord template/));
    type(input(/Discord template link/), '  https://discord.new/BX8jqYy8vu3y ');
    await submit();
}

describe('Create Server → Import from a Discord template', () => {
    it('is offered from Create a Server, and Back returns to it', async () => {
        await mount();
        expect(text()).toContain('Create a Server');
        await click(btn(/Import from a Discord template/));
        expect(text()).toContain('your device never connects to Discord');
        await click(btn(/^Back$/));
        expect(text()).toContain('Server name');
        expect(onPreviewTemplate).not.toHaveBeenCalled();
    });

    it('never sends a link that cannot be a template', async () => {
        await mount();
        await click(btn(/Import from a Discord template/));
        type(input(/Discord template link/), 'https://discord.com.evil.tld/template/BX8jqYy8vu3y');
        await submit();
        expect(onPreviewTemplate).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/Paste a Discord template link/);
    });

    it('previews the template: name, channel tree, roles, warnings, skipped list', async () => {
        await toPreview();
        expect(onPreviewTemplate).toHaveBeenCalledWith('https://discord.new/BX8jqYy8vu3y');
        expect(input(/Server name/).value).toBe('Fusion');
        expect(document.activeElement).toBe(input(/Server name/));
        for (const n of ['Text channels', 'Calls', 'Primary Channels', 'general_chat', 'Private Voice', 'Admin', 'Bots', '@everyone']) {
            expect(text()).toContain(n);
        }
        expect(document.querySelectorAll('[aria-label="Private"]').length).toBeGreaterThanOrEqual(4);
        expect(text()).toContain('have Administrator');
        const toggle = btn(/What won’t be imported \(9\)/)!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(text()).not.toContain('Cipherline has no slowmode');
        await click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
        expect(text()).toContain('#self_promotion: slowmode (6h)');
        expect(text()).toContain('Cipherline has no slowmode');
    });

    it('previews channel icons as picker icons (the # / speaker default when none fits), never emoji', async () => {
        await toPreview();
        const row = (name: string) => Array.from(document.querySelectorAll('li'))
            .find(li => li.querySelector('span.truncate')?.textContent === name) as HTMLElement;
        const iconClass = (name: string) => row(name).querySelector('svg')?.getAttribute('class') ?? '';
        expect(iconClass('general_chat')).toContain('lucide-message-square');   // Discord 💬
        expect(iconClass('music_commands')).toContain('lucide-music');          // Discord 🎵
        // Discord 🚪 / 🚗 have no picker equivalent -> the default speaker for a call
        const unmapped = PREVIEW.blueprint.channels.filter(c => c.icon_name === null);
        expect(unmapped.length).toBeGreaterThan(0);
        for (const c of unmapped) {
            const cls = iconClass(c.name);
            expect(cls).toContain(c.kind === 'text' ? 'lucide-hash' : 'lucide-volume-2');
        }
        // no emoji anywhere in the channel tree
        for (const li of Array.from(document.querySelectorAll('li'))) {
            expect(li.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
        }
    });

    it('creates with only the code and the (edited) name, then closes', async () => {
        await toPreview();
        type(input(/Server name/), 'Fusion 🔥 Club');
        expect(input(/Server name/).value).toBe('Fusion  Club');
        await submit();
        expect(onImportTemplate).toHaveBeenCalledTimes(1);
        expect(onImportTemplate.mock.calls[0][0]).toEqual({ code: 'BX8jqYy8vu3y', name: 'Fusion  Club' });
        act(() => { vi.advanceTimersByTime(400); });
        expect(onClose).toHaveBeenCalled();
    });

    it('shows a preview failure and stays on the link step', async () => {
        onPreviewTemplate.mockRejectedValueOnce({ response: { status: 404, data: { code: 'TEMPLATE_NOT_FOUND' } } });
        await toPreview();
        expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/doesn’t exist or was deleted/);
        expect(input(/Discord template link/).value).toBe('  https://discord.new/BX8jqYy8vu3y ');
        expect(text()).not.toContain('Server name');
    });

    it('shows an import failure and keeps the preview', async () => {
        onImportTemplate.mockRejectedValueOnce({ response: { status: 429, data: {} } });
        await toPreview();
        await submit();
        expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/Too many tries/);
        expect(input(/Server name/).value).toBe('Fusion');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('"Use a different link" goes back to the link step', async () => {
        await toPreview();
        await click(btn(/Use a different link/));
        expect(input(/Discord template link/)).not.toBeNull();
    });
});
