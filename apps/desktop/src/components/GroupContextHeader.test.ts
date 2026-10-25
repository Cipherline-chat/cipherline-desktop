// @vitest-environment jsdom
/**
 * The right-hand panel's group card: name + member count over the group
 * picture (blurred + darkened). The picture only ever arrives through
 * useEncryptedAvatar (decrypted client-side, blob: URL); without one — none,
 * still loading, or failed to decode — the card is the plain card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let resolved: string | null = null;
const seenIds: Array<string | null | undefined> = [];
const evict = vi.fn();
vi.mock('../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: (id: string | null | undefined) => { seenIds.push(id); return id ? resolved : null; },
    evictAvatar: (id: string) => evict(id),
}));

const { GroupContextHeader, memberCountLabel } = await import('./GroupContextHeader');

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
beforeEach(() => {
    resolved = null;
    seenIds.length = 0;
    evict.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mounted = true;
});
afterEach(() => { if (mounted) act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const render = (props: Partial<React.ComponentProps<typeof GroupContextHeader>> = {}) =>
    act(() => root.render(React.createElement(GroupContextHeader, { title: 'Sheesh', memberCount: 3, avatarUrl: 'att-1', token: 'tok', ...props })));
const backdrop = () => host.querySelector('[data-testid="group-backdrop"]') as HTMLElement;
const img = () => host.querySelector('img') as HTMLImageElement | null;

describe('memberCountLabel', () => {
    it('pluralises: 1 member, otherwise N members', () => {
        expect(memberCountLabel(1)).toBe('1 member');
        expect(memberCountLabel(2)).toBe('2 members');
        expect(memberCountLabel(0)).toBe('0 members');
        expect(memberCountLabel(200)).toBe('200 members');
    });
});

describe('GroupContextHeader', () => {
    it('shows the title and a correctly pluralised count', () => {
        render({ memberCount: 1 });
        expect(host.textContent).toContain('Sheesh');
        expect(host.textContent).toContain('1 member');
        expect(host.textContent).not.toContain('1 members');
        render({ memberCount: 4 });
        expect(host.textContent).toContain('4 members');
    });

    it('FALLBACK: no picture -> no <img>, backdrop not loaded (the plain card)', () => {
        render({ avatarUrl: null });
        expect(img()).toBeNull();
        expect(backdrop().dataset.loaded).toBe('false');
        expect(host.textContent).toContain('Sheesh');
    });

    it('FALLBACK: picture still downloading/decrypting -> plain card, no <img>', () => {
        resolved = null; // hook has an id but no URL yet
        render({ avatarUrl: 'att-1' });
        expect(seenIds).toContain('att-1'); // it does ask, via the decrypting hook
        expect(img()).toBeNull();
        expect(backdrop().dataset.loaded).toBe('false');
    });

    it('with a decrypted picture: renders it as the (aria-hidden) backdrop, loaded only after the image paints', () => {
        resolved = 'blob:http://localhost/abc';
        render();
        expect(backdrop().getAttribute('aria-hidden')).toBe('true');
        expect(img()?.getAttribute('src')).toBe('blob:http://localhost/abc');
        expect(img()?.getAttribute('alt')).toBe('');
        expect(backdrop().dataset.loaded).toBe('false'); // not yet decoded -> text keeps the plain colours
        act(() => { img()!.dispatchEvent(new Event('load')); });
        expect(backdrop().dataset.loaded).toBe('true');
    });

    it('never puts a non-image / plaintext-server URL in an <img> (safeImageSrc gate)', () => {
        resolved = 'http://evil.example/p.png';
        render();
        expect(img()).toBeNull();
        resolved = 'javascript:alert(1)';
        render();
        expect(img()).toBeNull();
    });

    it('a picture that fails to decode is evicted and the card falls back to plain', () => {
        resolved = 'blob:http://localhost/bad';
        render();
        act(() => { img()!.dispatchEvent(new Event('load')); });
        act(() => { img()!.dispatchEvent(new Event('error')); });
        expect(evict).toHaveBeenCalledWith('att-1');
        expect(img()).toBeNull();
        expect(backdrop().dataset.loaded).toBe('false');
    });

    it('does NOT revoke the shared cache blob URL on unmount (the avatar cache owns it)', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        resolved = 'blob:http://localhost/shared';
        render();
        act(() => root.unmount());
        mounted = false;
        expect(revoke).not.toHaveBeenCalled();
    });
});
