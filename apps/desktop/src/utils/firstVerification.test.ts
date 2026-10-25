// @vitest-environment jsdom
/**
 * The first-verification ceremony, through the REAL commit point
 * (keyVerification.markVerified): it is requested exactly once per account, only
 * for a first, after the modal's own animation, from every route; it finishes the
 * hint; and the commit point is wired to the hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    return {
        map,
        readyUserId: null as string | null,
        getItem: vi.fn((k: string) => map.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { map.set(k, v); }),
        keysWithPrefix: vi.fn((p: string) => [...map.keys()].filter(k => k.startsWith(p))),
        isAccountReady: vi.fn((uid: string) => !!uid && store.readyUserId === uid),
    };
});
vi.mock('./secureLocalStore', () => ({ secureLocalStore: store, default: store }));

import {
    CEREMONY_DELAY_MS, FIRST_VERIFY_PLAYED_PREFIX, firstVerifyPlayed, noteContactVerified,
} from './firstVerification';
import { markVerified, hasVerifiedAnyone, acknowledgeKeyChange } from './keyVerification';
import { SAFETY_HINT_DONE_PREFIX, isHintDone, subscribeHintDone } from './safetyVerifyHint';
import { CEREMONY_EVENT } from './moments';
import { classifyKvKey } from '../services/backupRegistry';

const ME = 'me-user';
const THEM = 'them-user';
const OTHER = 'other-user';
let heard: Array<{ id?: string; peer?: string }>;
const onCeremony = (e: Event) => { heard.push((e as CustomEvent).detail); };

beforeEach(() => {
    vi.useFakeTimers();
    store.map.clear();
    store.readyUserId = ME;
    heard = [];
    window.addEventListener(CEREMONY_EVENT, onCeremony);
});
afterEach(() => {
    window.removeEventListener(CEREMONY_EVENT, onCeremony);
    vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTime(CEREMONY_DELAY_MS + 10);

describe('the first verification plays the ceremony once per account', () => {
    it('markVerified for the very first contact requests it, with the contact’s name, after the modal’s own animation', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        expect(heard).toEqual([]);                          // not yet: the modal’s seal (~1.2 s) finishes first
        vi.advanceTimersByTime(CEREMONY_DELAY_MS - 1);
        expect(heard).toEqual([]);
        vi.advanceTimersByTime(2);
        expect(heard).toEqual([{ id: 'safety-verified', peer: 'Mara' }]);
    });

    it('the ceremony waits long enough for the modal’s seal (SEAL_ANIM_MS 1.2 s, ALLCLEAR 1.4 s)', () => {
        expect(CEREMONY_DELAY_MS).toBeGreaterThanOrEqual(1400);
    });

    it('verifying a second contact does not play it again', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        markVerified(ME, OTHER, 'pubB', 'dev-b', 'Jin');
        flush();
        expect(heard).toHaveLength(1);
    });

    it('Quick verify marks every device of the contact in a loop: still ONE ceremony', () => {
        for (const d of ['dev-1', 'dev-2', 'dev-3']) markVerified(ME, THEM, `pub-${d}`, d, 'Mara');
        flush();
        expect(heard).toHaveLength(1);
    });

    it('re-marking the same device (a double click, a legacy refresh) is not a second', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toHaveLength(1);
    });

    it('is per account: another account’s first verification plays its own', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        store.readyUserId = 'me-2';
        markVerified('me-2', THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toHaveLength(2);
    });

    it('works with no name (the embed or a caller without one): the ceremony still asks', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a');
        flush();
        expect(heard).toEqual([{ id: 'safety-verified' }]);
    });

    it('persists the played flag per account in the secure store, before anything is scheduled', () => {
        expect(firstVerifyPlayed(ME)).toBe(false);
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        expect(store.map.get(FIRST_VERIFY_PLAYED_PREFIX + ME)).toBe('1');   // already, at t=0
        expect(firstVerifyPlayed(ME)).toBe(true);
    });

    it('a reload (new module state, same store) does not replay it', () => {
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        heard.length = 0;
        markVerified(ME, OTHER, 'pubB', 'dev-b', 'Jin');   // e.g. next session
        flush();
        expect(heard).toEqual([]);
    });

    it('someone verified BEFORE this feature existed: this is not their first, so nothing plays (and the flag is spent)', () => {
        store.map.set(`kv_verify_v2_${ME}_${OTHER}`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: true, first_seen: 1, last_seen: 1 } } }));
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toEqual([]);
        expect(firstVerifyPlayed(ME)).toBe(true);
    });

    it('a pre-v2 (v1) verification counts as having verified someone', () => {
        store.map.set(`kv_verify_${ME}_${OTHER}`, JSON.stringify({ pub: 'p', verified: true }));
        expect(hasVerifiedAnyone(ME)).toBe(true);
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toEqual([]);
    });

    it('seen-but-unverified contacts and key-change resets do not count as verified', () => {
        store.map.set(`kv_verify_v2_${ME}_${OTHER}`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: false, first_seen: 1, last_seen: 1 } } }));
        expect(hasVerifiedAnyone(ME)).toBe(false);
        acknowledgeKeyChange(ME, OTHER, 'p2', 'd');
        expect(hasVerifiedAnyone(ME)).toBe(false);
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toHaveLength(1);
    });

    it('another account’s verifications are not mine', () => {
        store.map.set(`kv_verify_v2_someone-else_${OTHER}`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: true, first_seen: 1, last_seen: 1 } } }));
        expect(hasVerifiedAnyone(ME)).toBe(false);
    });

    it('the account’s records not loaded yet: nothing plays and nothing is spent', () => {
        store.readyUserId = null;
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        flush();
        expect(heard).toEqual([]);
        expect(store.map.has(FIRST_VERIFY_PLAYED_PREFIX + ME)).toBe(false);
    });

    it('the verification itself is untouched by all of this: the pin is written even when the hook cannot run', () => {
        store.keysWithPrefix.mockImplementationOnce(() => { throw new Error('no enumeration'); });
        expect(() => markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara')).not.toThrow();
        const pins = JSON.parse(store.map.get(`kv_verify_v2_${ME}_${THEM}`)!);
        expect(pins.devices['dev-a'].verified).toBe(true);
        flush();
        expect(heard).toEqual([]);   // unknown history counts as "not a first"
    });

    it('noteContactVerified reports what it did', () => {
        expect(noteContactVerified({ myUserId: ME, peerName: 'Mara', hadVerifiedBefore: false })).toBe('scheduled');
        expect(noteContactVerified({ myUserId: ME, peerName: 'Mara', hadVerifiedBefore: false })).toBe('already-played');
        store.readyUserId = null;
        expect(noteContactVerified({ myUserId: ME, hadVerifiedBefore: false })).toBe('not-ready');
        store.readyUserId = 'u9';
        expect(noteContactVerified({ myUserId: 'u9', hadVerifiedBefore: true })).toBe('not-first');
    });
});

describe('verifying anyone, by any route, finishes the one-time hint', () => {
    it('even when it is not a first (the ceremony already played)', () => {
        const heardWhy: string[] = [];
        const off = subscribeHintDone(r => heardWhy.push(r));
        markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara');
        expect(isHintDone(ME)).toBe(true);
        expect(store.map.get(SAFETY_HINT_DONE_PREFIX + ME)).toBe('1');
        expect(heardWhy).toEqual(['verified']);
        off();
    });
    it('the hint ends for someone who verified before the feature existed too', () => {
        store.map.set(`kv_verify_v2_${ME}_${OTHER}`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: true, first_seen: 1, last_seen: 1 } } }));
        markVerified(ME, THEM, 'pubA', 'dev-a');
        expect(isHintDone(ME)).toBe(true);
    });
});

describe('backups', () => {
    it('the played flag is classified and excluded (a one-time UI marker; pins never restore)', () => {
        expect(classifyKvKey(FIRST_VERIFY_PLAYED_PREFIX + ME, ME)).toBe('exclude');
    });
});

describe('wiring: the verification commit point calls the hook', () => {
    const SRC = join(__dirname, '..');
    const read = (f: string) => readFileSync(join(SRC, f), 'utf8');
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('markVerified writes the pin, THEN calls noteContactVerified, never throwing out of it', () => {
        const src = stripComments(read('utils/keyVerification.ts'));
        const fn = src.slice(src.indexOf('export function markVerified('), src.indexOf('export function hasVerifiedAnyone('));
        const write = fn.indexOf('writeStore(myUserId, theirUserId, store);');
        const hook = fn.indexOf('noteContactVerified(');
        expect(write).toBeGreaterThan(-1);
        expect(hook).toBeGreaterThan(write);
        expect(fn).toMatch(/try \{ noteContactVerified\([^)]*\); \} catch/);
        // "had anyone been verified" is read BEFORE the pin is written.
        expect(fn.indexOf('hasVerifiedAnyone(myUserId)')).toBeGreaterThan(-1);
        expect(fn.indexOf('hasVerifiedAnyone(myUserId)')).toBeLessThan(write);
        expect(src).toMatch(/import \{ noteContactVerified \} from '\.\/firstVerification';/);
    });

    it('is the ONLY place a pin is written as verified (so no route can skip the hook)', () => {
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const f of readdirSync(dir)) {
                const p = join(dir, f);
                if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
                if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
                if (/\bverified:\s*true\b/.test(stripComments(readFileSync(p, 'utf8')))) hits.push(p.slice(SRC.length + 1));
            }
        };
        walk(SRC);
        expect(hits).toEqual(['utils/keyVerification.ts']);
    });

    it('all three callers go through markVerified, and hand it the contact’s name', () => {
        const modal = stripComments(read('components/SafetyVerificationModal.tsx'));
        expect(modal.match(/markVerified\(myUserId, remoteUserId, [^)]*remoteUsername\)/g)).toHaveLength(2);
        const embed = stripComments(read('components/SafetyNumberEmbed.tsx'));
        expect(embed).toMatch(/markVerified\(myUserId, senderUserId, pub, device_id, senderName\)/);
    });

    it('the hook finishes the hint and requests the guaranteed ceremony - not an ordinary, rate-limited moment', () => {
        const src = stripComments(read('utils/firstVerification.ts'));
        expect(src).toMatch(/markHintDone\(c\.myUserId, 'verified'\)/);
        expect(src).toMatch(/requestCeremony\('safety-verified'/);
        expect(src).not.toMatch(/requestMoment\(/);
        expect(src).not.toMatch(/recordEggFound|EGG_LEDGER_KEY|claimMoment/);
    });
});
