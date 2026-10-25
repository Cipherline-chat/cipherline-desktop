import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRANCE_PREFS, MAX_MUTED, parseEntrancePrefs, withMuted } from './entrancePrefs';

describe('entrance prefs', () => {
    it('defaults to on with nobody muted', () => {
        expect(parseEntrancePrefs(null)).toEqual({ enabled: true, muted: [] });
        expect(DEFAULT_ENTRANCE_PREFS.enabled).toBe(true);
    });

    it('reads a stored value and survives garbage', () => {
        expect(parseEntrancePrefs('{"enabled":false,"muted":["a","b"]}')).toEqual({ enabled: false, muted: ['a', 'b'] });
        expect(parseEntrancePrefs('not json')).toEqual(DEFAULT_ENTRANCE_PREFS);
        expect(parseEntrancePrefs('{"enabled":"yes","muted":[1,null,"ok","ok",""]}')).toEqual({ enabled: true, muted: ['ok'] });
        expect(parseEntrancePrefs('{"muted":"a"}').muted).toEqual([]);
    });

    it('caps the muted list', () => {
        const many = JSON.stringify({ muted: Array.from({ length: MAX_MUTED + 50 }, (_, i) => `u${i}`) });
        expect(parseEntrancePrefs(many).muted.length).toBe(MAX_MUTED);
    });

    it('per-user mute: adds, removes, and is idempotent', () => {
        const base = { enabled: true, muted: [] as string[] };
        const m = withMuted(base, 'a', true);
        expect(m.muted).toEqual(['a']);
        expect(withMuted(m, 'a', true)).toBe(m); // no change, same object
        expect(withMuted(m, 'b', true).muted).toEqual(['a', 'b']);
        expect(withMuted(m, 'a', false).muted).toEqual([]);
        expect(withMuted(base, 'a', false)).toBe(base);
    });

    it('muting does not touch the global switch', () => {
        expect(withMuted({ enabled: false, muted: [] }, 'a', true).enabled).toBe(false);
    });
});
