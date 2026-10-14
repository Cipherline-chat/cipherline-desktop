// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelKeyWait } from './ChannelKeyWait';
import { useChannelKeyWait, KEY_WAIT_EXIT_MS } from '../hooks/useChannelKeyWait';
import {
    KEY_WAIT_COPY, KEY_WAIT_STALL_MS, KEY_RECEIVED_GRACE_MS, beginChannelPageDecrypt, noteChannelKeyReceived,
    noteKeyRequestAcked, noteNewestKeyPending, resetKeyWaitSignals, needsKeyWaitState,
} from '../utils/channelKeyWait';
import { channelPlaceholderContent } from '../utils/channelDecryptFailure';
import { isUndecryptablePlaceholder } from '../utils/channelHistoryMerge';
import { KeyReaskScheduler, ReaskBudget, ReaskTargets, runReaskTick, KEY_REASK_AT_MS } from '../utils/keyReask';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A fresh joiner's key wait, end to end through the REAL pieces: the key-wait
 * stage store (utils/channelKeyWait.ts), the layer's hook + component, and the
 * keyless side's re-ask scheduler + check (utils/keyReask.ts). The Dashboard
 * glue is reproduced line for line (fileKeyRequest: ack → target + pending
 * flag + arm; the check's onSatisfied: re-read the open channel, then drop the
 * flag; pullChannelKeysOnce: install → noteChannelKeyReceived; ingest:
 * begin/end page decrypt) — channelKeyWaitWiring / channelKeyReliabilityWiring
 * pin that Dashboard really does those.
 *
 * Network, crypto and React's Dashboard are not here: an "envelope" is a flag
 * on the fake server, and the open channel's thread is test state.
 */

const SID = 'srv';
const CH = 'chan-joined';
let n = 0;
const pill = () => ({ id: `p${++n}`, content: channelPlaceholderContent('key_missing', 3), sender_device_id: 'd' });
const text = () => ({ id: `t${++n}`, content: { type: 'text', text: 'hi' }, sender_device_id: 'd' });
const many = <T,>(k: number, f: () => T) => Array.from({ length: k }, f);
type Row = { id?: string; content?: unknown; sender_device_id?: string };

let root: Root | null = null;
let host: HTMLDivElement;
const rowsSetter: { current: (r: Row[]) => void } = { current: () => {} };
const setRows = (r: Row[]) => rowsSetter.current(r);

const Pane: React.FC<{ initial: Row[] }> = ({ initial }) => {
    const [rows, set] = React.useState<Row[]>(initial);
    React.useEffect(() => { rowsSetter.current = set; }, [set]);
    const kw = useChannelKeyWait({ enabled: true, channelId: CH, messages: rows });
    return React.createElement('div', null,
        kw.holdList ? null : React.createElement('div', { className: 'list' }, rows.map(r => React.createElement('div', { key: r.id, className: 'row' }))),
        kw.phase !== 'hidden' ? React.createElement(ChannelKeyWait, { phase: kw.phase, stage: kw.stage, reduced: false }) : null,
    );
};

const layer = () => host.querySelector('.ckw-root');
const title = () => host.querySelector('.ckw-copy-in .ckw-title')?.textContent ?? null;
const pillsPainted = () => host.querySelectorAll('.row').length;

