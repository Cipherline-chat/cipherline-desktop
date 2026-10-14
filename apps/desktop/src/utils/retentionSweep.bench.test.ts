import { describe, it } from 'vitest';
import { sweepRetention } from './retentionSweeper';
import type { StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * Retention-sweep COST HARNESS — a measuring tool, not a regression test.
 * Skipped unless CL_FREEZE_BENCH=1:
 *
 *   CL_FREEZE_BENCH=1 npx vitest run src/utils/retentionSweep.bench.test.ts
 *
 * Dashboard runs the sweep over EVERY cached thread, synchronously, on every
 * window focus (throttled to one per 30 s) and every 5 minutes — i.e. exactly
 * when the user clicks back into the app. This times that scan (one
 * sweepRetention call per thread, as Dashboard makes them) by history size and
 * by how many message ids the user has saved / unsaved (the policy keeps them
 * as ARRAYS, searched with includes() per message).
 */
const RUN = process.env.CL_FREEZE_BENCH === '1';
const NOW = Date.UTC(2026, 9, 12);

type Msg = { id: string; timestamp: string; content: { type: string; attachment_id?: string; text?: string } };
function thread(n: number, t: number): Msg[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `m-${t}-${i}-${'x'.repeat(20)}`,
        timestamp: new Date(NOW - (n - i) * 3 * 60_000).toISOString(),
        content: i % 25 === 0 ? { type: 'attachment', attachment_id: `a-${t}-${i}` } : { type: 'text', text: 'hello there' },
    }));
}

function policy(saved: number, retention: StoragePolicy['messageRetention']): StoragePolicy {
    const ids = (p: string) => Array.from({ length: saved }, (_, i) => `${p}-${i}-${'y'.repeat(20)}`);
    return {
        attachmentRetention: '24h', messageRetention: retention,
        savedAttachmentIds: ids('sa'), unsavedAttachmentIds: ids('ua'),
        savedMessageIds: ids('sm'), unsavedMessageIds: ids('um'),
        unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
    };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!RUN)('retention sweep cost on focus', () => {
    it('scales with history and saved-id count', () => {
        const rows: string[] = [];
        for (const [threads, per] of [[60, 250], [60, 1000], [100, 2000]] as const) {
            const state: Record<string, Msg[]> = {};
            for (let t = 0; t < threads; t++) state[`c${t}`] = thread(per, t);
            for (const saved of [0, 50, 500, 2000]) {
                for (const ret of ['never', '1mo'] as const) {
                    const p = policy(saved, ret);
                    const ms: number[] = [];
                    for (let rep = 0; rep < 5; rep++) {
                        const t0 = performance.now();
                        for (const id of Object.keys(state)) sweepRetention({ [id]: state[id] }, p, NOW + rep, { [id]: new Set() });
                        ms.push(performance.now() - t0);
                    }
                    rows.push(`${String(threads * per).padStart(7)} msgs  saved/unsaved ${String(saved).padStart(4)} each  retention ${ret.padEnd(5)}  ${median(ms).toFixed(1).padStart(7)} ms`);
                }
            }
        }
        console.log(`\none full sweep (median of 5):\n${rows.join('\n')}\n`);
    }, 600_000);
});
