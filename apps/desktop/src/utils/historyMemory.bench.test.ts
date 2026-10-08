import { describe, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KvCrypto } from '../../electron/kv-crypto';
import { applyIncomingDmMessages } from './dmInbound';

/**
 * Renderer message-history MEMORY + SPEED harness — a measuring tool, not a
 * regression test (secureLocalStore.detach.test.ts is the regression test).
 * Skipped unless CL_RAM_BENCH=1:
 *
 *   CL_RAM_BENCH=1 npx vitest run src/utils/historyMemory.bench.test.ts
 *
 * Optional A/B, same convention as vaultStall.bench.test.ts: copy the pre-change
 * modules to `.bench-baseline/ram/` (secureLocalStore.ts with its
 * `./attachmentCache` import pointed at `../../src/utils/attachmentCache`, and
 * messageStore.ts). OLD and NEW then run against identical synthetic accounts
 * on the same machine, interleaved.
 *
 * Real store, real main-side KvCrypto (AES-256-GCM), (fake) IndexedDB. Reports:
 *   boot     — hydrate + hydrateMessages + loadAll(dm) + loadAll(channel), ms
 *   held     — characters of decrypted thread JSON the store still holds in
 *              memory after boot, on top of the parsed threads (the copy the
 *              detached-values change removes; 2 bytes/char once a thread
 *              contains an emoji)
 *   merge    — one pulled DM batch merged into a 300-message thread, ms (median)
 *   persist  — saveAll of a one-message change + flushNow, ms (median)
 */

const RUN = process.env.CL_RAM_BENCH === '1';
const BASELINE_DIR = path.resolve(__dirname, '..', '..', '.bench-baseline', 'ram');
const HAVE_BASELINE = fs.existsSync(path.join(BASELINE_DIR, 'messageStore.ts'));

const USER = '11111111-2222-4333-8444-555555555555';
const KEY = Buffer.from(new Uint8Array(32).fill(7));

function installBridge(): void {
    const kv = new KvCrypto({ status: () => 'ok', keyBytes: () => KEY });
    (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
        getLocalMasterKeyStatus: vi.fn(async () => ({ status: 'ok' })),
        secureKvOpen: vi.fn(async (recs: Parameters<KvCrypto['open']>[0]) => kv.open(recs)),
        secureKvSeal: vi.fn(async (recs: Parameters<KvCrypto['seal']>[0]) => kv.seal(recs)),
    };
}

async function wipeDb(): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

const words = 'the quick brown fox jumps over lazy dog meeting tonight sounds good see you later lol that is wild ship it'.split(' ');
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function thread(n: number, cid: string) {
    return Array.from({ length: n }, (_, i) => {
        const id = `${cid}-${i}`;
        const w = Array.from({ length: 4 + Math.floor(rnd() * 18) }, () => words[Math.floor(rnd() * words.length)]);
        if (rnd() < 0.2) w.push('🎉');
        return { id, content: { type: 'text', text: w.join(' '), client_msg_id: id }, sender_device_id: 'd', sender_user_id: 'u', timestamp: new Date(1759700000000 + i * 6e5).toISOString(), conversation_id: cid };
    });
}

type Store = { hydrate(): Promise<void>; hydrateMessages(): Promise<void>; setItem(k: string, v: string): void; flushNow(): Promise<void>; whenAccountReady(): Promise<void>; _resetForTest(): void };
type MStore = {
    loadAll(k: 'dm' | 'channel', u: string): Promise<Record<string, unknown[]>>;
    saveAll(k: 'dm' | 'channel', u: string, m: Record<string, unknown[]>): void;
    mergeThreads(k: 'dm', u: string, inc: Record<string, unknown[]>, merge: typeof applyIncomingDmMessages): Promise<string[]>;
    _resetForTest(): void;
};

async function runVariant(label: string, store: Store, ms: MStore, dmN: number, chN: number, per: number) {
    await wipeDb();
    store._resetForTest(); ms._resetForTest(); installBridge();
    await store.hydrate();
    store.setItem('cipherline_user_id', USER);
    await store.whenAccountReady();
    seed = 1;
    const dms: Record<string, unknown[]> = {}; const chs: Record<string, unknown[]> = {};
    for (let i = 0; i < dmN; i++) dms[`dm${i}`] = thread(per, `dm${i}`);
    for (let i = 0; i < chN; i++) chs[`ch${i}`] = thread(per, `ch${i}`);
    ms.saveAll('dm', USER, dms); ms.saveAll('channel', USER, chs);
    await store.flushNow();

    // Cold boot.
    store._resetForTest(); ms._resetForTest(); installBridge();
    const t0 = performance.now();
    await store.hydrate();
    await store.hydrateMessages();
    const state = { dm: await ms.loadAll('dm', USER), ch: await ms.loadAll('channel', USER) };
    const boot = performance.now() - t0;
    await store.flushNow();
    const inner = store as unknown as { map: Map<string, string>; detached?: Set<string> };
    let mapChars = 0;
    for (const v of inner.map.values()) mapChars += v.length;

    const merges: number[] = [];
    for (let i = 0; i < 30; i++) {
        const s = performance.now();
        await ms.mergeThreads('dm', USER, { dm0: [{ id: `new-${i}`, content: { type: 'text', text: 'hi' } }] }, applyIncomingDmMessages);
        merges.push(performance.now() - s);
        await store.flushNow();
    }
    const persists: number[] = [];
    let cur = state.dm;
    for (let i = 0; i < 30; i++) {
        cur = { ...cur, dm1: [...cur.dm1, { id: `p-${i}`, content: { type: 'text', text: 'yo' } }] };
        const s = performance.now();
        ms.saveAll('dm', USER, cur);
        await store.flushNow();
        persists.push(performance.now() - s);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`${label.padEnd(4)} boot ${boot.toFixed(0).padStart(5)} ms | held ${(mapChars / 1048576).toFixed(1).padStart(5)}M chars | merge ${med(merges).toFixed(2).padStart(6)} ms | persist ${med(persists).toFixed(2).padStart(6)} ms  (threads ${Object.keys(state.dm).length + Object.keys(state.ch).length}, detached ${inner.detached?.size ?? 0})`);
}

describe.skipIf(!RUN)('history memory/speed (CL_RAM_BENCH=1)', () => {
    it('heavy account: 40 DMs + 60 channels x 300 messages', async () => {
        const NEW = { store: (await import('./secureLocalStore')).secureLocalStore as unknown as Store, ms: (await import('./messageStore')) as unknown as MStore };
        const OLD = HAVE_BASELINE
            ? { store: (await import(/* @vite-ignore */ path.join(BASELINE_DIR, 'secureLocalStore.ts'))).secureLocalStore as Store, ms: (await import(/* @vite-ignore */ path.join(BASELINE_DIR, 'messageStore.ts'))) as MStore }
            : null;
        for (let round = 0; round < 5; round++) {
            if (OLD) await runVariant('OLD', OLD.store, OLD.ms, 40, 60, 300);
            await runVariant('NEW', NEW.store, NEW.ms, 40, 60, 300);
        }
    }, 600_000);
});
