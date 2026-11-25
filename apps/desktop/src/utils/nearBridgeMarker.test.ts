// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { nearBridge } from './nearBridge';

const set = (api: unknown) => { (window as unknown as { electronAPI?: unknown }).electronAPI = api; };
afterEach(() => { delete (window as { electronAPI?: unknown }).electronAPI; });

describe('nearBridge(): the transfer build marker', () => {
    it('is the bridge only when the own-device request member exists; the sign-in members are not the marker', () => {
        set(undefined);
        expect(nearBridge()).toBeNull();
        set({ nearShowStart: () => undefined });
        expect(nearBridge()).toBeNull();
        const api = { nearTransferRequest: () => undefined };
        set(api);
        expect(nearBridge()).toBe(api);
    });
});
