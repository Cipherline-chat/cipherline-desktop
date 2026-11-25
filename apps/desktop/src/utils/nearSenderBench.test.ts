/**
 * Sender-path benchmark for the local history transfer (B6). Skipped unless CL_NEAR_BENCH=1:
 *   CL_NEAR_BENCH=1 CL_NEAR_BENCH_MB=300 npx vitest run src/utils/nearSenderBench.test.ts --testTimeout=600000
 * Drives the REAL pipeline (specsFromVault -> writeBackupRecords -> ContainerWriter.createRaw -> spool sink) over a synthetic
 * history into a fake bridge backed by a real temp file. Each bridge call pays a structured clone of its payload plus a macrotask
 * hop, which is the floor of what Electron's contextBridge + ipcRenderer.invoke costs; the real IPC adds more, so the number is an
 * upper bound for the whole page-side path and a faithful one for everything this module controls.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from "node:path";
import { promisify } from "node:util";

beforeAll(() => { Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob }); });

import { ContainerWriter, openContainer, type ByteSource } from './backupContainer';
import { NEAR_SEND_PREFETCH } from './nearHistoryPort';
import { createNearSpoolSink, type NearHistoryApi } from './nearHistoryTransfer';
import { specsFromVault, writeBackupRecords, fingerprintFromSpecs } from '../services/backupRecords';

const RUN = process.env.CL_NEAR_BENCH === '1';
const MiB = 1024 * 1024;
const wr = promisify(fs.write) as unknown as (fd: number, b: Buffer, o: number, l: number, p: number) => Promise<number>;

function fakeApi(dir: string): { api: NearHistoryApi; calls: () => number } {
    let calls = 0;
    const sessions = new Map<string, { fd: number; pos: number; tmp: string; fin: string }>();
    const hop = async <T,>(v: T): Promise<T> => { calls++; await new Promise<void>(r => setImmediate(r)); return v; };
    const api = {
        backupStagingDir: async () => dir,
        backupBeginWrite: async (_d: string, name: string) => {
            const fin = path.join(dir, name); const tmp = `${fin}.partial`;
            const id = `s${sessions.size}`; sessions.set(id, { fd: fs.openSync(tmp, 'w'), pos: 0, tmp, fin });
            return hop({ sessionId: id, size: 0 });
        },
        backupAppend: async (id: string, data: Uint8Array) => {
            const s = sessions.get(id)!; const copy = structuredClone(data); await hop(0);
            const buf = Buffer.from(copy); await wr(s.fd, buf, 0, buf.length, s.pos); s.pos += buf.length;
        },
        backupWriteAt: async (id: string, off: number, data: Uint8Array) => {
            const s = sessions.get(id)!; const copy = structuredClone(data); await hop(0);
            const buf = Buffer.from(copy); fs.fsyncSync(s.fd); await wr(s.fd, buf, 0, buf.length, off);
        },
        backupCommit: async (id: string) => {
            const s = sessions.get(id)!; fs.fsyncSync(s.fd); fs.closeSync(s.fd); fs.renameSync(s.tmp, s.fin);
            return hop({ path: s.fin, size: fs.statSync(s.fin).size });
        },
        backupAbort: async () => undefined,
    } as unknown as NearHistoryApi;
    return { api, calls: () => calls };
}

describe.skipIf(!RUN)('near sender bench (CL_NEAR_BENCH=1)', () => {
    it('spools a synthetic history', async () => {
        const totalMb = Number(process.env.CL_NEAR_BENCH_MB ?? 300);
        const attSizeKb = Number(process.env.CL_NEAR_BENCH_ATT_KB ?? 2048);
        const loadMs = Number(process.env.CL_NEAR_BENCH_LOAD_MS ?? 0);
        const prefetch = process.env.CL_NEAR_BENCH_PREFETCH === '0' ? undefined : NEAR_SEND_PREFETCH;
        const nAtt = Math.ceil((totalMb * 1024) / attSizeKb);
        const template = new Uint8Array(attSizeKb * 1024);
        for (let i = 0; i < template.length; i += 65536) crypto.getRandomValues(template.subarray(i, Math.min(template.length, i + 65536)));

        const history: Record<string, unknown[]> = {};
        const base = Date.UTC(2025, 0, 1);
        for (let c = 0; c < 20; c++) {
            history[`conv-${c}`] = Array.from({ length: 200 }, (_, i) => ({ id: `m${c}-${i}`, timestamp: new Date(base + (c * 200 + i) * 3_600_000).toISOString(), content: { type: 'text', text: `hello ${i} `.repeat(8) } }));
        }
        const attachmentIds = Array.from({ length: nAtt }, (_, i) => `a${String(i).padStart(5, '0')}`);
        let loads = 0;
        const specs = await specsFromVault({
            meta: { v: 1 }, history, channelHistory: {}, attachmentIds,
            loaders: { attachment: async () => { loads++; if (loadMs) await new Promise(r => setTimeout(r, loadMs)); return template.slice(); } },
        });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-bench-'));
        const { api, calls } = fakeApi(dir);
        const key = crypto.getRandomValues(new Uint8Array(32));
        const t0 = performance.now();
        const spool = await createNearSpoolSink(api, 'bench.enc');
        const writer = await ContainerWriter.createRaw(key, spool.sink);
        await writeBackupRecords({ userId: 'u', fingerprint: await fingerprintFromSpecs(specs), records: specs, attachmentIds, attachmentSizeHints: Object.fromEntries(attachmentIds.map(id => [id, attSizeKb * 1024])) }, { fresh: writer }, { prefetch });
        await writer.finish({ userId: 'u', fingerprint: 'f' });
        const { path: out, size } = await spool.commit();
        const secs = (performance.now() - t0) / 1000;
        const mb = size / MiB;
        console.log(`[near-bench] ${mb.toFixed(1)} MiB in ${secs.toFixed(2)} s = ${(mb / secs).toFixed(1)} MiB/s; ipc calls ${calls()}; attachment loads ${loads}; loadMs ${loadMs} prefetch ${prefetch ? 'on' : 'off'}; loadavg ${os.loadavg()[0].toFixed(1)}`);

        const fd = fs.openSync(out, 'r');
        const source: ByteSource = { size: async () => size, read: async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return new Uint8Array(b); } };
        const opened = await openContainer(source, { rawKey: key });
        expect(opened.index.records.length).toBe(specs.length);
        fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true });
    });
});
