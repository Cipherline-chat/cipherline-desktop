// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { StrictMode, act, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyPinOp, applyPinOps, localPinOp, replaySafePinUpdater, type PinLedger, type PinMap, type PinOp } from './pinSync';
import { mergeScope } from './personalSavesSync';

/**
 * DM / group pins are personal: a pinned-id map in React state with its LWW
 * ledger in a ref beside it (Dashboard's pinnedMessagesState + pinLedgerRef).
 * Owner report 2026-10-08, "same with unpinning": in the dev build — React
 * StrictMode, which double-invokes state updaters — Unpin did nothing.
 *
 * This mounts the exact Dashboard shape in real React 19 StrictMode, once with
 * the old inline updater (the CONTROL: it must reproduce the bug, or this test
 * proves nothing) and once with replaySafePinUpdater.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mode = 'inline' | 'replaySafe';
interface Api { pin(c: string, id: string): void; unpin(c: string, id: string): void; incoming(ops: PinOp[]): void; merge(remote: { pins: PinMap; ledger: PinLedger }): void; bump(): void }

let api: Api | null = null;
let seen: PinMap = {};
let root: Root | null = null;

function Harness({ mode, initial }: { mode: Mode; initial?: { pins: PinMap; ledger: PinLedger } }) {
    const [pins, setPins] = useState<PinMap>(initial?.pins ?? {});
    const [, setOther] = useState(0);
    const ledgerRef = useRef<PinLedger>(initial?.ledger ?? {});
    const apply = useCallback((step: (s: { pins: PinMap; ledger: PinLedger }) => { pins: PinMap; ledger: PinLedger }) => {
        if (mode === 'inline') {
            // Dashboard before the fix, verbatim in shape.
            setPins(prev => {
                const next = step({ pins: prev, ledger: ledgerRef.current });
                ledgerRef.current = next.ledger;
                return next.pins;
            });
        } else {
            setPins(replaySafePinUpdater(ledgerRef, step));
        }
    }, [mode]);
    // Handed to the test from effects (not during render), like Dashboard's handlers.
    useLayoutEffect(() => {
        api = {
            pin: (c, id) => { const op = localPinOp(c, id, 'add', Date.now(), ledgerRef.current); apply(s => applyPinOp(s, op)); },
            unpin: (c, id) => { const op = localPinOp(c, id, 'remove', Date.now(), ledgerRef.current); apply(s => applyPinOp(s, op)); },
            incoming: (ops) => apply(s => applyPinOps(s, ops)),
            merge: (remote) => apply(s => mergeScope(s, remote)),
            bump: () => setOther(x => x + 1),
        };
    }, [apply]);
    useLayoutEffect(() => { seen = pins; }, [pins]);
    return null;
}

const mount = async (mode: Mode, initial?: { pins: PinMap; ledger: PinLedger }) => {
    root = createRoot(document.createElement('div'));
    await act(async () => { root!.render(React.createElement(StrictMode, null, React.createElement(Harness, { mode, initial }))); });
};
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; api = null; seen = {}; });

describe('personal (DM/group) pins under React StrictMode', () => {
    it('CONTROL: the old inline updater loses the unpin — the reported bug', async () => {
        await mount('inline');
        await act(async () => { api!.pin('dm-1', 'm1'); });
        await act(async () => { api!.unpin('dm-1', 'm1'); });
        expect(seen['dm-1']).toEqual(['m1']);   // still pinned: the bug
    });

    it('CONTROL: with another update queued first, the old updater loses the pin too', async () => {
        await mount('inline');
        await act(async () => { api!.bump(); api!.pin('dm-1', 'm1'); });
        expect(seen['dm-1']).toBeUndefined();
    });

    it('DM: pin then unpin works', async () => {
        await mount('replaySafe');
        await act(async () => { api!.pin('dm-1', 'm1'); });
        expect(seen['dm-1']).toEqual(['m1']);
        await act(async () => { api!.unpin('dm-1', 'm1'); });
        expect(seen['dm-1']).toBeUndefined();
    });

    it('group: pin, pin another, unpin one, with unrelated updates queued alongside', async () => {
        await mount('replaySafe');
        await act(async () => { api!.bump(); api!.pin('group-1', 'a'); });
        await act(async () => { api!.pin('group-1', 'b'); api!.bump(); });
        await act(async () => { api!.bump(); api!.unpin('group-1', 'a'); });
        expect(seen['group-1']).toEqual(['b']);
    });

    it('an unpin synced from your other device (pin op) applies', async () => {
        await mount('replaySafe');
        await act(async () => { api!.pin('dm-1', 'm1'); });
        await act(async () => { api!.incoming([{ container_id: 'dm-1', target_id: 'm1', action: 'remove', at: Date.now() + 1000 }]); });
        expect(seen['dm-1']).toBeUndefined();
    });

    // Already pinned locally at t=1000; your other device unpinned it at t=2000.
    const PINNED_HERE = { pins: { 'dm-1': ['m1'] }, ledger: { 'dm-1': { m1: 1000 } } };
    const UNPINNED_THERE = { pins: {}, ledger: { 'dm-1': { m1: 2000 } } };

    it('CONTROL: an unpin arriving through the personal_saves merge is lost by the old updater (re-run ties at t=2000, "present" wins)', async () => {
        await mount('inline', PINNED_HERE);
        await act(async () => { api!.bump(); api!.merge(UNPINNED_THERE); });
        expect(seen['dm-1']).toEqual(['m1']);
    });

    it('an unpin arriving through the personal_saves merge applies', async () => {
        await mount('replaySafe', PINNED_HERE);
        await act(async () => { api!.bump(); api!.merge(UNPINNED_THERE); });
        expect(seen['dm-1']).toBeUndefined();
    });
});
