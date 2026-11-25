import { describe, it, expect } from 'vitest';
import { createVaultHistoryPort, estimateFromPlan, HistoryPortPending, recordIsHeld } from './nearHistoryPort';

const enc = new TextEncoder();
const rec = (id: string, v: unknown) => ({ id, kind: 'json' as const, load: async () => enc.encode(JSON.stringify(v)) });

describe('history port', () => {
    it('sizes a plan without writing it: JSON records counted, attachments by their hints', async () => {
        const e = await estimateFromPlan({
            records: [rec('meta', { a: 1 }), rec('dm:c1:2026-11', [1, 2, 3]), rec('ch:x:2026-11', [1, 2]), { id: 'att:a1', kind: 'blob', load: async () => { throw new Error('must not load attachments'); } }],
            attachmentIds: ['a1', 'a2'], attachmentSizeHints: { a1: 1000, a2: 500 },
        });
        expect(e.messages).toBe(5); expect(e.attachments).toBe(2); expect(e.attachmentBytes).toBe(1500);
        expect(e.totalBytes).toBeGreaterThan(1500);
    });
    it('writing or importing without an agreed transfer key is refused loudly, never sent unreadable', async () => {
        const p = createVaultHistoryPort({ userId: 'u', transferKey: null });
        await expect(p.writeContainer({ write: async () => undefined, writeAt: async () => undefined }, { includeAttachments: true })).rejects.toBeInstanceOf(HistoryPortPending);
        await expect(p.importContainer({ size: async () => 0, read: async () => new Uint8Array() }, 0)).rejects.toMatchObject({ code: 'pending_key' });
    });
    it('a key that is not 32 bytes is refused, and a key the port was given is zeroed after use', async () => {
        const short = new Uint8Array(16).fill(7);
        const p = createVaultHistoryPort({ userId: 'u', transferKey: async () => short });
        await expect(p.importContainer({ size: async () => 0, read: async () => new Uint8Array() }, 0)).rejects.toBeInstanceOf(HistoryPortPending);
        const key = new Uint8Array(32).fill(9);
        const p2 = createVaultHistoryPort({ userId: 'u', transferKey: async () => key });
        await expect(p2.importContainer({ size: async () => 0, read: async () => new Uint8Array() }, 0)).rejects.toThrow(); // not a container
        expect(Array.from(key).every(b => b === 0), 'the key bytes are wiped even when the import fails').toBe(true);
    });
    it('a record is "held" only if its whole frame lies inside one verified range', () => {
        const ranges = [[0, 100], [200, 50]] as const;
        expect(recordIsHeld({ offset: 10, len: 90 }, ranges)).toBe(true);
        expect(recordIsHeld({ offset: 90, len: 20 }, ranges)).toBe(false); // straddles the end of a held range
        expect(recordIsHeld({ offset: 100, len: 10 }, ranges)).toBe(false); // in the hole
        expect(recordIsHeld({ offset: 200, len: 50 }, ranges)).toBe(true);
        expect(recordIsHeld({ offset: 240, len: 20 }, ranges)).toBe(false); // runs past the held end
    });
});
