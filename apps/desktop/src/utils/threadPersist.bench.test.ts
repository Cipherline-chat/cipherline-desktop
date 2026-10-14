import { describe, it } from 'vitest';
import * as crypto from 'crypto';
import * as v8 from 'v8';
import * as vm from 'vm';
import { KvCrypto } from '../../electron/kv-crypto';

/**
 * Thread-persistence COST HARNESS — a measuring tool, not a regression test.
 * Skipped unless CL_FREEZE_BENCH=1:
 *
 *   CL_FREEZE_BENCH=1 npx vitest run src/utils/threadPersist.bench.test.ts
 *
 * Every change to a conversation's or channel's message array rewrites that
 * WHOLE thread (messageStore.saveAll → secureLocalStore.setItem →
 * securekv:seal in main → IndexedDB put). This times one such write per
 * thread size, split by where the work runs:
 *   stringify   — JSON.stringify(thread) in the renderer (saveAll)
 *   ipc-copy    — v8 structured clone of the string, a proxy for the IPC hop
 *                 into main
 *   seal+return — the REAL KvCrypto.seal (AES-256-GCM) on main's thread, plus
 *                 the clone of the ciphertext coming back
 *   garbage     — bytes allocated per write (strings + Buffers): GC pressure,
 *                 most of it in MAIN's heap
 */
const RUN = process.env.CL_FREEZE_BENCH === '1';
if (RUN) v8.setFlagsFromString('--expose-gc');
const gc = (): void => { if (RUN) (vm.runInNewContext('gc') as () => void)(); };

function message(i: number): Record<string, unknown> {
    return {
        id: crypto.randomUUID(),
        channel_id: '7d3f1a2e-9c41-4b8e-a1f0-2b6c9d8e7f10',
        sender_id: crypto.randomUUID(),
        sender_device_id: crypto.randomUUID(),
        sender_display_name: 'Someone',
        content: `message ${i} - ${'lorem ipsum dolor sit amet '.repeat(1 + (i % 4))}`,
        created_at: new Date(1_760_000_000_000 + i * 60_000).toISOString(),
        epoch: 3,
        reactions: i % 7 === 0 ? { up: ['a', 'b'] } : {},
        reply_to: null,
        edited_at: null,
        decrypt_state: 'ok',
    };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!RUN)('thread persistence cost per write', () => {
    it('scales with thread length', () => {
        const master = crypto.randomBytes(32);
        const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => master });
        const rows: string[] = [];
        for (const n of [100, 500, 1000, 2500, 5000, 10000]) {
            const thread = Array.from({ length: n }, (_, i) => message(i));
            const s: number[] = [], c: number[] = [], e: number[] = [], g: number[] = [];
            let bytes = 0;
            for (let rep = 0; rep < 7; rep++) {
                gc();
                const h0 = process.memoryUsage();
                const t0 = performance.now();
                const json = JSON.stringify(thread);
                const t1 = performance.now();
                const copied = v8.deserialize(v8.serialize(json)) as string;
                const t2 = performance.now();
                const sealed = kv.seal([{ k: 'cipherline_channel_msgs_u_c', o: 'u', v: copied }]);
                const back = v8.deserialize(v8.serialize(sealed[0].b)) as Uint8Array;
                const t3 = performance.now();
                const h1 = process.memoryUsage();
                bytes = json.length;
                s.push(t1 - t0); c.push(t2 - t1); e.push(t3 - t2);
                g.push((h1.heapUsed - h0.heapUsed + h1.external - h0.external) / 1048576);
                if (back.length === 0) throw new Error('unreachable');
            }
            rows.push(`${String(n).padStart(6)} msgs  ${(bytes / 1048576).toFixed(2).padStart(5)} MB  stringify ${median(s).toFixed(1).padStart(6)} ms  ipc-copy ${median(c).toFixed(1).padStart(6)} ms  seal+return ${median(e).toFixed(1).padStart(6)} ms  garbage ~${median(g).toFixed(1).padStart(5)} MB`);
        }
        console.log(`\nper-write cost of one thread rewrite (median of 7):\n${rows.join('\n')}\n`);
    }, 300_000);
});