/** The joining device, as Dashboard wires it. */
function makeJoiner(opts: { rereadOnSatisfied: boolean }) {
    let thread: Row[] = many(100, pill);
    const server = { envelopeWaiting: false, requests: 0 };
    let heldEpoch: number | null = null;
    const dedup = new Map<string, number>();
    const targets = new ReaskTargets();
    const budget = new ReaskBudget();

    const refresh = async () => {
        const end = beginChannelPageDecrypt(CH);
        await Promise.resolve();
        thread = many(100, text);
        act(() => { setRows(thread); });
        end();
    };
    // pullChannelKeysOnce: install what is waiting (no push needed).
    const pull = async () => {
        if (!server.envelopeWaiting) return;
        server.envelopeWaiting = false;
        heldEpoch = 3;
        noteChannelKeyReceived(CH);
    };

    // fileKeyRequest.
    const fileKeyRequest = async () => {
        dedup.set(CH, Date.now());
        const keyless = heldEpoch === null;
        server.requests += 1;
        noteKeyRequestAcked(CH);
        if (keyless) {
            targets.add(SID, CH, 3);
            noteNewestKeyPending(CH, true);
            scheduler.arm(SID);
        }
    };
    const scheduler: KeyReaskScheduler = new KeyReaskScheduler({
        onExhausted: sid => { for (const c of targets.forServer(sid)) noteNewestKeyPending(c, false); targets.clearServer(sid); },
        tick: sid => runReaskTick({
            pull,
            wantedChannels: s => targets.forServer(s),
            hasNewest: async () => heldEpoch !== null && heldEpoch >= (targets.latestOf(CH) ?? 1),
            onSatisfied: cid => {
                targets.delete(cid);
                if (opts.rereadOnSatisfied && thread.some(isUndecryptablePlaceholder)) {
                    void refresh().finally(() => noteNewestKeyPending(cid, false));
                } else {
                    noteNewestKeyPending(cid, false);
                }
            },
            lastAskedAt: c => dedup.get(c),
            activeChannelId: () => CH,
            fileKeyRequest: () => fileKeyRequest(),
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            now: () => Date.now(),
            budget,
        }, sid),
    });
    return { server, fileKeyRequest, scheduler, thread: () => thread };
}

beforeEach(() => {
    vi.useFakeTimers();
    resetKeyWaitSignals();
    Object.defineProperty(window, 'matchMedia', {
        configurable: true, writable: true,
        value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.useRealTimers();
});

async function advance(ms: number, step = 250, onStep?: () => void) {
    for (let t = 0; t < ms; t += step) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, ms - t)); });
        onStep?.();
    }
}

