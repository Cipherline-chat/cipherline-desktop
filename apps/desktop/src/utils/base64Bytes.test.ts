import { describe, it, expect } from 'vitest';
import { base64ToBytes } from './base64Bytes';

const sample = () => {
    const raw = new Uint8Array(256 * 3 + 1);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff;
    let bin = '';
    for (const b of raw) bin += String.fromCharCode(b);
    return { raw, b64: btoa(bin) };
};

describe('base64ToBytes', () => {
    it('decodes every byte value exactly (native path when available)', () => {
        const { raw, b64 } = sample();
        expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(raw));
    });

    it('fallback loop decodes identically when Uint8Array.fromBase64 is missing', () => {
        const { raw, b64 } = sample();
        const U = Uint8Array as unknown as { fromBase64?: unknown };
        const saved = U.fromBase64;
        try {
            delete U.fromBase64;
            expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(raw));
        } finally {
            if (saved) U.fromBase64 = saved;
        }
    });

    it('empty input → empty array', () => {
        expect(base64ToBytes('').length).toBe(0);
    });

    it('uses the native decoder when the runtime has one (Electron 43 does)', () => {
        const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
        const saved = U.fromBase64;
        const calls: string[] = [];
        U.fromBase64 = (s: string) => { calls.push(s); return new Uint8Array([1, 2, 3]); };
        try {
            expect(Array.from(base64ToBytes('AQID'))).toEqual([1, 2, 3]);
            expect(calls).toEqual(['AQID']);
        } finally {
            if (saved) U.fromBase64 = saved; else delete U.fromBase64;
        }
    });
});
