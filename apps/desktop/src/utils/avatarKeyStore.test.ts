/**
 * Audit run 2, lead 11 — renderer side: a peer-chosen avatar key record is shape-checked
 * before the IPC, and a main-process refusal does not divert to the fallback store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveAvatarKey } from './avatarKeyStore';
import { isValidAvatarKeyRecord } from './avatarKeyValidation';

const setItem = vi.fn();
vi.mock('./secureLocalStore', () => ({ default: { setItem: (...a: unknown[]) => setItem(...a), getItem: () => null, removeItem: vi.fn() } }));

const UUID = '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b';
const KEY = 'A'.repeat(43) + '=';
const NONCE = 'B'.repeat(16);

describe('avatarKeyValidation', () => {
    it('accepts what the app writes', () => expect(isValidAvatarKeyRecord(UUID, KEY, NONCE)).toBe(true));
    it('rejects sender-chosen junk', () => {
        expect(isValidAvatarKeyRecord('x'.repeat(256), KEY, NONCE)).toBe(false);
        expect(isValidAvatarKeyRecord(UUID, 'A'.repeat(512), NONCE)).toBe(false);
        expect(isValidAvatarKeyRecord(UUID, KEY, 'B'.repeat(512))).toBe(false);
        expect(isValidAvatarKeyRecord(UUID, undefined, NONCE)).toBe(false);
        expect(isValidAvatarKeyRecord(UUID, '', '')).toBe(false);
    });
});

describe('saveAvatarKey', () => {
    const setAvatarKey = vi.fn();
    beforeEach(() => {
        setItem.mockReset(); setAvatarKey.mockReset();
        (globalThis as unknown as { window: unknown }).window = { electronAPI: { setAvatarKey } };
    });
    afterEach(() => { delete (globalThis as { window?: unknown }).window; });

    it('a valid record goes over the IPC and resolves true', async () => {
        setAvatarKey.mockResolvedValue(true);
        expect(await saveAvatarKey(UUID, KEY, NONCE)).toBe(true);
        expect(setAvatarKey).toHaveBeenCalledWith(UUID, KEY, NONCE);
    });
    it('a malformed record never reaches the IPC or the fallback store', async () => {
        expect(await saveAvatarKey('x'.repeat(256), 'k'.repeat(512), 'n'.repeat(512))).toBe(false);
        expect(await saveAvatarKey(UUID, undefined as unknown as string, undefined as unknown as string)).toBe(false);
        expect(setAvatarKey).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });
    it('main refusing (entry cap) resolves false and does NOT divert to the fallback store', async () => {
        setAvatarKey.mockResolvedValue(false);
        expect(await saveAvatarKey(UUID, KEY, NONCE)).toBe(false);
        expect(setItem).not.toHaveBeenCalled();
    });
    it('negative control: an IPC that throws still falls back (unchanged behaviour)', async () => {
        setAvatarKey.mockRejectedValue(new Error('ipc down'));
        expect(await saveAvatarKey(UUID, KEY, NONCE)).toBe(true);
        expect(setItem).toHaveBeenCalledTimes(1);
    });
});
