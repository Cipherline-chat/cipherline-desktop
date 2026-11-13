// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A peer's avatar_url is chosen by THEM and rendered with no click. A legacy
// https value used to be fetched from any host through net:fetch-binary, which
// still requests from the viewer's machine: a zero-click IP / presence beacon.
// Only the Cipherline media host may be fetched.

vi.mock('axios', () => ({ default: { get: vi.fn(async () => { throw new Error('no network in this test'); }) } }));
vi.mock('../utils/avatarKeyStore', () => ({ loadAvatarKey: async () => null, saveAvatarKey: async () => true, deleteAvatarKey: async () => {} }));
vi.mock('../utils/attachmentCache', () => ({ getAvatarBlob: async () => null, putAvatarBlob: async () => {}, deleteAvatarBlob: async () => {} }));
vi.mock('../utils/crypto', () => ({ importKeyFromBase64: async () => ({}), decryptBlob: async () => new Blob() }));
vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

const { useEncryptedAvatar } = await import('./useEncryptedAvatar');

const fetchBinary = vi.fn(async () => ({ b64: 'AAAA', mimeType: 'image/png' }));
let root: Root | null = null;
let seen: string | null = 'unset';

function Probe({ id }: { id: string }) {
    seen = useEncryptedAvatar(id, 'token');
    return null;
}

async function mount(id: string): Promise<void> {
    const el = document.createElement('div');
    root = createRoot(el);
    await act(async () => { root!.render(React.createElement(Probe, { id })); });
    await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchBinary.mockClear();
    seen = 'unset';
    (window as unknown as { electronAPI: unknown }).electronAPI = { fetchBinary };
});
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('useEncryptedAvatar — legacy https avatar_url from another user', () => {
    it('never fetches a third-party host (no request leaves the machine)', async () => {
        await mount('https://attacker.example/p.png?victim=1');
        expect(fetchBinary).not.toHaveBeenCalled();
        expect(seen).toBeNull();
    });

    it('never fetches a KLIPY host either (KLIPY is opt-in; a peer cannot opt you in)', async () => {
        await mount('https://static.klipy.com/x.gif');
        expect(fetchBinary).not.toHaveBeenCalled();
    });

    it('still loads a legacy avatar on the Cipherline media host', async () => {
        await mount('https://media.cipherline.chat/avatars/legacy.png');
        expect(fetchBinary).toHaveBeenCalledTimes(1);
        expect(fetchBinary).toHaveBeenCalledWith('https://media.cipherline.chat/avatars/legacy.png');
        expect(seen).toBe('data:image/png;base64,AAAA');
    });
});
