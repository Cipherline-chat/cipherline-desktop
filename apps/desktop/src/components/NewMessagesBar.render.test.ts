// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewMessagesBar, type NewMessagesBarProps } from './NewMessagesBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
});

const render = (p: Partial<NewMessagesBarProps>) => {
    const props: NewMessagesBarProps = { newLabel: null, farFromBottom: false, onJumpToNew: vi.fn(), onJumpToPresent: vi.fn(), ...p };
    act(() => root.render(React.createElement(NewMessagesBar, props)));
    return props;
};
const bar = () => host.querySelector<HTMLButtonElement>('[data-new-messages-bar]');
const live = () => host.querySelector<HTMLElement>('[aria-live]');

describe('NewMessagesBar', () => {
    it('nothing new and near the bottom: no bar, but the live region stays mounted (empty)', () => {
        render({});
        expect(bar()).toBeNull();
        expect(live()).not.toBeNull();
        expect(live()!.getAttribute('aria-live')).toBe('polite');
        expect(live()!.textContent).toBe('');
    });

    it('new messages: a real button with the count, and the count in the polite live region', () => {
        const p = render({ newLabel: '3 new messages since 3:42 PM' });
        const b = bar()!;
        expect(b.tagName).toBe('BUTTON');
        expect(b.getAttribute('type')).toBe('button');
        expect(b.dataset.newMessagesBar).toBe('new');
        expect(b.textContent).toContain('3 new messages since 3:42 PM');
        expect(b.textContent).toContain('Jump');
        expect(b.getAttribute('aria-label')).toBe('3 new messages since 3:42 PM. Jump to the first new message');
        expect(live()!.textContent).toBe('3 new messages since 3:42 PM');
        act(() => b.click());
        expect(p.onJumpToNew).toHaveBeenCalledTimes(1);
        expect(p.onJumpToPresent).not.toHaveBeenCalled();
    });

    it('far up with nothing new: the quiet "viewing older messages" state jumps to present', () => {
        const p = render({ farFromBottom: true });
        const b = bar()!;
        expect(b.dataset.newMessagesBar).toBe('older');
        expect(b.textContent).toContain('Jump to present');
        expect(live()!.textContent).toBe('');   // nothing to announce: nothing arrived
        act(() => b.click());
        expect(p.onJumpToPresent).toHaveBeenCalledTimes(1);
        expect(p.onJumpToNew).not.toHaveBeenCalled();
    });

    it('new messages win the single slot over the far-up state', () => {
        render({ newLabel: '1 new message since 3:42 PM', farFromBottom: true });
        expect(host.querySelectorAll('[data-new-messages-bar]').length).toBe(1);
        expect(bar()!.dataset.newMessagesBar).toBe('new');
    });

    it('the live region is the SAME node across updates (a remounted region is often not announced)', () => {
        render({});
        const before = live();
        render({ newLabel: '2 new messages since 3:42 PM' });
        expect(live()).toBe(before);
        expect(before!.textContent).toBe('2 new messages since 3:42 PM');
    });
});
