import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The persistent flag lives in secureLocalStore; stand it in with a Map and a
// controllable "this account's records are loaded" switch.
const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    return {
        map,
        readyUserId: null as string | null,
        getItem: vi.fn((k: string) => map.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { map.set(k, v); }),
        isAccountReady: vi.fn((uid: string) => !!uid && store.readyUserId === uid),
    };
});
vi.mock('./secureLocalStore', () => ({ secureLocalStore: store, default: store }));

import { FullscreenHintGate, accountHintSeenStore, type HintSeenStore } from './shareFullscreenHint';
import type { ForegroundDiag } from './foregroundInfo';
import { classifyKvKey } from '../services/backupRegistry';

const GAME: ForegroundDiag = {
    state: 'QUNS_RUNNING_D3D_FULL_SCREEN', exe: 'game.exe', covers: true, isCipherline: false, onSharedScreen: true,
};
const KEY = (uid: string) => `cipherline_share_window_hint_seen_${uid}`;

function signIn(uid: string, ready = true) {
    store.map.set('cipherline_user_id', uid);
    store.readyUserId = ready ? uid : null;
}

beforeEach(() => {
    store.map.clear();
    store.readyUserId = null;
    store.getItem.mockClear();
    store.setItem.mockClear();
    store.isAccountReady.mockClear();
});

describe('the hint is shown ONCE EVER per account', () => {
    it('shown on the first qualifying share, and never again on later shares or after a reload', () => {
        signIn('u1');
        const onHint = vi.fn();
        // share 1
        const gate1 = new FullscreenHintGate({ onHint, seen: accountHintSeenStore });
        expect(gate1.observe(GAME, 'screen')).toMatchObject({ show: true, reason: 'show', exe: 'game.exe' });
        expect(gate1.observe(GAME, 'screen').show).toBe(false);
        // share 2, same session: a brand new gate (the share ended and the ref was dropped)
        const gate2 = new FullscreenHintGate({ onHint, seen: accountHintSeenStore });
        expect(gate2.observe(GAME, 'screen')).toMatchObject({ show: false, reason: 'seen_before' });
        // "reload": the in-memory gate is gone, only the persisted record remains
        const gate3 = new FullscreenHintGate({ onHint, seen: accountHintSeenStore });
        expect(gate3.observe(GAME, 'screen')).toMatchObject({ show: false, reason: 'seen_before' });
        expect(onHint).toHaveBeenCalledTimes(1);
    });

    it('the flag is set when the hint is shown - before the toast is raised - whether or not it is accepted', () => {
        signIn('u1');
        const order: string[] = [];
        const seen: HintSeenStore = {
            ready: () => true, seen: () => false, markSeen: () => { order.push('mark'); },
        };
        new FullscreenHintGate({ onHint: () => order.push('toast'), seen }).observe(GAME, 'screen');
        expect(order).toEqual(['mark', 'toast']);

        // With the real adapter: written under the per-account key, value "1", at show time
        // (no accept/dismiss callback is involved at all).
        new FullscreenHintGate({ onHint: () => {}, seen: accountHintSeenStore }).observe(GAME, 'screen');
        expect(store.setItem).toHaveBeenCalledTimes(1);
        expect(store.setItem).toHaveBeenCalledWith(KEY('u1'), '1');
        expect(store.map.get(KEY('u1'))).toBe('1');
    });

    it('is per ACCOUNT: another account on the same device still gets its one showing', () => {
        signIn('u1');
        const onHint = vi.fn();
        new FullscreenHintGate({ onHint, seen: accountHintSeenStore }).observe(GAME, 'screen');
        signIn('u2');
        expect(new FullscreenHintGate({ onHint, seen: accountHintSeenStore }).observe(GAME, 'screen').show).toBe(true);
        expect(store.map.has(KEY('u1'))).toBe(true);
        expect(store.map.has(KEY('u2'))).toBe(true);
        expect(onHint).toHaveBeenCalledTimes(2);
    });

    it('NOT shown while the store is not ready (cold namespace after a sign-in): nothing is read as "unseen", nothing is written', () => {
        signIn('u1', false);
        const onHint = vi.fn();
        const gate = new FullscreenHintGate({ onHint, seen: accountHintSeenStore });
        expect(gate.observe(GAME, 'screen')).toMatchObject({ show: false, reason: 'store_not_ready' });
        expect(onHint).not.toHaveBeenCalled();
        expect(store.setItem).not.toHaveBeenCalled();
        // The flag itself was never read before the account was ready.
        expect(store.getItem).not.toHaveBeenCalledWith(KEY('u1'));
        expect(gate.shown).toBe(false);
        // ...and once the account is ready, the same gate shows it on a later sample.
        store.readyUserId = 'u1';
        expect(gate.observe(GAME, 'screen').show).toBe(true);
        expect(onHint).toHaveBeenCalledTimes(1);
    });

    it('NOT shown when nobody is signed in (no active account id)', () => {
        const onHint = vi.fn();
        expect(new FullscreenHintGate({ onHint, seen: accountHintSeenStore }).observe(GAME, 'screen').show).toBe(false);
        expect(onHint).not.toHaveBeenCalled();
        expect(store.setItem).not.toHaveBeenCalled();
    });

    it('a sample that would not show anyway never touches the store (no reads on the 10 s sampler path)', () => {
        signIn('u1');
        const gate = new FullscreenHintGate({ onHint: () => {}, seen: accountHintSeenStore });
        gate.observe({ ...GAME, isCipherline: true }, 'screen');
        gate.observe(GAME, 'window');
        gate.observe(null, 'screen');
        expect(store.getItem).not.toHaveBeenCalledWith(KEY('u1'));
        expect(store.isAccountReady).not.toHaveBeenCalled();
    });

    it('negative control: without a persistent store it is still once per SHARE only (the old behaviour)', () => {
        const onHint = vi.fn();
        new FullscreenHintGate({ onHint }).observe(GAME, 'screen');
        new FullscreenHintGate({ onHint }).observe(GAME, 'screen');
        expect(onHint).toHaveBeenCalledTimes(2);
    });
});

describe('the flag is stored the way this repo stores things', () => {
    it('goes through secureLocalStore only - the hint util never touches raw localStorage', () => {
        const text = fs.readFileSync(path.resolve(__dirname, 'shareFullscreenHint.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(text).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/);
        expect(text).toContain('secureLocalStore.setItem(SHARE_WINDOW_HINT_SEEN_PREFIX + uid');
    });

    it('is classified in backupRegistry as EXCLUDED (a per-device UI nicety), for any account id', () => {
        expect(classifyKvKey('cipherline_share_window_hint_seen_u1', 'u1')).toBe('exclude');
        expect(classifyKvKey('cipherline_share_window_hint_seen_8f3c1e52-aaaa-bbbb-cccc-123456789abc', '8f3c1e52-aaaa-bbbb-cccc-123456789abc')).toBe('exclude');
        // positive control: the classifier does say 'unknown' for an unregistered sibling key
        expect(classifyKvKey('cipherline_share_window_hint_other_u1', 'u1')).toBe('unknown');
    });
});
