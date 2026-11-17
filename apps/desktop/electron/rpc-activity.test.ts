import { describe, it, expect } from 'vitest';
import { sanitizeActivity, imageRef, rpcTitle, isClientId, pidOf, gameNameKey, MAX_TIMESTAMP_SKEW_MS } from './rpc-activity';
import { rpcAppName, isKnownRpcGameName, parseAppNames, rpcAppNameCount } from './rpc-app-names';

const NOW = 1_800_000_000_000;

describe('sanitizeActivity — whitelist, caps, stripping', () => {
    const full = {
        details: 'Ranked • Round 3',
        state: 'Score 2 – 1',
        timestamps: { start: NOW - 754_000 },
        assets: { large_image: 'map_oregon', large_text: 'Oregon', small_image: 'https://cdn.example.com/rank.png', small_text: 'Gold' },
        party: { id: 'party-secret-ish', size: [2, 5] },
        instance: true,
        buttons: [{ label: 'Join', url: 'https://evil.example/' }],
        secrets: { join: 'JOIN', spectate: 'SPEC', match: 'MATCH' },
        type: 0,
        weird: { nested: true },
    };

    it('keeps exactly the whitelisted fields; buttons, secrets, party.id and unknown keys are gone', () => {
        const r = sanitizeActivity(full, NOW);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.activity).toEqual({
            name: null,
            details: 'Ranked • Round 3',
            state: 'Score 2 – 1',
            start: NOW - 754_000,
            end: null,
            party: { size: 2, max: 5 },
            assets: { largeImage: 'map_oregon', largeText: 'Oregon', smallImage: 'https://cdn.example.com/rank.png', smallText: 'Gold' },
            instance: true,
        });
        const s = JSON.stringify(r.activity);
        for (const banned of ['JOIN', 'SPEC', 'MATCH', 'evil.example', 'party-secret-ish', 'weird', 'buttons', 'secrets']) {
            expect(s).not.toContain(banned);
        }
    });

    it('null / undefined = clear', () => {
        expect(sanitizeActivity(null, NOW)).toEqual({ ok: true, activity: null });
        expect(sanitizeActivity(undefined, NOW)).toEqual({ ok: true, activity: null });
    });

    it('128 chars is accepted, 129 refused (not truncated)', () => {
        expect(sanitizeActivity({ details: 'a'.repeat(128) }, NOW)).toMatchObject({ ok: true });
        expect(sanitizeActivity({ details: 'a'.repeat(129) }, NOW)).toMatchObject({ ok: false });
        expect(sanitizeActivity({ state: 'a'.repeat(129) }, NOW)).toMatchObject({ ok: false });
    });

    it.each([
        ['details as number', { details: 5 }],
        ['state as object', { state: {} }],
        ['timestamps as string', { timestamps: 'now' }],
        ['start as string', { timestamps: { start: '1' } }],
        ['start as NaN', { timestamps: { start: NaN } }],
        ['party.size not a pair', { party: { size: [1] } }],
        ['party.size floats', { party: { size: [1.5, 4] } }],
        ['party current > max', { party: { size: [6, 5] } }],
        ['party max 0', { party: { size: [0, 0] } }],
        ['party absurdly large', { party: { size: [1, 2_000_000] } }],
        ['instance as string', { instance: 'yes' }],
        ['assets as array', { assets: [] }],
        ['activity as array', []],
        ['activity as string', 'Ranked'],
    ])('refuses %s', (_n, a) => {
        expect(sanitizeActivity(a, NOW).ok).toBe(false);
    });

    it('seconds are promoted to ms; 0 and out-of-window timestamps are dropped', () => {
        const secs = Math.floor((NOW - 60_000) / 1000);
        expect(sanitizeActivity({ timestamps: { start: secs } }, NOW)).toMatchObject({ ok: true, activity: { start: secs * 1000 } });
        expect(sanitizeActivity({ timestamps: { start: 0 } }, NOW)).toMatchObject({ ok: true, activity: { start: null } });
        expect(sanitizeActivity({ timestamps: { start: NOW - MAX_TIMESTAMP_SKEW_MS - 1 } }, NOW)).toMatchObject({ ok: true, activity: { start: null } });
        expect(sanitizeActivity({ timestamps: { end: NOW + 90_000 } }, NOW)).toMatchObject({ ok: true, activity: { end: NOW + 90_000 } });
    });

    it('control characters and bidi overrides cannot reach a one-line UI', () => {
        const r = sanitizeActivity({ details: 'a\nb‮c\u0000d' }, NOW);
        expect(r).toMatchObject({ ok: true, activity: { details: 'a b c d' } });
    });

    it('image refs: keys and https only; anything else is dropped, never refused', () => {
        expect(imageRef('map_oregon')).toBe('map_oregon');
        expect(imageRef('mp:external/abc/https/x.png')).toBe('mp:external/abc/https/x.png');
        expect(imageRef('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
        for (const bad of ['http://x.example/a.png', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@x.example/', 'data:image/png;base64,AA', 'a b', 'x'.repeat(257), 5]) {
            expect(imageRef(bad)).toBeNull();
        }
        expect(sanitizeActivity({ assets: { large_image: 'javascript:alert(1)' } }, NOW)).toEqual({ ok: true, activity: expect.objectContaining({ assets: null }) });
    });
});

describe('ids, pids, titles', () => {
    it('client ids are snowflakes', () => {
        expect(isClientId('356876590342340608')).toBe(true);
        for (const bad of ['', '123', 'abc', '3568765903423406080000', 356876590342340608]) expect(isClientId(bad)).toBe(false);
    });
    it('pid must be a positive int', () => {
        expect(pidOf(1234)).toBe(1234);
        for (const bad of [0, -1, 1.5, '1234', null, 2 ** 32]) expect(pidOf(bad)).toBeNull();
    });

    it('the bundled map names a known id (Rainbow Six Siege) and knows nothing of an unknown one', () => {
        expect(rpcAppNameCount()).toBeGreaterThan(20_000);
        expect(rpcAppName('356876590342340608')).toBe('Rainbow Six Siege');
        expect(rpcAppName('999999999999999999')).toBeNull();
        expect(isKnownRpcGameName('rainbow six siege')).toBe(true);
        expect(isKnownRpcGameName('Definitely Not A Game 12345')).toBe(false);
    });

    it('title order: map → sending process → activity name → details; never a raw id', () => {
        const appName = (id: string) => (id === '1'.repeat(18) ? 'Mapped' : null);
        const p = { clientId: '1'.repeat(18), name: 'Own name', details: 'In a match' };
        expect(rpcTitle(p, { appName })).toEqual({ title: 'Mapped', from: 'map' });
        const q = { ...p, clientId: '2'.repeat(18) };
        expect(rpcTitle(q, { appName, processGame: 'FiveM' })).toEqual({ title: 'FiveM', from: 'process' });
        expect(rpcTitle(q, { appName })).toEqual({ title: 'Own name', from: 'name' });
        expect(rpcTitle({ ...q, name: null }, { appName })).toEqual({ title: 'In a match', from: 'details' });
        expect(rpcTitle({ ...q, name: null, details: null }, { appName })).toBeNull();
    });

    it('gameNameKey ignores case, punctuation and trademark signs', () => {
        expect(gameNameKey("Tom Clancy's Rainbow Six® Siege™")).toBe(gameNameKey('tom clancys rainbow six siege'.replace('clancys', 'clancy s')));
        expect(parseAppNames('1\tA\nbad\n2\tB')).toEqual(new Map([['1', 'A'], ['2', 'B']]));
    });
});
