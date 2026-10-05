// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Mount check for the first-run device storage prompt (there is no Electron
 * here, so this is the visual floor): it renders into the portal, says the
 * settings are for this device only, offers all six choices, and both
 * actions reach onSave with the right payload — with a visible error when
 * saving fails.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

vi.mock('../utils/secureLocalStore', () => {
    const s = { getItem: () => null, setItem: () => {}, isAccountReady: () => true, whenAccountReady: async () => {} };
    return { default: s, secureLocalStore: s };
});

const { DeviceStorageSetupModal } = await import('./DeviceStorageSetupModal');
const { RECOMMENDED_RETENTION } = await import('../utils/deviceStorageSetup');

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
});

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const buttonByText = (t: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

function mount(onSave: (...a: unknown[]) => unknown, open = true) {
    act(() => root.render(React.createElement(DeviceStorageSetupModal, { open, onSave: onSave as never })));
}

describe('DeviceStorageSetupModal', () => {
    it('mounts as a labelled dialog with the device-only copy and six retention selects', () => {
        mount(() => {});
        const d = dialog();
        expect(d).not.toBeNull();
        expect(d!.getAttribute('aria-label')).toBe('Set up storage on this device');
        expect(d!.textContent).toMatch(/Set up storage on this device/);
        expect(d!.textContent).toMatch(/apply to this device only/i);
        expect(d!.textContent).toMatch(/don’t sync/);
        const selects = d!.querySelectorAll('[aria-haspopup="listbox"]');
        expect(selects.length).toBe(6);
        expect([...selects].map(s => s.getAttribute('aria-label'))).toContain('Direct messages: keep messages for');
        expect(buttonByText('Save')).toBeDefined();
        expect(buttonByText('Use recommended')).toBeDefined();
    });

    it('renders nothing when closed', () => {
        mount(() => {}, false);
        expect(dialog()).toBeNull();
    });

    it('"Use recommended" saves the recommended set', async () => {
        const onSave = vi.fn();
        mount(onSave);
        await act(async () => { buttonByText('Use recommended')!.click(); });
        expect(onSave).toHaveBeenCalledWith({ ...RECOMMENDED_RETENTION }, 'recommended');
    });

    it('"Save" submits the form with the (default) choices as "chosen"', async () => {
        const onSave = vi.fn();
        mount(onSave);
        await act(async () => { buttonByText('Save')!.click(); });
        expect(onSave).toHaveBeenCalledWith({ ...RECOMMENDED_RETENTION }, 'chosen');
    });

    it('shows an alert and stays open when saving fails', async () => {
        mount(() => { throw new Error('Couldn’t save to this device’s secure storage.'); });
        await act(async () => { buttonByText('Save')!.click(); });
        const alert = document.querySelector('[role="alert"]');
        expect(alert?.textContent).toMatch(/secure storage/);
        expect(dialog()).not.toBeNull();
    });
});
