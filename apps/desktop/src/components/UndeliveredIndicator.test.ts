// @vitest-environment jsdom
/**
 * The red "!" end to end, minus ChatPane (which has no render harness): the
 * hook that decides WHEN a pending message is flagged, driven by fake timers,
 * and the indicator + popover that the flag shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UndeliveredIndicator } from './UndeliveredIndicator';
import { useUndeliveredSends } from '../hooks/useUndeliveredSends';
import { createSendClock, UNDELIVERED_AFTER_MS } from '../utils/undeliveredSend';
import { applySendPatch, type SendMarked } from '../utils/pendingSend';

// ClButton's physics module reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
        matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

type Row = SendMarked & { send_error?: string };
const row = (cid: string, send_state?: 'sending' | 'failed', send_error?: string): Row => ({
    id: cid, content: { client_msg_id: cid }, ...(send_state ? { send_state } : {}), ...(send_error ? { send_error } : {}),
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    vi.useFakeTimers();
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

/** A feed of rows: each shows its text, plus the real indicator when flagged. */
function Feed(props: { rows: Row[]; clock: ReturnType<typeof createSendClock>; onRetry: (id: string) => void; onRowClick?: () => void }) {
    const isUndelivered = useUndeliveredSends(props.rows, props.clock);
    return h('div', null, props.rows.map(r =>
        h('div', { key: r.id, 'data-row': r.id, onClick: props.onRowClick, className: 'row' },
            h('span', null, `msg ${r.id}`),
            isUndelivered(r) && h(UndeliveredIndicator, {
                reason: r.send_state === 'failed' ? r.send_error : undefined,
                onRetry: () => props.onRetry(r.id),
                onDiscard: () => {},
            }),
        )));
}
const indicator = () => host.querySelector('[data-testid="undelivered-indicator"]') as HTMLButtonElement | null;
const popover = () => document.querySelector('[data-testid="undelivered-popover"]') as HTMLElement | null;

describe('pending → "!" after 10 s', () => {
    it('shows nothing while pending, then the "!" at 10 s; the row itself is unstyled either way', () => {
        const clock = createSendClock();
        const rows = [row('a', 'sending')];
        act(() => root.render(h(Feed, { rows, clock, onRetry: () => {} })));
        expect(indicator()).toBeNull();
        expect(host.querySelector('.row')!.getAttribute('style')).toBeNull();
        act(() => { vi.advanceTimersByTime(UNDELIVERED_AFTER_MS - 100); });
        expect(indicator()).toBeNull();                      // control: not yet
        act(() => { vi.advanceTimersByTime(200); });
        expect(indicator()).not.toBeNull();                  // flagged by the timer alone, no other re-render
        expect(indicator()!.getAttribute('aria-label')).toBe('Message not delivered');
        expect(indicator()!.textContent).toBe('!');
    });

    it('a definitive failure shows the "!" immediately, with the reason in the popover', () => {
        const clock = createSendClock();
        act(() => root.render(h(Feed, { rows: [row('a', 'failed', 'No connection')], clock, onRetry: () => {} })));
        expect(indicator()).not.toBeNull();
        act(() => indicator()!.click());
        expect(popover()!.textContent).toContain('Message not delivered');
        expect(popover()!.textContent).toContain('No connection');
    });

    it('a late confirmation clears the "!" with no user action', () => {
        const clock = createSendClock();
        let rows: Row[] = [row('a', 'sending')];
        act(() => root.render(h(Feed, { rows, clock, onRetry: () => {} })));
        act(() => { vi.advanceTimersByTime(UNDELIVERED_AFTER_MS + 100); });
        expect(indicator()).not.toBeNull();
        rows = applySendPatch(rows, 'a', { send_state: null });
        act(() => root.render(h(Feed, { rows, clock, onRetry: () => {} })));
        expect(indicator()).toBeNull();
    });

    it('retry: "!" hides while retrying, returns after another 10 s, and a success then clears it', () => {
        const clock = createSendClock();
        let rows: Row[] = [row('a', 'failed', 'Server problem')];
        const render = () => act(() => root.render(h(Feed, { rows, clock, onRetry: (id) => {
            // What ChatPane.retrySend does.
            clock.restart(id);
            rows = applySendPatch(rows, id, { send_state: 'sending' });
            render();
        } })));
        render();
        expect(indicator()).not.toBeNull();
        act(() => indicator()!.click());
        const retryBtn = [...popover()!.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
        act(() => retryBtn.click());
        expect(popover()).toBeNull();                         // popover closed
        expect(indicator()).toBeNull();                       // hidden while retrying
        act(() => { vi.advanceTimersByTime(UNDELIVERED_AFTER_MS - 100); });
        expect(indicator()).toBeNull();                       // clock restarted, not the old one
        act(() => { vi.advanceTimersByTime(200); });
        expect(indicator()).not.toBeNull();                   // still unconfirmed -> flagged again
        rows = applySendPatch(rows, 'a', { send_state: null });
        render();
        expect(indicator()).toBeNull();                       // late success
    });
});

describe('the popover', () => {
    const open = (extra: Partial<Parameters<typeof Feed>[0]> = {}) => {
        const clock = createSendClock();
        const onRetry = vi.fn();
        act(() => root.render(h(Feed, { rows: [row('a', 'failed')], clock, onRetry, ...extra })));
        act(() => indicator()!.click());
        return { onRetry };
    };

    it('says "Message not delivered" and offers Retry and Discard', () => {
        open();
        const p = popover()!;
        expect(p.getAttribute('role')).toBe('dialog');
        expect(p.textContent).toContain('Message not delivered');
        expect([...p.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Retry', 'Discard']);
    });

    it('Retry calls onRetry for that message (control: nothing fires just by opening)', () => {
        const { onRetry } = open();
        expect(onRetry).not.toHaveBeenCalled();
        act(() => [...popover()!.querySelectorAll('button')].find(b => b.textContent === 'Retry')!.click());
        expect(onRetry).toHaveBeenCalledWith('a');
    });

    it('Escape closes it', () => {
        open();
        expect(popover()).not.toBeNull();
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(popover()).toBeNull();
    });

    it('clicking the "!" or the popover does not reach the message row (a row click saves/unsaves the message)', () => {
        const onRowClick = vi.fn();
        open({ onRowClick });
        act(() => popover()!.click());
        expect(onRowClick).not.toHaveBeenCalled();
        act(() => indicator()!.click());   // toggles closed
        expect(onRowClick).not.toHaveBeenCalled();
        // CONTROL: the row handler is genuinely wired — a click on the row's own text reaches it.
        act(() => (host.querySelector('[data-row="a"] span') as HTMLElement).click());
        expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    it('the "!" is a real button with an accessible name, visible without motion (static red glyph)', () => {
        open();
        const b = indicator()!;
        expect(b.tagName).toBe('BUTTON');
        expect(b.getAttribute('aria-haspopup')).toBe('dialog');
        expect(b.className).toContain('bg-cl-flash');
        expect(b.className).not.toMatch(/animate|transition/);
    });
});
