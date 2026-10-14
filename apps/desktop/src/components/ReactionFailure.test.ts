// @vitest-environment jsdom
/**
 * The instant reaction chip, end to end minus the network: the REAL
 * ReactionPill, the real overlay/store, and a fake `send`. Proves what the
 * owner asked for - the chip changes on the click, turns red when the send
 * fails, says so on hover/focus with a Retry, and Retry works - at the DOM, not
 * just in the reducer.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    createReactionStore, applyPendingReactions, type ReactionStore, type ReactionSend, type ReactionIntent,
} from '../utils/pendingReactions';
import { usePendingReactions } from '../hooks/usePendingReactions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ChatPane's import graph reads matchMedia at load (clPhysics); jsdom has none.
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

let ReactionPill: any;
beforeAll(async () => {
    ({ ReactionPill } = await import('./ChatPane'));
}, 60000);

const h = React.createElement;
const ME = 'user-me';
const MINE = [ME];
const CONV = 'dev:channel:c1';
const MSG = 'm1';

let root: Root;
let host: HTMLDivElement;
let store: ReactionStore;
let sends: Array<{ intent: ReactionIntent; resolve: () => void; reject: (e: unknown) => void }>;
let send: ReactionSend;
const baseSetter: { current: (b: Record<string, string[]> | undefined) => void } = { current: () => {} };

/** A message's reactions row wired the way ChatPane wires it. */
function Row({ initial }: { initial: Record<string, string[]> | undefined }) {
    const [base, setB] = useState(initial);
    useLayoutEffect(() => { baseSetter.current = setB; }, [setB]);
    usePendingReactions(store);
    const applied = applyPendingReactions(base, store.forMessage(CONV, MSG), MINE, ME);
    return h('div', null, Object.entries(applied.reactions ?? {}).map(([emoji, ids]) => {
        const f = applied.failures[emoji];
        return h(ReactionPill, {
            key: emoji, emoji, animKey: `${MSG}:${emoji}`, msgId: MSG,
            count: ids.length, hasMine: ids.includes(ME), canReact: true,
            resolveEmoji: undefined, token: null, emojisLoading: false, noServerContext: false,
            onClick: () => store.toggle({ convKey: CONV, msgId: MSG, emoji, baseHas: (base?.[emoji] ?? []).includes(ME), send }),
            onHoverStart: () => {}, onHoverEnd: () => {}, onContextMenuShow: () => {},
            failure: f ? {
                kind: f.kind, reason: f.reason,
                onRetry: () => store.retry(f.key, send),
                onDiscard: () => store.discard(f.key),
            } : null,
        });
    }));
}

const mount = (initial: Record<string, string[]> | undefined) => act(() => { root.render(h(Row, { initial })); });
const chip = () => host.querySelector('button') as HTMLButtonElement | null;
const chipText = () => chip()?.textContent ?? '';
const card = () => document.querySelector('[data-testid="reaction-failure-popover"]') as HTMLElement | null;
const cardButton = (label: string) => [...(card()?.querySelectorAll('button') ?? [])].find(b => b.textContent === label) as HTMLButtonElement | undefined;
const failedChip = () => host.querySelector('[data-reaction-failed="true"]');

beforeEach(() => {
    vi.useFakeTimers();
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }));
    store = createReactionStore();
    sends = [];
    send = (intent, signal) => new Promise<void>((resolve, reject) => {
        sends.push({ intent, resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('canceled')));
    });
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

const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const hover = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
const failSend = async (i = 0, err: unknown = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })) => {
    await act(async () => { sends[i].reject(err); await Promise.resolve(); await Promise.resolve(); });
};

