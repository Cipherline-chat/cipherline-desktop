// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ClButton's physics module reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    });
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', userId: 'u1', deviceId: 'dev1' }) }));
vi.mock('axios', () => ({ default: { post: vi.fn(), delete: vi.fn(), get: vi.fn(async () => ({ data: [] })) } }));
vi.mock('../../hooks/useOwnDevicePresence', () => ({ useOwnDevicePresence: () => ({ devices: [] }) }));
const storeMem = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const store = { getItem: (k: string) => storeMem.get(k) ?? null, setItem: (k: string, v: string) => { storeMem.set(k, v); }, removeItem: (k: string) => { storeMem.delete(k); }, flushNow: async () => undefined };
    return { default: store, secureLocalStore: store };
});

import { TransferBanner } from './TransferBanner';
import { MoveHistoryCard } from './MoveHistoryCard';
import { NearTransferHost, RELOAD_AFTER_IMPORT_MS, StopTransferDialog, transferControls } from './NearTransferHost';
import { OwnTransferHost, SLOW_ANSWER_MS, notifyHolderSheet } from './OwnTransferHost';
import { SignInHistoryPrompt } from './SignInHistoryPrompt';
import { askedDeviceName, closeOwnTransferPicker, ownTransferPickerOpen, rememberAskedDevice, resetOwnTransferPickerForTest } from '../../utils/ownTransferPicker';
import { getTransferRunner } from '../../utils/nearTransferRunner';
import { transferBannerView } from '../../utils/nearTransferView';
import { createNearStore, setNearStoreForTest } from '../../utils/nearStore';
import type { NearCapabilities, NearSnapshot, NearState } from '../../types/near';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.unstubAllEnvs();
    setNearStoreForTest(null); delete (window as { electronAPI?: unknown }).electronAPI;
    resetOwnTransferPickerForTest(); storeMem.clear(); getTransferRunner().reset();
});
const render = (el: React.ReactElement) => { act(() => root.render(el)); };
const text = () => document.body.textContent ?? '';


const caps = (available: boolean): NearCapabilities => ({ available, bluetooth: 'unsupported', lan: true, biometric: 'unavailable', gate: 'password' });
const flushLong = async () => { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };
const withBridge = (probe: () => Promise<NearCapabilities>, extra: object = {}) => {
    const api = { nearProbe: vi.fn(probe), nearTransferRequest: vi.fn(async () => ({ seq: 0 })), nearCancel: vi.fn(async () => undefined), ...extra };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    setNearStoreForTest(createNearStore(api as never));
    return api;
};

