import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The first-run "storage on this device" decision and its persistence.
 * secureLocalStore is an in-memory Map; `ready` models the per-account
 * hydration gate (isAccountReady).
 */
const mem = new Map<string, string>();
let ready = true;
let refuseWrites = false;
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { if (!refuseWrites) mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => ready && u === U,
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const {
    decideDeviceStorageSetup, policyHasRetentionChoice, buildPolicyFromChoice,
    saveDeviceStorageChoice, markDeviceStorageSetupDone, readDeviceStorageDecision,
    RECOMMENDED_RETENTION, STORAGE_POLICY_CHANGED_EVENT, deviceStorageSetupKey, storagePolicyKey,
} = await import('./deviceStorageSetup');

const U = 'user-dss';
const MARKER = JSON.stringify({ v: 1, at: 1, how: 'chosen' });
const FULL_POLICY = JSON.stringify({ attachmentRetention: '24h', messageRetention: 'never', savedMessageIds: [] });
const SAVES_ONLY = JSON.stringify({ savedMessageIds: ['m1'], savedAttachmentIds: [] });

beforeEach(() => {
    mem.clear();
    ready = true;
    refuseWrites = false;
});

describe('decideDeviceStorageSetup — decision table', () => {
    // marker × policy-state. Marker wins outright; otherwise only a policy that
    // actually carries a retention field counts as "this device has chosen".
    const cases: [string, string | null, string | null, 'done' | 'adopt-existing' | 'prompt'][] = [
        ['fresh device: nothing stored',                          null,   null,          'prompt'],
        ['existing install: full policy, no marker',              null,   FULL_POLICY,   'adopt-existing'],
        ['restore wrote saved ids only (no retention field)',     null,   SAVES_ONLY,    'prompt'],
        ['corrupt policy JSON',                                   null,   '{nope',       'prompt'],
        ['policy is JSON but not an object',                      null,   '[1,2]',       'prompt'],
        ['policy is an empty object',                             null,   '{}',          'prompt'],
        ['policy with only a per-type field',                     null,   '{"dmMessageRetention":"1y"}', 'adopt-existing'],
        ['retention field present but not a string',              null,   '{"messageRetention":7}',      'prompt'],
        ['marker present, nothing else',                          MARKER, null,          'done'],
        ['marker present, full policy',                           MARKER, FULL_POLICY,   'done'],
        ['marker present, saves-only policy',                     MARKER, SAVES_ONLY,    'done'],
        ['empty-string marker is not a marker',                   '',     null,          'prompt'],
    ];
    it.each(cases)('%s', (_name, marker, policy, want) => {
        expect(decideDeviceStorageSetup(marker, policy)).toBe(want);
    });

    it('policyHasRetentionChoice ignores undefined/null input', () => {
        expect(policyHasRetentionChoice(undefined)).toBe(false);
        expect(policyHasRetentionChoice(null)).toBe(false);
    });
});

describe('readDeviceStorageDecision reads THIS account’s keys', () => {
    it('prompts a fresh account, adopts an existing policy, respects the marker', () => {
        expect(readDeviceStorageDecision(U)).toBe('prompt');
        mem.set(storagePolicyKey(U), FULL_POLICY);
        expect(readDeviceStorageDecision(U)).toBe('adopt-existing');
        markDeviceStorageSetupDone(U, 'existing-install');
        expect(readDeviceStorageDecision(U)).toBe('done');
    });

    it('another account’s marker does not count', () => {
        markDeviceStorageSetupDone('someone-else', 'chosen');
        expect(readDeviceStorageDecision(U)).toBe('prompt');
    });
});

describe('buildPolicyFromChoice', () => {
    it('writes the six per-type choices with global fallbacks of never (signup shape)', () => {
        const p = buildPolicyFromChoice(null, { ...RECOMMENDED_RETENTION });
        expect(p.messageRetention).toBe('never');
        expect(p.attachmentRetention).toBe('never');
        expect(p.dmMessageRetention).toBe('1y');
        expect(p.dmAttachmentRetention).toBe('1mo');
        expect(p.serverAttachmentRetention).toBe('1wk');
        expect(p.savedMessageIds).toEqual([]);
    });

    it('keeps saved / unsaved ids already on the device (e.g. restored saves)', () => {
        const existing = JSON.stringify({
            savedMessageIds: ['keep-me'], savedAttachmentIds: ['att-1'],
            unsavedMessageIds: ['u1'], unsavedMessageTimestamps: { u1: 5 },
            messageRetention: '1wk',
        });
        const p = buildPolicyFromChoice(existing, { ...RECOMMENDED_RETENTION, dmMessageRetention: 'never' });
        expect(p.savedMessageIds).toEqual(['keep-me']);
        expect(p.savedAttachmentIds).toEqual(['att-1']);
        expect(p.unsavedMessageIds).toEqual(['u1']);
        expect(p.unsavedMessageTimestamps).toEqual({ u1: 5 });
        // Old windows are replaced by the choice, not merged.
        expect(p.messageRetention).toBe('never');
        expect(p.dmMessageRetention).toBe('never');
    });

    it('survives a corrupt existing record', () => {
        expect(buildPolicyFromChoice('{bad', { ...RECOMMENDED_RETENTION }).savedMessageIds).toEqual([]);
    });
});

describe('saveDeviceStorageChoice', () => {
    it('writes policy + marker and notifies the live retention hook', () => {
        // The node test env's window is a stub without an event bus — capture
        // what gets dispatched instead.
        const heard: unknown[] = [];
        const w = window as unknown as { dispatchEvent?: (e: Event) => boolean };
        const orig = w.dispatchEvent;
        w.dispatchEvent = (e: Event) => {
            if (e.type === STORAGE_POLICY_CHANGED_EVENT) heard.push((e as CustomEvent).detail);
            return true;
        };
        try {
            saveDeviceStorageChoice(U, { ...RECOMMENDED_RETENTION }, 'recommended');
        } finally {
            w.dispatchEvent = orig;
        }
        expect(JSON.parse(mem.get(storagePolicyKey(U))!).groupMessageRetention).toBe('6mo');
        const marker = JSON.parse(mem.get(deviceStorageSetupKey(U))!);
        expect(marker).toMatchObject({ v: 1, how: 'recommended' });
        expect(readDeviceStorageDecision(U)).toBe('done');
        expect(heard).toEqual([{ userId: U }]);
    });

    it('refuses to write into a cold (not yet hydrated) account namespace', () => {
        ready = false;
        expect(() => saveDeviceStorageChoice(U, { ...RECOMMENDED_RETENTION }, 'chosen')).toThrow(/loading/);
        expect(mem.size).toBe(0);
    });

    it('throws — and writes NO marker — when the store silently drops the write (locked)', () => {
        refuseWrites = true;
        expect(() => saveDeviceStorageChoice(U, { ...RECOMMENDED_RETENTION }, 'chosen')).toThrow(/secure storage/);
        refuseWrites = false;
        expect(mem.has(deviceStorageSetupKey(U))).toBe(false);
        expect(readDeviceStorageDecision(U)).toBe('prompt');
    });
});
