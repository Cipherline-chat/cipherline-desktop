// @vitest-environment jsdom
/**
 * Regression test for the "deleted pins linger on the deleting device" bug
 * fixed in Dashboard.tsx's `handleOptimisticMessage`, `handleChannelMessage`
 * (live WS) and `handleChannelMessageSent`: the deleted target id used to be
 * assigned INSIDE the (nominally pure) setState updater and read right after
 * the setState call returned. That is not reliable — React does not
 * guarantee an updater runs synchronously as part of the call that scheduled
 * it, so the outer variable can still be null when read.
 *
 * Empirically (see the probe reasoning below, reproduced directly by the
 * first two `it`s in each describe block): only the very FIRST ever update
 * on a freshly-mounted component gets React's synchronous "eager state" fast
 * path — every update after the component has already rendered once is
 * deferred to the actual render/commit, which does not happen synchronously
 * inside the dispatch call. A delete is never the very first message a
 * conversation/channel receives in practice (something has to exist to
 * delete), so the shipped bug reproduces on essentially every real delete,
 * not just an edge case.
 *
 * This mounts a minimal component that reproduces the exact shape of the
 * three fixed functions — the OLD (buggy) ordering and the FIXED ordering
 * actually shipped — against the real `deletedDmTargets` /
 * `deletedChannelTargetIds` helpers (the same ones Dashboard.tsx imports),
 * using real `react-dom/client` + `act`, not a mock of React's scheduler.
 */
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deletedDmTargets } from '../utils/dmInbound';
import { deletedChannelTargetIds } from '../utils/channelHistoryMerge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Msg = { id: string; conversation_id: string; content: unknown; sender_device_id?: string; timestamp: string };
type ThreadMap = Record<string, Msg[]>;
type Receiver = (
    m: Msg,
    stateRef: React.MutableRefObject<ThreadMap>,
    setState: React.Dispatch<React.SetStateAction<ThreadMap>>,
    onUnpin: (targetId: string) => void,
) => void;

// ── DM shape (mirrors handleOptimisticMessage) ──────────────────────────────

/** The shape shipped BEFORE the fix: the delete's target id is assigned
 *  INSIDE the setState updater and read right after the call returns. */
const receiveDmBuggy: Receiver = (m, _stateRef, setState, onUnpin) => {
    let deletedTargetId: string | null = null;
    setState(prev => {
        const cId = m.conversation_id;
        const thread = [...(prev[cId] || [])];
        const content = m.content as { type?: string; target_id?: string } | undefined;
        if (content?.type === 'delete') {
            const idx = thread.findIndex(t => t.id === content.target_id);
            if (idx !== -1) {
                deletedTargetId = content.target_id!; // side effect INSIDE the updater
                thread.splice(idx, 1);
            }
        } else if (!thread.find(t => t.id === m.id)) {
            thread.push(m);
        }
        return { ...prev, [cId]: thread };
    });
    if (deletedTargetId) onUnpin(deletedTargetId);
};

/** The shape shipped in the fix: computed from messagesStateRef via the real
 *  `deletedDmTargets` helper BEFORE the setState call. The updater is pure. */
const receiveDmFixed: Receiver = (m, stateRef, setState, onUnpin) => {
    const deletedTargetId = deletedDmTargets(
        stateRef.current,
        { [m.conversation_id]: [m as never] },
    )[0]?.targetId ?? null;
    setState(prev => {
        const cId = m.conversation_id;
        const thread = [...(prev[cId] || [])];
        const content = m.content as { type?: string; target_id?: string } | undefined;
        if (content?.type === 'delete') {
            const idx = thread.findIndex(t => t.id === content.target_id);
            if (idx !== -1) thread.splice(idx, 1);
        } else if (!thread.find(t => t.id === m.id)) {
            thread.push(m);
        }
        return { ...prev, [cId]: thread };
    });
    if (deletedTargetId) onUnpin(deletedTargetId);
};