describe('instant', () => {
    it('clicking an existing chip changes the count in the same act, before the send is answered', () => {
        mount({ '👍': ['other'] });
        expect(chipText()).toContain('1');
        click(chip()!);
        expect(chipText()).toContain('2');           // instant
        expect(sends).toHaveLength(1);
        expect(sends[0].intent).toBe('add');
        expect(failedChip()).toBeNull();             // looks sent, not red
    });

    it('clicking my own reaction removes it at once (and the chip with it, when it was the last)', () => {
        mount({ '👍': [ME] });
        click(chip()!);
        expect(chip()).toBeNull();
        expect(sends[0].intent).toBe('remove');
    });

    it('success leaves the chip alone: no flicker, no double count when the confirmed copy lands', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await act(async () => { sends[0].resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect(chipText()).toContain('2');
        // The confirmed state (HTTP fold-in / WS echo) arrives.
        act(() => baseSetter.current({ '👍': ['other', ME] }));
        act(() => store.reconcile(CONV, () => true));
        expect(chipText()).toContain('2');
        expect(host.querySelectorAll('button')).toHaveLength(1);
        expect(failedChip()).toBeNull();
    });
});

describe('failure', () => {
    it('a failed add: the chip turns red and is announced; hovering says it failed, with Retry and Remove', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await failSend();
        expect(failedChip()).not.toBeNull();
        expect(chipText()).toContain('2');           // still counted, not taken back
        expect(chip()!.className).toContain('border-cl-flash');
        expect(chip()!.getAttribute('aria-label')).toContain('Reaction failed to send');
        expect(card()).toBeNull();
        hover(chip()!);
        expect(card()).not.toBeNull();
        expect(card()!.textContent).toContain('Reaction failed to send');
        expect(card()!.textContent).toContain('No connection');
        expect(cardButton('Retry')).toBeDefined();
        expect(cardButton('Remove')).toBeDefined();
    });

    it('Retry: the chip is no longer red, the request goes out again, and success settles', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await failSend();
        hover(chip()!);
        click(cardButton('Retry')!);
        expect(failedChip()).toBeNull();
        expect(card()).toBeNull();
        expect(sends).toHaveLength(2);
        expect(sends[1].intent).toBe('add');
        await act(async () => { sends[1].resolve(); await Promise.resolve(); await Promise.resolve(); });
        act(() => baseSetter.current({ '👍': ['other', ME] }));
        act(() => store.reconcile(CONV, () => true));
        expect(chipText()).toContain('2');
        expect(failedChip()).toBeNull();
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('Remove drops the local reaction: the count goes back, and a lone chip disappears', async () => {
        mount(undefined);
        // An emoji nobody has used: the chip does not exist until the picker adds it.
        act(() => store.toggle({ convKey: CONV, msgId: MSG, emoji: '🎉', baseHas: false, send }));
        expect(chipText()).toContain('1');
        await failSend();
        expect(failedChip()).not.toBeNull();
        hover(chip()!);
        click(cardButton('Remove')!);
        expect(chip()).toBeNull();
    });

    it('a failed REMOVE: the chip comes back red, reads "Couldn\'t remove reaction", offers Retry and Keep', async () => {
        mount({ '👍': ['other', ME] });
        click(chip()!);
        expect(chipText()).toContain('1');           // removed instantly
        await failSend(0, Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' }));
        expect(chipText()).toContain('2');           // restored
        expect(failedChip()).not.toBeNull();
        expect(chip()!.getAttribute('aria-label')).toContain("Couldn't remove reaction");
        hover(chip()!);
        expect(card()!.textContent).toContain("Couldn't remove reaction");
        expect(card()!.textContent).toContain('Timed out');
        expect(cardButton('Keep')).toBeDefined();
        click(cardButton('Retry')!);
        expect(sends[1].intent).toBe('remove');
        expect(chipText()).toContain('1');
    });

    it('a chip stuck for 10 s turns red by itself (same line as the message "!")', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        expect(failedChip()).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(failedChip()).not.toBeNull();
        await act(async () => { sends[0].resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect(failedChip()).toBeNull();             // a late answer clears it
    });
});

describe('keyboard and screen reader', () => {
    it('focusing the red chip shows the card; Enter moves focus to Retry; Escape closes and returns focus', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await failSend();
        act(() => chip()!.focus());
        expect(card()).not.toBeNull();
        click(chip()!);                               // Enter on a <button> is a click
        expect(document.activeElement).toBe(cardButton('Retry'));
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(card()).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5); });
        expect(document.activeElement).toBe(chip());
    });

    it('the red state is not colour-only: the button has an accessible name and a dialog popup', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await failSend();
        expect(chip()!.getAttribute('aria-label')).toMatch(/Reaction failed to send.*Enter for options/);
        expect(chip()!.getAttribute('aria-haspopup')).toBe('dialog');
        hover(chip()!);
        expect(card()!.getAttribute('role')).toBe('dialog');
        expect(card()!.getAttribute('aria-label')).toBe('Reaction failed to send');
    });

    it('a healthy chip carries none of it', () => {
        mount({ '👍': ['other'] });
        expect(chip()!.getAttribute('aria-label')).toBeNull();
        expect(chip()!.className).not.toContain('border-cl-flash');
        expect(host.querySelector('[data-reaction-failed]')).toBeNull();
    });

    it('a click on a red chip opens the card instead of toggling the reaction', async () => {
        mount({ '👍': ['other'] });
        click(chip()!);
        await failSend();
        const before = sends.length;
        click(chip()!);
        expect(card()).not.toBeNull();
        expect(sends).toHaveLength(before);
    });
});
