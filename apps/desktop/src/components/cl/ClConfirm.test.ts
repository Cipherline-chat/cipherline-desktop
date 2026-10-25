// @vitest-environment jsdom
/**
 * ClConfirm — the house confirm dialog.
 *
 * Pinned: the keyboard model (focus starts on the SAFE button — Cancel for a
 * destructive confirm, the confirm button otherwise — so Enter does what the
 * tone implies; Esc cancels), the props contract every call site relies on
 * (confirmLabel / cancelLabel / danger / loading / children / width), and the
 * icon-tile tone. Each behavioural claim has a control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { ClConfirm } = await import('./ClConfirm');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const settle = async (ms = 250) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const btn = (re: RegExp) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => re.test(b.textContent?.trim() ?? ''));
const pressEscape = () => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

type Props = React.ComponentProps<typeof ClConfirm>;
async function mount(extra: Partial<Props> = {}) {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    act(() => root.render(React.createElement(ClConfirm, {
        open: true, onClose, onConfirm, title: 'Delete #general?', message: 'This cannot be undone.', ...extra,
    })));
    await settle();
    return { onClose, onConfirm };
}

describe('ClConfirm', () => {
    it('renders a labelled dialog with the title, message, Cancel and the confirm button', async () => {
        await mount({ confirmLabel: 'Delete channel' });
        expect(dialog()?.getAttribute('aria-label')).toBe('Delete #general?');
        expect(dialog()?.querySelector('h2')?.textContent).toBe('Delete #general?');
        expect(dialog()?.textContent).toContain('This cannot be undone.');
        expect(btn(/^Cancel$/)).toBeDefined();
        expect(btn(/^Delete channel$/)).toBeDefined();
    });

    it('uses the default labels when none are given, and honours custom ones', async () => {
        await mount();
        expect(btn(/^Confirm$/)).toBeDefined();
        expect(btn(/^Cancel$/)).toBeDefined();
        act(() => root.unmount());
        root = createRoot(host);
        await mount({ confirmLabel: 'Leave & install', cancelLabel: 'Stay' });
        expect(btn(/^Leave & install$/)).toBeDefined();
        expect(btn(/^Stay$/)).toBeDefined();
        expect(btn(/^Cancel$/)).toBeUndefined();
    });

    it('DESTRUCTIVE: initial focus is on Cancel, so a stray Enter cannot confirm', async () => {
        const { onClose, onConfirm } = await mount({ danger: true, confirmLabel: 'Delete' });
        expect(document.activeElement).toBe(btn(/^Cancel$/));
        // Enter on a focused button is a click on it — drive exactly that.
        act(() => (document.activeElement as HTMLElement).click());
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('CONTROL — non-destructive: initial focus is on the confirm button, so Enter confirms', async () => {
        const { onClose, onConfirm } = await mount({ confirmLabel: 'Remove friend' });
        expect(document.activeElement).toBe(btn(/^Remove friend$/));
        act(() => (document.activeElement as HTMLElement).click());
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape cancels (onClose) and never confirms', async () => {
        const { onClose, onConfirm } = await mount({ danger: true });
        pressEscape();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('danger: the confirm button is the danger variant and the icon tile is danger-toned', async () => {
        await mount({ danger: true, confirmLabel: 'Delete' });
        expect(btn(/^Delete$/)?.closest('.clb')?.classList.contains('clb--danger')).toBe(true);
        expect(dialog()?.querySelector('.dlg-head-icon--danger')).not.toBeNull();
    });

    it('CONTROL — not danger: primary button, default-toned tile', async () => {
        await mount({ confirmLabel: 'Go' });
        expect(btn(/^Go$/)?.closest('.clb')?.classList.contains('clb--danger')).toBe(false);
        expect(dialog()?.querySelector('.dlg-head-icon--danger')).toBeNull();
        expect(dialog()?.querySelector('.dlg-head-icon')).not.toBeNull();
    });

    it('loading: Cancel and the confirm button are both disabled (no double submit, no cancel mid-flight)', async () => {
        const { onClose, onConfirm } = await mount({ danger: true, loading: true, confirmLabel: 'Delete' });
        expect((btn(/^Cancel$/) as HTMLButtonElement).disabled).toBe(true);
        expect(dialog()?.querySelectorAll('button[disabled]').length).toBeGreaterThanOrEqual(2);
        act(() => btn(/^Cancel$/)?.click());
        expect(onClose).not.toHaveBeenCalled();
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('children render between the message and the footer; hint and a custom icon are shown', async () => {
        await mount({
            hint: 'Hold Shift to skip this',
            icon: React.createElement('span', { 'data-testid': 'custom-icon' }),
            children: React.createElement('input', { 'data-testid': 'reason', placeholder: 'Reason' }),
        });
        expect(document.querySelector('[data-testid="reason"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="custom-icon"]')).not.toBeNull();
        expect(dialog()?.querySelector('.dlg-foot-hint')?.textContent).toBe('Hold Shift to skip this');
    });

    it('closed: renders nothing', async () => {
        await mount({ open: false });
        expect(dialog()).toBeNull();
    });
});