function mountHarness(receive: Receiver) {
    let receiveNow: ((m: Msg) => void) | null = null;
    const Harness = ({ onUnpin }: { onUnpin: (id: string) => void }) => {
        const [state, setState] = React.useState<ThreadMap>({});
        const stateRef = React.useRef<ThreadMap>(state);
        React.useEffect(() => { stateRef.current = state; });
        receiveNow = (m: Msg) => receive(m, stateRef, setState, onUnpin);
        return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root | null = createRoot(host);
    const unpinned: string[] = [];
    act(() => root!.render(React.createElement(Harness, { onUnpin: (id: string) => unpinned.push(id) })));
    return {
        receive: (m: Msg) => receiveNow!(m),
        unpinned,
        cleanup: () => { act(() => root!.unmount()); root = null; host.remove(); },
    };
}

const textMsg = (id: string, cid: string): Msg =>
    ({ id, conversation_id: cid, content: { type: 'text', text: 'hi' }, sender_device_id: 'd1', timestamp: new Date().toISOString() });
const deleteMsg = (targetId: string, cid: string): Msg =>
    ({ id: `del-${targetId}`, conversation_id: cid, content: { type: 'delete', target_id: targetId }, sender_device_id: 'd1', timestamp: new Date().toISOString() });

describe('DM delete-unpin timing (handleOptimisticMessage)', () => {
    it('BUGGY ordering misses the unpin once a prior render has already committed — guards against regressing to the shipped bug', () => {
        const h = mountHarness(receiveDmBuggy);
        // Trigger a real, committed re-render first: a delete is never the
        // very first message a conversation receives in practice.
        act(() => h.receive(textMsg('m1', 'c1')));
        // Called synchronously with no wrapping act(), exactly like the real
        // callers (a WS event / promise callback, never a React event).
        h.receive(deleteMsg('m1', 'c1'));
        expect(h.unpinned).toEqual([]); // the bug: the unpin callback never fires
        h.cleanup();
    });

    it('FIXED ordering (compute via deletedDmTargets from the ref BEFORE setState) fires the unpin with the right id, in the same scenario', () => {
        const h = mountHarness(receiveDmFixed);
        act(() => h.receive(textMsg('m1', 'c1')));
        h.receive(deleteMsg('m1', 'c1'));
        expect(h.unpinned).toEqual(['m1']);
        h.cleanup();
    });

    it('FIXED ordering does not fire when the deleted message was never in the thread (nothing to unpin)', () => {
        const h = mountHarness(receiveDmFixed);
        act(() => h.receive(textMsg('m1', 'c1')));
        h.receive(deleteMsg('nonexistent', 'c1'));
        expect(h.unpinned).toEqual([]);
        h.cleanup();
    });
});

// ── Channel shape (mirrors handleChannelMessage / handleChannelMessageSent) ─

type ChannelReceiver = (
    m: Msg,
    stateRef: React.MutableRefObject<ThreadMap>,
    setState: React.Dispatch<React.SetStateAction<ThreadMap>>,
    onUnpin: (targetId: string) => void,
) => void;

const receiveChannelBuggy: ChannelReceiver = (m, _stateRef, setState, onUnpin) => {
    let deletedRowId: string | null = null;
    setState(prev => {
        const cId = m.conversation_id;
        const thread = [...(prev[cId] || [])];
        const content = m.content as { type?: string; target_id?: string } | undefined;
        if (content?.type === 'delete') {
            const removed = thread.find(t => t.id === content.target_id);
            if (removed) deletedRowId = removed.id;
            return { ...prev, [cId]: thread.filter(t => t.id !== content.target_id) };
        }
        if (!thread.find(t => t.id === m.id)) thread.push(m);
        return { ...prev, [cId]: thread };
    });
    if (deletedRowId) onUnpin(deletedRowId);
};

const receiveChannelFixed: ChannelReceiver = (m, stateRef, setState, onUnpin) => {
    const content = m.content as { type?: string; target_id?: string } | undefined;
    const deletedRowId = content?.type === 'delete'
        ? deletedChannelTargetIds(stateRef.current[m.conversation_id] ?? [], [{ id: m.id, timestamp: m.timestamp, content }])[0] ?? null
        : null;
    setState(prev => {
        const cId = m.conversation_id;
        const thread = [...(prev[cId] || [])];
        if (content?.type === 'delete') {
            return { ...prev, [cId]: thread.filter(t => t.id !== content.target_id) };
        }
        if (!thread.find(t => t.id === m.id)) thread.push(m);
        return { ...prev, [cId]: thread };
    });
    if (deletedRowId) onUnpin(deletedRowId);
};

describe('Channel delete-unpin timing (handleChannelMessage / handleChannelMessageSent)', () => {
    it('BUGGY ordering misses the unpin once a prior render has already committed', () => {
        const h = mountHarness(receiveChannelBuggy as Receiver);
        act(() => h.receive(textMsg('m1', 'ch1')));
        h.receive(deleteMsg('m1', 'ch1'));
        expect(h.unpinned).toEqual([]);
        h.cleanup();
    });

    it('FIXED ordering (compute via deletedChannelTargetIds from the ref BEFORE setState) fires the unpin with the right id', () => {
        const h = mountHarness(receiveChannelFixed as Receiver);
        act(() => h.receive(textMsg('m1', 'ch1')));
        h.receive(deleteMsg('m1', 'ch1'));
        expect(h.unpinned).toEqual(['m1']);
        h.cleanup();
    });
});
