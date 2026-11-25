import { describe, it, expect, vi } from 'vitest';
import { nearApiBase, startAfterCancel, bridgeMessage, nearTransferKeyBytes } from './nearBridge';

describe('near bridge helpers', () => {
    it('the host is handed the origin, not the /v1 base', () => {
        expect(nearApiBase('https://api.cipherline.chat/v1')).toBe('https://api.cipherline.chat');
        expect(nearApiBase('http://127.0.0.1:3005/v1/')).toBe('http://127.0.0.1:3005');
        expect(nearApiBase('http://x')).toBe('http://x');
    });
    it('a start after a cancel retries while the host says "already running", then succeeds', async () => {
        let n = 0;
        const start = vi.fn(async () => { if (n++ < 3) throw new Error('a near session is already running'); return 'ok'; });
        const cancel = vi.fn(async () => undefined);
        expect(await startAfterCancel({ nearCancel: cancel }, start, async () => undefined)).toBe('ok');
        expect(cancel).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(4);
    });
    it('any other error is returned at once; a stuck host gives up after ~1 s of retries', async () => {
        const boom = vi.fn(async () => { throw new Error('network'); });
        await expect(startAfterCancel({}, boom, async () => undefined)).rejects.toThrow('network');
        expect(boom).toHaveBeenCalledTimes(1);
        const stuck = vi.fn(async () => { throw new Error('a near session is already running'); });
        await expect(startAfterCancel({}, stuck, async () => undefined)).rejects.toThrow('already running');
        expect(stuck).toHaveBeenCalledTimes(11);
    });
    it('bridge messages are short and never throw', () => {
        expect(bridgeMessage(new Error('x'), 'f')).toBe('x'); expect(bridgeMessage(null, 'f')).toBe('f'); expect(bridgeMessage('y'.repeat(300), 'f')).toBe('f');
    });
});

describe('K_xfer reaches the page as bytes (security finding I2)', () => {
    it('takes the 32-byte array main hands over, as is (the port zeroes it after use)', async () => {
        const k = new Uint8Array(32).fill(7);
        expect(await nearTransferKeyBytes({ nearTransferKey: async () => k })).toBe(k);
    });
    it('refuses (and zeroes) a wrong-sized array; still reads an older main\'s base64; null on no member / rejection', async () => {
        const short = new Uint8Array(16).fill(9);
        expect(await nearTransferKeyBytes({ nearTransferKey: async () => short })).toBeNull();
        expect(short.every(b => b === 0)).toBe(true);
        const b64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
        expect(Array.from((await nearTransferKeyBytes({ nearTransferKey: async () => b64 }))!)).toEqual(new Array(32).fill(5));
        expect(await nearTransferKeyBytes({})).toBeNull();
        expect(await nearTransferKeyBytes({ nearTransferKey: async () => { throw new Error('not approved'); } })).toBeNull();
    });
});