describe('the transfer screens: always on, only the helper decides (VITE_NEAR_TRANSFER retired)', () => {
    it('helper not available (no binary in this build): nothing renders, though the bridge was asked', async () => {
        const api = withBridge(async () => caps(false));
        render(React.createElement(React.Fragment, null, React.createElement(NearTransferHost, {}), React.createElement(MoveHistoryCard)));
        await flushLong();
        expect(api.nearProbe).toHaveBeenCalled();
        expect(host.innerHTML).toBe('');
    });
    it('no build flag set and the helper available: the Move your history card appears with the own-device transfer row', async () => {
        withBridge(async () => caps(true));
        render(React.createElement(MoveHistoryCard));
        await flushLong();
        expect(host.textContent).toContain('Move your history');
        expect(host.textContent).toContain('Transfer from another device');
        expect(host.textContent).toContain('Restore from a backup file');
    });
    it('the card\'s Transfer opens the ONE picker the host renders; Continue asks the chosen device and names it on the wait screen', async () => {
        const presence = await import('../../hooks/useOwnDevicePresence');
        vi.spyOn(presence, 'useOwnDevicePresence').mockReturnValue({ devices: [{ device_id: 'dev2', device_name: 'Desk PC', platform: 'windows', connected: true, attentive: true, last_active_at: null, last_seen_at: '2026-11-24T00:00:00Z' }] } as never);
        const api = withBridge(async () => caps(true));
        render(React.createElement(React.Fragment, null, React.createElement(NearTransferHost, {}), React.createElement(MoveHistoryCard)));
        await flushLong();
        act(() => (Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Transfer') as HTMLButtonElement).click());
        expect(document.querySelector('[data-testid="pick-device"]')).not.toBeNull();
        expect(text()).toContain('Desk PC');
        await act(async () => { (Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continue') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)); });
        expect(api.nearTransferRequest).toHaveBeenCalledWith({ deviceId: 'dev2', ownDeviceId: 'dev1' });
        expect(ownTransferPickerOpen()).toBe(false);
        expect(askedDeviceName()).toBe('Desk PC');
        vi.restoreAllMocks();
    });
});

describe('the sign-in history step (SignInHistoryPrompt): the transfer is the only method', () => {
    const P = (over: Record<string, unknown> = {}) => React.createElement(SignInHistoryPrompt, {
        userId: 'u1', token: 'tok', deviceId: 'dev1', onOpenStorage: vi.fn(),
        hasHistory: async () => false, listOtherDevices: async () => 1, probe: async () => caps(true), ...over,
    });
    const btn = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement | undefined;
    it('a new device with no history asks to bring it over, says both must be on the same Wi-Fi, and Transfer opens the picker', async () => {
        (window as unknown as { electronAPI: unknown }).electronAPI = { nearTransferRequest: vi.fn() };
        render(P());
        await flushLong();
        expect(document.querySelector('[data-testid="signin-history"]')).not.toBeNull();
        expect(text()).toContain('Bring your history to this computer');
        expect(text()).toContain('same Wi‑Fi');
        expect(text()).toContain('never pass through our servers');
        expect(text()).toContain('Your other device can send it'); // listOtherDevices = 1
        act(() => (document.querySelector('[data-testid="signin-history-transfer"]') as HTMLButtonElement).click());
        expect(ownTransferPickerOpen()).toBe(true);
        expect(document.querySelector('[data-testid="signin-history"]')).toBeNull();
        // closing the picker without asking a device puts the step back
        act(() => closeOwnTransferPicker(false));
        expect(document.querySelector('[data-testid="signin-history"]')).not.toBeNull();
        // asking a device hands over to the wait screen: the step stays closed
        act(() => (document.querySelector('[data-testid="signin-history-transfer"]') as HTMLButtonElement).click());
        act(() => closeOwnTransferPicker(true));
        expect(document.querySelector('[data-testid="signin-history"]')).toBeNull();
    });
    it('a build that cannot run the transfer says so plainly and offers a backup restore, never a dead Transfer button', async () => {
        const onOpenStorage = vi.fn();
        render(P({ probe: async () => null, onOpenStorage }));
        await flushLong();
        expect(document.querySelector('[data-testid="signin-history-unavailable"]')).not.toBeNull();
        expect(text()).toContain('Can’t move history on this computer');
        expect(document.querySelector('[data-testid="signin-history-transfer"]')).toBeNull();
        act(() => (document.querySelector('[data-testid="signin-history-restore"]') as HTMLButtonElement).click());
        expect(onOpenStorage).toHaveBeenCalled();
    });
    it('never opens when the device has history, the store is unreadable, there is no other device, or Start fresh was chosen', async () => {
        for (const over of [{ hasHistory: async () => true }, { hasHistory: async () => { throw new Error('locked'); } }, { listOtherDevices: async () => 0 }, { listOtherDevices: async () => { throw new Error('net'); } }]) {
            render(P(over));
            await flushLong();
            expect(host.innerHTML).toBe('');
        }
    });
    it('Start fresh is remembered (the same key the old prompt used)', async () => {
        (window as unknown as { electronAPI: unknown }).electronAPI = { nearTransferRequest: vi.fn() };
        render(P());
        await flushLong();
        act(() => btn('Start fresh')!.click());
        expect(storeMem.get('cipherline_sync_dismissed_u1')).toBe('1');
        expect(host.innerHTML).toBe('');
    });
});

describe('TransferBanner', () => {
    const t = { direction: 'receive' as const, bytesDone: 38, bytesTotal: 100, recordsDone: 1, recordsTotal: 3, attempt: 1, paused: false, interrupted: false };
    const snap = (state: NearState, over: Partial<NearSnapshot> = {}): NearSnapshot => ({ seq: 1, role: 'new_device', state, transfer: t, ...over });
    it('shows the title, a labelled progress bar and Details / Cancel (no Pause: the engine cannot)', () => {
        const view = transferBannerView(snap('transferring'), { device: 'iPhone 16', direction: 'receive', eta: null, controls: { pause: false, cancel: true, details: true } })!;
        const onCancel = vi.fn();
        render(React.createElement(TransferBanner, { view, direction: 'receive', onCancel, onDetails: vi.fn() }));
        expect(text()).toContain('Bringing your history over from iPhone 16');
        const bar = document.querySelector('[role="progressbar"]')!;
        expect(bar.getAttribute('aria-valuenow')).toBe('38'); expect(bar.getAttribute('aria-label')).toBe('History transfer, 38 percent');
        const labels = Array.from(document.querySelectorAll('[data-action] button')).map(b => b.textContent);
        expect(labels).toEqual(['Details', 'Cancel']);
        act(() => { (document.querySelector('[data-action="cancel"] button') as HTMLButtonElement).click(); });
        expect(onCancel).toHaveBeenCalled();
    });
    it('success auto-hides after 8 s', () => {
        vi.useFakeTimers();
        try {
            const view = transferBannerView(snap('done', { transfer: undefined }), { device: 'iPhone 16', direction: 'receive', eta: null, controls: { pause: false, cancel: true, details: true }, counts: { messages: 2, attachments: 1 } })!;
            const onDismiss = vi.fn();
            render(React.createElement(TransferBanner, { view, direction: 'receive', onDismiss }));
            act(() => { vi.advanceTimersByTime(7900); }); expect(onDismiss).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(200); }); expect(onDismiss).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
});

describe('after a received history is imported the app reloads to apply its settings (like Restore)', () => {
    const imported = () => act(() => { (getTransferRunner() as unknown as { set(p: object): void }).set({ direction: 'receive', counts: { messages: 3, attachments: 1 }, running: false, applying: false, finishedAt: 42 }); });
    it('reloads once, after the success banner had time to be read', async () => {
        withBridge(async () => caps(true));
        const reload = vi.fn();
        render(React.createElement(NearTransferHost, { reload, portFor: () => null }));
        await flushLong();
        vi.useFakeTimers();
        try {
            imported();
            act(() => { vi.advanceTimersByTime(RELOAD_AFTER_IMPORT_MS - 100); }); expect(reload).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(200); }); expect(reload).toHaveBeenCalledTimes(1);
            act(() => { vi.advanceTimersByTime(RELOAD_AFTER_IMPORT_MS * 2); }); expect(reload).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
    it('never under a live call: it waits for the call to end', async () => {
        withBridge(async () => caps(true));
        const reload = vi.fn();
        render(React.createElement(NearTransferHost, { reload, inCall: true, portFor: () => null }));
        await flushLong();
        vi.useFakeTimers();
        try {
            imported();
            act(() => { vi.advanceTimersByTime(RELOAD_AFTER_IMPORT_MS * 3); }); expect(reload).not.toHaveBeenCalled();
            render(React.createElement(NearTransferHost, { reload, inCall: false, portFor: () => null }));
            act(() => { vi.advanceTimersByTime(RELOAD_AFTER_IMPORT_MS + 50); }); expect(reload).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
    it('a send, or a receive that failed, never reloads', async () => {
        withBridge(async () => caps(true));
        const reload = vi.fn();
        render(React.createElement(NearTransferHost, { reload, portFor: () => null }));
        await flushLong();
        vi.useFakeTimers();
        try {
            act(() => { (getTransferRunner() as unknown as { set(p: object): void }).set({ direction: 'send', running: false, finishedAt: 1 }); });
            act(() => { (getTransferRunner() as unknown as { set(p: object): void }).set({ direction: 'receive', counts: { messages: 1, attachments: 0 }, error: { code: 'failed', message: '' }, finishedAt: 2 }); });
            act(() => { vi.advanceTimersByTime(RELOAD_AFTER_IMPORT_MS * 2); }); expect(reload).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });
});

describe('stopping a transfer (spec E-stop, contract 11.10)', () => {
    const buttons = () => Array.from(document.querySelectorAll('[data-testid="stop-transfer"] button')).map(b => b.textContent);
    it('a receiver with parts in is offered Keep going, Keep what arrived and Discard it, and the keep button calls onKeep', () => {
        const onKeep = vi.fn(); const onStop = vi.fn();
        render(React.createElement(StopTransferDialog, { open: true, onClose: () => {}, onStop, onKeep, arrived: '38 MB' }));
        expect(buttons()).toEqual(['Keep going', 'Keep what arrived', 'Discard it']);
        expect(text()).toContain('38 MB has arrived');
        act(() => { (Array.from(document.querySelectorAll('[data-testid="stop-transfer"] button')).find(b => b.textContent === 'Keep what arrived') as HTMLButtonElement).click(); });
        expect(onKeep).toHaveBeenCalledTimes(1); expect(onStop).not.toHaveBeenCalled();
    });
    it('without a keep path (the sender, or nothing arrived yet) the choice is keep going or discard', () => {
        render(React.createElement(StopTransferDialog, { open: true, onClose: () => {}, onStop: () => {} }));
        expect(buttons()).toEqual(['Keep going', 'Discard it']);
    });
    it('Pause / Resume are offered only when the bridge has both members', () => {
        expect(transferControls(null).pause).toBe(false);
        expect(transferControls({ nearTransferPause: () => {} }).pause).toBe(false);
        expect(transferControls({ nearTransferPause: () => {}, nearTransferResume: () => {} }).pause).toBe(true);
    });
});

describe('own-device transfer screens (contract section 7)', () => {
    function boot(initial: NearSnapshot | null, apiOver: Record<string, unknown> = {}) {
        let emit: (s: NearSnapshot) => void = () => undefined;
        const api = {
            nearTransferRequest: vi.fn(), nearCancel: vi.fn(async () => undefined), nearRefuse: vi.fn(async () => undefined), nearApprove: vi.fn(async () => ({ result: 'approved', gate: 'hello' })),
            nearGetState: async () => initial as NearSnapshot, onNearState: (cb: (s: NearSnapshot) => void) => { emit = cb; return () => undefined; },
            ...apiOver,
        };
        (window as unknown as { electronAPI: unknown }).electronAPI = api;
        setNearStoreForTest(createNearStore(api));
        const port = { estimate: async () => null, writeContainer: vi.fn(async () => undefined), importContainer: async () => ({ messages: 0, attachments: 0 }) };
        render(React.createElement(OwnTransferHost, { port }));
        return { api, port, emit: (s: NearSnapshot) => act(() => emit(s)) };
    }
    const O = (role: 'own_receiver' | 'own_sender', state: NearState, seq: number, over: Partial<NearSnapshot> = {}): NearSnapshot => ({ seq, role, state, peer: { label: 'Desk PC', platform: 'windows', labelSealed: false }, ...over });
    const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
    const btn = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement;

    it('the asking device waits ("Confirm on Desk PC") and can cancel', async () => {
        const { api, emit } = boot(null); await flush();
        expect(document.querySelector('[data-testid="own-wait"]')).toBeNull();
        emit(O('own_receiver', 'awaiting_approval', 1));
        expect(text()).toContain('Confirm on Desk PC'); expect(text()).toContain('same Wi‑Fi');
        act(() => btn('Cancel').click()); expect(api.nearCancel).toHaveBeenCalled();
    });
    it('the holder\'s sheet: Not now refuses; Send history approves and hands the container to the runner', async () => {
        const { api, emit } = boot(null); await flush();
        emit(O('own_sender', 'awaiting_approval', 1));
        expect(text()).toContain('Send your history to Desk PC?'); expect(text()).toContain('asked for your history');
        act(() => btn('Not now').click()); expect(api.nearRefuse).toHaveBeenCalledTimes(1); expect(api.nearApprove).not.toHaveBeenCalled();
        await act(async () => { btn('Send history').click(); await new Promise(r => setTimeout(r, 0)); });
        expect(api.nearApprove).toHaveBeenCalledTimes(1);
    });
    it('B9: the holder sheet names the phone, shows its detail on its own line, and never says "this computer"', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_sender', 'awaiting_approval', 1, { peer: { label: 'Dawson iPhone · iPhone · added Nov 24, 2026', platform: undefined as unknown as string, labelSealed: false } }));
        expect(text()).toContain('Send your history to Dawson iPhone?');
        expect(text()).toContain('Dawson iPhone asked for your history');
        expect(document.querySelector('.nr-who .n')?.textContent).toBe('Dawson iPhone');
        expect(document.querySelector('.nr-who .d')?.textContent).toBe('iPhone · added Nov 24, 2026');
        expect(document.querySelector('.nr-who svg')).not.toBeNull();
        expect(text()).not.toContain('this computer');
    });
    it('a failed Windows Hello step keeps the sheet and says nothing was approved', async () => {
        const { emit } = boot(null, { nearApprove: vi.fn(async () => ({ result: 'failed', gate: 'hello' })) }); await flush();
        emit(O('own_sender', 'awaiting_approval', 1));
        await act(async () => { btn('Send history').click(); await new Promise(r => setTimeout(r, 0)); });
        expect(text()).toContain('nothing was approved'); expect(text()).toContain('Send your history to Desk PC?');
    });
    it('no Wi-Fi path and a decline each get their own calm line; other roles render nothing', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'refused', 2, { error: { code: 'no_proximity', message: '' } }));
        expect(text()).toContain('Desk PC isn’t on the same Wi‑Fi');
        act(() => btn('Close').click());
        expect(document.querySelector('[data-testid="own-nonet"]')).toBeNull();
        emit(O('own_receiver', 'refused', 3, { error: { code: 'denied', message: '' } }));
        expect(text()).toContain('Desk PC said not now. Nothing was sent.');
        emit({ seq: 4, role: 'approver', state: 'awaiting_approval' });
        expect(document.querySelector('[data-testid="own-send-sheet"]')).toBeNull();
        expect(document.querySelector('[data-testid="own-wait"]')).toBeNull();
    });
    it('"the PC said no" fix: a decline its engine sent because it was busy is not shown as the person\'s "not now"', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'refused', 2, { error: { code: 'busy', message: '' } }));
        expect(document.querySelector('[data-testid="own-busy"]')).not.toBeNull();
        expect(text()).toContain('Desk PC is busy right now');
        expect(text()).not.toContain('said not now');
        expect(btn('Try again')).toBeDefined();
    });
    it('the holder\'s sheet nudges the person through the OS when the window is not in front, once per offer', async () => {
        const notifShow = vi.fn(async () => undefined); const notifFlashTaskbar = vi.fn(async () => undefined);
        const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const { emit } = boot(null, { notifShow, notifFlashTaskbar }); await flush();
        emit(O('own_sender', 'awaiting_approval', 1, { linkId: 'own:a' }));
        expect(notifShow).toHaveBeenCalledTimes(1);
        expect(notifShow.mock.calls[0]).toEqual([{ id: 'near-own-offer', title: 'Desk PC is asking for your history', body: 'Open Cipherline on this computer to send it or say not now.', conv_id: '' }]);
        expect(notifFlashTaskbar).toHaveBeenCalledTimes(1);
        emit(O('own_sender', 'approving', 2, { linkId: 'own:a' }));
        expect(notifShow).toHaveBeenCalledTimes(1);
        // a new offer (a re-ask replaced the sheet) nudges again; a focused window is never nudged
        emit(O('own_sender', 'awaiting_approval', 3, { linkId: 'own:b' }));
        expect(notifShow).toHaveBeenCalledTimes(2);
        hasFocus.mockReturnValue(true);
        emit(O('own_sender', 'awaiting_approval', 4, { linkId: 'own:c' }));
        expect(notifShow).toHaveBeenCalledTimes(2);
        hasFocus.mockRestore();
    });
    it('notifyHolderSheet is a no-op when focused or without the bridge, and never throws', () => {
        const api = { notifShow: vi.fn(async () => { throw new Error('x'); }), notifFlashTaskbar: vi.fn(async () => undefined) };
        expect(notifyHolderSheet('Pixel', api, true)).toBe(false);
        expect(api.notifShow).not.toHaveBeenCalled();
        expect(notifyHolderSheet('Pixel', undefined, false)).toBe(false);
        expect(notifyHolderSheet('Pixel', api, false)).toBe(true);
        expect(api.notifShow).toHaveBeenCalledTimes(1);
    });
    it('the asker\'s endings offer Try again, which reopens the picker; the holder\'s endings only Close', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'refused', 2, { error: { code: 'denied', message: '' } }));
        act(() => btn('Try again').click());
        expect(ownTransferPickerOpen()).toBe(true);
        expect(document.querySelector('[data-testid="own-declined"]')).toBeNull();
        act(() => closeOwnTransferPicker(false));
        emit(O('own_sender', 'refused', 3, { error: { code: 'no_proximity', message: '' } }));
        expect(document.querySelector('[data-testid="own-nonet"]')).not.toBeNull();
        expect(btn('Try again')).toBeUndefined();
    });
    it('no answer (an old version, closed, or another network): says so, names the device that was asked, and says to update it', async () => {
        rememberAskedDevice('Work laptop');
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'expired', 2, { peer: { label: 'Your other device', platform: undefined as unknown as string, labelSealed: false }, error: { code: 'own_no_answer', message: '' } }));
        expect(document.querySelector('[data-testid="own-noanswer"]')).not.toBeNull();
        expect(text()).toContain('Work laptop didn’t answer');
        expect(text()).toContain('update Cipherline there');
        expect(btn('Try again')).toBeDefined();
    });
    it('a session that failed before any byte moved gets its own line; one that failed mid-transfer is left to the banner', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'failed', 2, { error: { code: 'bad_answer', message: '' } }));
        expect(document.querySelector('[data-testid="own-failed"]')).not.toBeNull();
        act(() => btn('Close').click());
        emit(O('own_receiver', 'failed', 3, { error: { code: 'x', message: '' }, transfer: { direction: 'receive', bytesDone: 5, bytesTotal: 10, recordsDone: 0, recordsTotal: 1, attempt: 1, paused: false, interrupted: false } }));
        expect(document.querySelector('[data-testid="own-failed"]')).toBeNull();
    });
    it('not enough disk space and the other device stopping each get their own ending', async () => {
        const { emit } = boot(null); await flush();
        emit(O('own_receiver', 'failed', 2, { error: { code: 'near_error', message: 'storage: not enough free space for the transfer' }, transfer: { direction: 'receive', bytesDone: 0, bytesTotal: 10, recordsDone: 0, recordsTotal: 1, attempt: 1, paused: false, interrupted: false } }));
        expect(document.querySelector('[data-testid="own-space"]')).not.toBeNull();
        expect(text()).toContain('Not enough space on this computer');
        act(() => btn('Close').click());
        emit(O('own_receiver', 'cancelled', 3, { error: { code: 'peer_cancelled', message: '' } }));
        expect(text()).toContain('Desk PC stopped the transfer');
        act(() => btn('Close').click());
        emit(O('own_receiver', 'cancelled', 4)); // this device's own Cancel: no dialog (the banner says it stopped)
        expect(document.querySelector('[role="status"]')).toBeNull();
    });
    it('the holder\'s sheet says what would be sent (counts and size, counted locally) before anything is sent', async () => {
        const { emit } = boot(null);
        await flush();
        emit(O('own_sender', 'awaiting_approval', 1));
        await flush();
        expect(text()).toContain('What it gets');
        expect(text()).toContain('Your messages, attachments and settings'); // the test port has nothing to size
        expect(text()).toContain('never through our servers');
    });
    it('the wait screen explains the usual causes (including an outdated version) once the other device is slow to answer', async () => {
        vi.useFakeTimers();
        try {
            const { emit } = boot(null);
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            emit(O('own_receiver', 'awaiting_approval', 1));
            expect(document.querySelector('[data-testid="own-wait-slow"]')).toBeNull();
            await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_ANSWER_MS + 10); });
            expect(document.querySelector('[data-testid="own-wait-slow"]')).not.toBeNull();
            expect(text()).toContain('An older version of Cipherline can’t send history this way');
        } finally { vi.useRealTimers(); }
    });
});
