// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

import { useRetentionPolicy, type StoragePolicy } from './useRetentionPolicy';
import { useRetentionCoverageShrink } from './useRetentionCoverageShrink';
import {
    historyGaps, reachesHistoryStart, shrinkToCached, type ChannelCoverage,
} from '../utils/channelHistoryCoverage';
import { retentionWindowsKey } from '../utils/rowSaveState';

/**
 * "Save for me still makes the chat jump; Save to server and Pin don't" (owner,
 * 0.1.2-staging.247). A personal save rebuilds the retention policy, and
 * Dashboard re-ran the "a widened window may bring back dropped rows" coverage
 * shrink on EVERY policy change. That pulled a fully loaded channel off its
 * first message: "This is the beginning of #channel" turned into an "older
 * history" gap row above the first message and, the feed having
 * `overflow-anchor: none`, every row on screen moved 29 px
 * (harness/save-no-jump-check.mjs --ret=1mo --loadall=1). The shrink now keys
 * on the retention WINDOWS only.
 */

const ROWS = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`,
    timestamp: new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString(),
}));
const FULL: ChannelCoverage = [{ lo: null, hi: null }];

type Shrinker = (
    policy: StoragePolicy, v: string,
    set: React.Dispatch<React.SetStateAction<Record<string, ChannelCoverage>>>,
    ref: React.MutableRefObject<Record<string, typeof ROWS>>,
) => void;

/** The pre-fix effect, verbatim in substance: keyed on the policy OBJECT. */
const usePreFixShrink: Shrinker = (policy, v, set, ref) => {
    useEffect(() => {
        set(cov => {
            let changed = false;
            const next: Record<string, ChannelCoverage> = {};
            for (const [cid, segs] of Object.entries(cov)) {
                next[cid] = shrinkToCached(segs, ref.current[cid] ?? []);
                if (next[cid] !== segs) changed = true;
            }
            return changed ? next : cov;
        });
    }, [policy, v, set, ref]);
};

type R = ReturnType<typeof useRetentionPolicy>;
let retention: R | null = null;
let coverage: Record<string, ChannelCoverage> = {};
let setCoverage: React.Dispatch<React.SetStateAction<Record<string, ChannelCoverage>>> = () => {};
let root: Root | null = null;

/** Dashboard's wiring: the raw retention hook, channel coverage state, the cached rows ref. */
const makeProbe = (useShrink: Shrinker): React.FC => function Probe() {
    const r = useRetentionPolicy('me');
    const [cov, setCov] = useState<Record<string, ChannelCoverage>>({});
    const rowsRef = useRef<Record<string, typeof ROWS>>({ c1: ROWS });
    useShrink(r.policy, '0:0', setCov, rowsRef);
    // The first newest-page read, after mount: the whole channel is loaded.
    useEffect(() => { setCov({ c1: FULL }); }, []);
    retention = r;
    coverage = cov;
    setCoverage = setCov;
    return null;
};

const PreFixProbe = makeProbe(usePreFixShrink);
const FixedProbe = makeProbe(useRetentionCoverageShrink);

async function mount(Probe: React.FC) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => { root!.render(React.createElement(Probe)); });
}

const startShown = () => reachesHistoryStart(coverage.c1) && historyGaps(coverage.c1, ROWS).length === 0;

beforeEach(() => {
    store.clear();
    store.set('cipherline_storage_policy_me', JSON.stringify({ messageRetention: '1mo', attachmentRetention: '1mo' }));
    retention = null;
    coverage = {};
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
});

describe('useRetentionCoverageShrink — a personal save never un-covers a loaded channel', () => {
    it('positive control: the pre-fix effect DOES drop the channel start on Save for me', async () => {
        await mount(PreFixProbe);
        // (It already did once at mount — the hook's own policy reload is a new
        // object too. Re-prove the whole channel, as the gap fill would.)
        await act(async () => { setCoverage({ c1: FULL }); });
        expect(startShown()).toBe(true);
        await act(async () => { retention!.saveMessage('m5'); });
        expect(startShown()).toBe(false);
        expect(historyGaps(coverage.c1, ROWS).map(g => g.beforeRowId)).toEqual(['m0']);
    });

    it('mounting (the policy loads from storage) does not un-cover it either', async () => {
        await mount(FixedProbe);
        expect(startShown()).toBe(true);
    });

    it('Save for me / Remove from my saves (messages and attachments) leave coverage untouched', async () => {
        await mount(FixedProbe);
        const before = coverage.c1;
        expect(startShown()).toBe(true);
        await act(async () => { retention!.saveMessage('m5'); });
        await act(async () => { retention!.unsaveMessage('m5'); });
        await act(async () => { retention!.saveAttachment('att-1'); });
        await act(async () => { retention!.unsaveAttachment('att-1'); });
        expect(coverage.c1).toBe(before);
        expect(startShown()).toBe(true);
    });

    it('a changed retention window still shrinks coverage (rows dropped at the door become a gap)', async () => {
        await mount(FixedProbe);
        expect(startShown()).toBe(true);
        await act(async () => { retention!.setMessageRetention('1y'); });
        expect(startShown()).toBe(false);
        expect(historyGaps(coverage.c1, ROWS).map(g => g.beforeRowId)).toEqual(['m0']);
    });

    it('a per-type default change counts as a window change too', async () => {
        await mount(FixedProbe);
        await act(async () => { retention!.setServerMessageRetention('6mo'); });
        expect(startShown()).toBe(false);
    });
});

describe('retentionWindowsKey', () => {
    const base: StoragePolicy = {
        attachmentRetention: '24h', messageRetention: '1mo',
        savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
        unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
    };
    it('ignores every per-id list', () => {
        expect(retentionWindowsKey({
            ...base, savedMessageIds: ['a'], unsavedMessageIds: ['b'], savedAttachmentIds: ['c'],
            unsavedAttachmentIds: ['d'], unsavedMessageTimestamps: { b: 1 }, unsavedAttachmentTimestamps: { d: 2 },
        })).toBe(retentionWindowsKey(base));
    });
    it('changes with any window, global or per type', () => {
        const k = retentionWindowsKey(base);
        expect(retentionWindowsKey({ ...base, messageRetention: '1y' })).not.toBe(k);
        expect(retentionWindowsKey({ ...base, attachmentRetention: '1wk' })).not.toBe(k);
        expect(retentionWindowsKey({ ...base, dmMessageRetention: '1wk' })).not.toBe(k);
        expect(retentionWindowsKey({ ...base, serverAttachmentRetention: 'never' })).not.toBe(k);
    });
});

describe('Dashboard wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    it('the coverage shrink runs through the windows-keyed hook, never inline on the policy', () => {
        expect(src).toMatch(/useRetentionCoverageShrink\(retention\.policy, `\$\{channelRetentionVersion\}:\$\{convRetentionVersion\}`, setChannelCoverage, channelMessagesRef\);/);
        expect(src).not.toMatch(/shrinkToCached\(/);
    });
});
