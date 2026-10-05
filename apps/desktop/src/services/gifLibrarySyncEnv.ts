/**
 * The real `GifSyncEnv` — binds gifLibrarySyncService to actual IPC, WebCrypto
 * and the `/v1/history` slot endpoints. Kept apart from the service so the
 * orchestration stays unit-testable against a fake.
 */

import secureLocalStore from '../utils/secureLocalStore';
import { GIF_LIBRARY_SLOT } from '../utils/gifLibraryTransport';
import type { GifLibraryState } from '../utils/gifLibrarySync';
import type { SlotView } from '../utils/ownSlotSync';
import { createOwnSlotEnv } from './ownSlotEnv';
import {
    loadLibraryState,
    saveLibraryState,
    getGifKeyB64,
    putGifKeyB64,
    deleteGifKey,
} from '../utils/gifStorage';
import type { GifSyncEnv } from './gifLibrarySyncService';

/** Remembers the slot revision this device already applied, so an idle client
 *  doesn't re-download a multi-MB blob on every check. */
export const lastSeenKey = (uid: string) => `cipherline_gif_sync_seen_${uid}`;

export function getLastSeen(uid: string): string | null {
    try { return secureLocalStore.getItem(lastSeenKey(uid)); } catch { return null; }
}
export function setLastSeen(uid: string, updatedAt: string): void {
    try { secureLocalStore.setItem(lastSeenKey(uid), updatedAt); } catch { /* non-fatal */ }
}

/** What this device last knew about the slot — its addressed devices and its
 *  metadata as published — so the anti-entropy check needs no download while
 *  the slot is unchanged. Device-specific: never restored from a backup. */
export const viewKey = (uid: string) => `cipherline_gif_sync_view_${uid}`;

export function getGifSlotView(uid: string): SlotView<GifLibraryState> | null {
    try {
        const raw = secureLocalStore.getItem(viewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setGifSlotView(uid: string, view: SlotView<GifLibraryState> | null): void {
    try {
        if (view) secureLocalStore.setItem(viewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(viewKey(uid));
    } catch { /* non-fatal */ }
}

export interface GifSyncAuth {
    userId: string;
    deviceId: string;
    token: string;
}

/**
 * The GIF slot is an own-device slot like `personal_saves`, so the transport —
 * slot I/O, content-key crypto, finding this account's devices, and verifying
 * that a snapshot was written by one of them — comes from `createOwnSlotEnv`.
 * Only the GIF-specific parts (the `.enc` files, their keys, the library
 * state) are bound here.
 */
export function createGifSyncEnv(auth: GifSyncAuth): GifSyncEnv {
    const api = () => window.electronAPI!;
    const gifDir = async () => `${await api().getUserDataPath()}/cipherline-gifs`;
    const slot = createOwnSlotEnv(auth, GIF_LIBRARY_SLOT);

    return {
        ...slot,

        async readGifBytes(gifId) {
            try {
                const buf = await api().readGifFile(gifId);
                return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            } catch { return null; }
        },
        async writeGifBytes(gifId, bytes) {
            await api().writeGifFile(gifId, bytes);
        },
        async deleteGifBytes(gifId) {
            // The key goes with the bytes: a GIF removed on another device
            // must not leave its AES key behind in this device's store.
            deleteGifKey(gifId);
            await api().deleteFile(`${await gifDir()}/${gifId}.enc`);
        },

        getGifKeyB64,
        putGifKeyB64,

        loadLocalState: loadLibraryState,
        saveLocalState: saveLibraryState,
    };
}