describe('fresh joiner: the key-wait layer through the re-ask flow', () => {
    it('mounts on the landing channel, stays up through re-asks (no flash), advances asking → asked → received/building, unmounts once the key is in', async () => {
        const j = makeJoiner({ rereadOnSatisfied: true });
        act(() => { root!.render(React.createElement(Pane, { initial: j.thread() })); });
        expect(layer()).not.toBeNull();
        expect(pillsPainted()).toBe(0);
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);

        // Join: the request is filed and acknowledged.
        await act(async () => { await j.fileKeyRequest(); });
        expect(host.querySelector('[role="status"]')!.textContent).toContain(KEY_WAIT_COPY.asked.detail);

        // The holder's first answer is lost. Re-asks at 2.5 s and 6 s: the
        // layer never leaves and the copy never steps back to "asking".
        const seen = new Set<string | null>();
        let flashed = false;
        await advance(KEY_REASK_AT_MS[1] + 500, 250, () => {
            if (!layer()) flashed = true;
            seen.add(host.querySelector('[role="status"]')?.textContent?.includes(KEY_WAIT_COPY.asked.detail) ? 'asked' : 'other');
        });
        expect(flashed).toBe(false);
        expect(j.server.requests).toBeGreaterThanOrEqual(3); // initial + 2 re-asks
        // Every sample showed the asked copy (asking/asked share a title; the detail differs).
        expect([...seen]).toEqual(['asked']);

        // A holder answers; its push is missed. The next check's own pull
        // installs the key, re-reads the open channel, and the layer leaves.
        j.server.envelopeWaiting = true;
        const stages = new Set<string | null>();
        await advance(KEY_REASK_AT_MS[2] - KEY_REASK_AT_MS[1] + 500, 50, () => stages.add(title()));
        expect([...stages].some(t => t === KEY_WAIT_COPY.received.title || t === KEY_WAIT_COPY.building.title)).toBe(true);
        await advance(KEY_WAIT_EXIT_MS + 100);
        expect(layer()).toBeNull();
        expect(pillsPainted()).toBe(100); // the readable list, not pills
        expect(j.thread().some(isUndecryptablePlaceholder)).toBe(false);
        j.scheduler.disarmAll();
    });

    it('NEGATIVE CONTROL: without the re-read on a check-installed key, the layer sits on "received", then falls back — it never leaves', async () => {
        const j = makeJoiner({ rereadOnSatisfied: false });
        act(() => { root!.render(React.createElement(Pane, { initial: j.thread() })); });
        await act(async () => { await j.fileKeyRequest(); });
        j.server.envelopeWaiting = true;
        await advance(KEY_REASK_AT_MS[0] + 300);
        expect(title()).toBe(KEY_WAIT_COPY.received.title);
        await advance(KEY_RECEIVED_GRACE_MS + 2_000);
        expect(layer()).not.toBeNull();
        expect(title()).not.toBe(KEY_WAIT_COPY.received.title);
        expect(pillsPainted()).toBe(0);
        j.scheduler.disarmAll();
    });

    it('stalled copy at ~18 s while re-asks keep going: no flicker back to "asking", and it still leaves when the key lands', async () => {
        const j = makeJoiner({ rereadOnSatisfied: true });
        act(() => { root!.render(React.createElement(Pane, { initial: j.thread() })); });
        await act(async () => { await j.fileKeyRequest(); });
        await advance(KEY_WAIT_STALL_MS + 500);
        expect(title()).toBe(KEY_WAIT_COPY.stalled.title);
        expect(KEY_WAIT_COPY.stalled.detail).toMatch(/keeps asking/);
        // The 30 s re-ask: still the stalled copy, still up.
        const before = j.server.requests;
        await advance(30_000 - KEY_WAIT_STALL_MS);
        expect(j.server.requests).toBeGreaterThan(before);
        expect(title()).toBe(KEY_WAIT_COPY.stalled.title);
        // Key arrives (missed push) → next check installs + re-reads → gone.
        j.server.envelopeWaiting = true;
        await advance(30_000 + KEY_WAIT_EXIT_MS + 500);
        expect(layer()).toBeNull();
        j.scheduler.disarmAll();
    });

    it('a channel opened later, while OTHER channels already have keys: its own signals drive it (keys elsewhere change nothing)', async () => {
        noteChannelKeyReceived('other-channel');
        act(() => { root!.render(React.createElement(Pane, { initial: many(100, pill) })); });
        expect(layer()).not.toBeNull();
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);
    });
});

describe('the newest-page rule for joiners', () => {
    it('partial delivery (newest epoch refused, history landed): a readable minority no longer cancels the wait while the newest key is pending', () => {
        const rows = [...many(40, text), ...many(60, pill)];
        expect(needsKeyWaitState(rows)).toBe(false); // control: the strict rule
        expect(needsKeyWaitState(rows, undefined, { newestKeyPending: true })).toBe(true);
        // …but not when readable rows are the majority
        expect(needsKeyWaitState([...many(60, text), ...many(40, pill)], undefined, { newestKeyPending: true })).toBe(false);
    });

    it('the joiner\'s own pending send and "X joined" lines do not cancel it', () => {
        const joined = { id: 'sys_1', content: { type: 'system', text: 'ann joined the server.' }, sender_device_id: '' };
        expect(needsKeyWaitState([...many(30, pill), joined])).toBe(true);
        expect(needsKeyWaitState([...many(30, pill), text()], undefined, { newestKeyPending: true })).toBe(true);
    });

    it('an empty channel with no key shows the normal empty state (the composer gate says what is missing), not the layer', () => {
        expect(needsKeyWaitState([], undefined, { newestKeyPending: true })).toBe(false);
    });

    it('through the hook: the pending flag brings the layer up for a mixed page, and dropping it lets the list show', async () => {
        noteNewestKeyPending(CH, true);
        act(() => { root!.render(React.createElement(Pane, { initial: [...many(40, text), ...many(60, pill)] })); });
        expect(layer()).not.toBeNull();
        expect(pillsPainted()).toBe(0);
        act(() => { setRows(many(100, text)); });
        await advance(KEY_WAIT_EXIT_MS + 100);
        expect(layer()).toBeNull();
    });
});
