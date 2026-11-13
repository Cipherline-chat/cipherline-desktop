// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ data: new Map<string, string>() }));
vi.mock('../secureLocalStore', () => {
    const api = {
        getItem: (k: string) => h.data.get(k) ?? null,
        setItem: (k: string, v: string) => { h.data.set(k, v); },
        isAccountReady: () => true,
        whenAccountReady: () => Promise.resolve(),
    };
    return { default: api, secureLocalStore: api };
});

import { BACKUP_RESTORED_EVENT, classifyKvKey } from '../../services/backupRegistry';
import { getListeningPrefs, listeningBrowserKey, listeningShareKey, listeningWatchingKey } from './listeningPrefs';

describe('listening settings and backups', () => {
    it('a live restore shows the restored switches without a restart', () => {
        expect(getListeningPrefs('u1').share).toBe(false);
        h.data.set(listeningShareKey('u1'), '1');
        expect(getListeningPrefs('u1').share).toBe(false); // the parsed copy, until told
        window.dispatchEvent(new Event(BACKUP_RESTORED_EVENT));
        expect(getListeningPrefs('u1').share).toBe(true);
    });

    it('all of them are in a backup, and another account\'s are not', () => {
        for (const k of [listeningShareKey('u1'), listeningBrowserKey('u1'), listeningWatchingKey('u1'), 'cipherline_listening_asked_u1']) {
            expect(classifyKvKey(k, 'u1')).toBe('include');
            expect(classifyKvKey(k, 'someone-else')).not.toBe('include');
        }
    });
});
