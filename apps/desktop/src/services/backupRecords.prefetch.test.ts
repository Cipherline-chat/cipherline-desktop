import { describe, it, expect } from 'vitest';
import type { BackupPlan, RecordSpec } from './backupRecords';
import type { ContainerWriter } from '../utils/backupContainer';

const { writeBackupRecords } = await import('./backupRecords');

/** Read-ahead in writeBackupRecords (B6): same output order and results as the serial loop, bounded in flight. */

const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

function plan(specs: RecordSpec[], hints: Record<string, number> = {}): BackupPlan {
    return { userId: 'u', fingerprint: 'f', records: specs, attachmentIds: specs.filter(s => s.id.startsWith('att:')).map(s => s.id.slice(4)), attachmentSizeHints: hints };
}
function writer(log: string[]): ContainerWriter {
    return { addBytes: async (id: string) => { log.push(id); }, has: () => false, hashOf: () => undefined, carry: () => undefined } as unknown as ContainerWriter;
}
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function gate() {
    let open!: () => void;
    const p = new Promise<void>(r => { open = r; });
    return { p, open };
}

describe('writeBackupRecords prefetch', () => {
    it('writes in plan order even when later loads finish first, and reports the same counts', async () => {
        const delays = [30, 5, 20, 1, 10];
        const specs: RecordSpec[] = delays.map((d, i) => ({
            id: `att:a${i}`, kind: 'blob', hash: 'h',
            load: async () => { await new Promise(r => setTimeout(r, d)); return bytesOf(8, i); },
        }));
        const log: string[] = [];
        const r = await writeBackupRecords(plan(specs), { fresh: writer(log) }, { prefetch: { concurrency: 4, byteBudget: 1 << 20 } });
        expect(log).toEqual(['att:a0', 'att:a1', 'att:a2', 'att:a3', 'att:a4']);
        expect(r.attachmentsWritten).toBe(5);
        expect(r.attachmentsMissing).toBe(0);
    });

    it('never has more than `concurrency` loads in flight, and does start that many ahead', async () => {
        let inflight = 0; let peak = 0;
        const specs: RecordSpec[] = Array.from({ length: 12 }, (_, i) => ({
            id: `att:a${i}`, kind: 'blob', hash: 'h',
            load: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 5)); inflight--; return bytesOf(4, 1); },
        }));
        await writeBackupRecords(plan(specs), { fresh: writer([]) }, { prefetch: { concurrency: 3, byteBudget: 1 << 30 } });
        expect(peak).toBe(3);
    });

    it('stops reading ahead at the byte budget but always allows one load', async () => {
        const g = gate();
        let started = 0;
        const specs: RecordSpec[] = Array.from({ length: 6 }, (_, i) => ({
            id: `att:a${i}`, kind: 'blob', hash: 'h',
            load: async () => { started++; await g.p; return bytesOf(4, 1); },
        }));
        const hints = Object.fromEntries(specs.map(s => [s.id.slice(4), 100]));
        const done = writeBackupRecords(plan(specs, hints), { fresh: writer([]) }, { prefetch: { concurrency: 6, byteBudget: 250 } });
        await tick();
        expect(started).toBe(2); // 100 + 100 fits, a third would make 300 > 250
        g.open();
        await done;
        expect(started).toBe(6);

        const g2 = gate(); let started2 = 0;
        const big: RecordSpec[] = [{ id: 'att:big', kind: 'blob', hash: 'h', load: async () => { started2++; await g2.p; return bytesOf(4, 1); } }];
        const d2 = writeBackupRecords(plan(big, { big: 10_000 }), { fresh: writer([]) }, { prefetch: { concurrency: 4, byteBudget: 50 } });
        await tick();
        expect(started2).toBe(1);
        g2.open();
        await d2;
    });

    it('a null load is counted missing exactly as in the serial loop; a throwing load rejects the write', async () => {
        const specs: RecordSpec[] = [
            { id: 'att:ok', kind: 'blob', hash: 'h', load: async () => bytesOf(4, 1) },
            { id: 'att:gone', kind: 'blob', hash: 'h', load: async () => null },
        ];
        const r = await writeBackupRecords(plan(specs), { fresh: writer([]) }, { prefetch: { concurrency: 4, byteBudget: 1 << 20 } });
        expect(r).toMatchObject({ attachmentsWritten: 1, attachmentsMissing: 1 });

        const boom: RecordSpec[] = [
            { id: 'att:a', kind: 'blob', hash: 'h', load: async () => bytesOf(4, 1) },
            { id: 'att:b', kind: 'blob', hash: 'h', load: async () => { throw new Error('disk gone'); } },
            { id: 'att:c', kind: 'blob', hash: 'h', load: async () => bytesOf(4, 1) },
        ];
        await expect(writeBackupRecords(plan(boom), { fresh: writer([]) }, { prefetch: { concurrency: 4, byteBudget: 1 << 20 } })).rejects.toThrow('disk gone');
    });

    it('does not load records an in-place update carries', async () => {
        const loaded: string[] = [];
        const specs: RecordSpec[] = ['x', 'y', 'z'].map(n => ({ id: `att:${n}`, kind: 'blob' as const, hash: n === 'y' ? 'new' : 'same', load: async () => { loaded.push(n); return bytesOf(4, 1); } }));
        const carried: string[] = [];
        const update = { has: () => true, hashOf: (id: string) => (id === 'att:y' ? 'old' : 'same'), carry: (id: string) => { carried.push(id); }, addBytes: async () => undefined } as unknown as ContainerWriter;
        const r = await writeBackupRecords(plan(specs), { update }, { prefetch: { concurrency: 4, byteBudget: 1 << 20 } });
        expect(loaded).toEqual(['y']);
        expect(carried).toEqual(['att:x', 'att:z']);
        expect(r.updatedRecords).toBe(1);
    });
});
