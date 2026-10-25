import { describe, expect, it, vi } from 'vitest';
import { CUSTOM_ARRIVAL_GRACE_MS, handleEntranceJoin, type EntranceJoinDeps } from './entranceJoin';
import { createEntranceGate, GLOBAL_GAP_MS, REJOIN_WINDOW_MS } from './entranceSoundGate';
import { isEntranceSoundId, entranceSoundUrl, renderEntranceSound } from './entranceSounds';
import { sanitizeEntry } from './callPersonalizationStore';
import type { EntrancePrefs } from './entrancePrefs';

const HEX = '0123456789abcdef0123456789abcdef';
const CUSTOM = `custom:${HEX}`;

function deps(over: { sounds?: Record<string, string | null>; prefs?: EntrancePrefs; have?: boolean } = {}) {
    let t = 100_000;
    const prefs = { current: over.prefs ?? { enabled: true, muted: [] as string[] } };
    const d = {
        getPrefs: () => prefs.current,
        personalization: vi.fn(async (u: string): Promise<{ entrance_sound: string | null }> => ({ entrance_sound: over.sounds?.[u] ?? null })),
        waitForCustom: vi.fn(async (_id: string, _ms: number): Promise<{ url: string | null; gain: number } | null> =>
            (over.have === false ? null : { url: 'blob:custom', gain: 0.7 })),
        gate: createEntranceGate(),
        now: () => t,
        playBuiltin: vi.fn((_id: string) => {}),
        playCustom: vi.fn((_url: string, _gain: number) => {}),
    } satisfies EntranceJoinDeps;
    return { d, prefs, advance: (ms: number) => { t += ms; } };
}

describe('handleEntranceJoin: custom sounds get the same protections as built-in ones', () => {
    it('plays a received custom sound with its measured gain', async () => {
        const { d } = deps({ sounds: { bob: CUSTOM } });
        expect(await handleEntranceJoin('bob', d)).toBe('played');
        expect(d.waitForCustom).toHaveBeenCalledWith(HEX, CUSTOM_ARRIVAL_GRACE_MS);
        expect(d.playCustom).toHaveBeenCalledWith('blob:custom', 0.7);
        expect(d.playBuiltin).not.toHaveBeenCalled();
    });

    it('the global switch off -> nothing, not even a fetch', async () => {
        const { d } = deps({ sounds: { bob: CUSTOM }, prefs: { enabled: false, muted: [] } });
        expect(await handleEntranceJoin('bob', d)).toBe('disabled');
        expect(d.personalization).not.toHaveBeenCalled();
        expect(d.playCustom).not.toHaveBeenCalled();
    });

    it('a per-user mute -> nothing', async () => {
        const { d } = deps({ sounds: { bob: CUSTOM }, prefs: { enabled: true, muted: ['bob'] } });
        expect(await handleEntranceJoin('bob', d)).toBe('muted');
        expect(d.playCustom).not.toHaveBeenCalled();
    });

    it('a mute or switch-off that lands while we wait for the sound still wins', async () => {
        const { d, prefs } = deps({ sounds: { bob: CUSTOM } });
        d.waitForCustom.mockImplementationOnce(async () => { prefs.current = { enabled: true, muted: ['bob'] }; return { url: 'blob:c', gain: 1 }; });
        expect(await handleEntranceJoin('bob', d)).toBe('muted');
        expect(d.playCustom).not.toHaveBeenCalled();
    });

    it('the 30 s rejoin window applies to a custom sound', async () => {
        const { d, advance } = deps({ sounds: { bob: CUSTOM } });
        expect(await handleEntranceJoin('bob', d)).toBe('played');
        advance(REJOIN_WINDOW_MS - 1);
        expect(await handleEntranceJoin('bob', d)).toBe('rejoin');
        expect(d.playCustom).toHaveBeenCalledTimes(1);
    });

    it('the 2 s global gap applies across built-in and custom sounds', async () => {
        const { d, advance } = deps({ sounds: { bob: 'bubble-pop', cat: CUSTOM, dan: CUSTOM } });
        expect(await handleEntranceJoin('bob', d)).toBe('played');
        advance(GLOBAL_GAP_MS - 1);
        expect(await handleEntranceJoin('cat', d)).toBe('busy');
        advance(1);
        expect(await handleEntranceJoin('dan', d)).toBe('played');
        expect(d.playBuiltin).toHaveBeenCalledWith('bubble-pop');
        expect(d.playCustom).toHaveBeenCalledTimes(1);
    });

    it('a custom sound that has not arrived plays nothing, and does not use up the 2 s slot', async () => {
        const { d } = deps({ sounds: { bob: CUSTOM, cat: 'sonar-ping' }, have: false });
        expect(await handleEntranceJoin('bob', d)).toBe('not-arrived');
        expect(d.playCustom).not.toHaveBeenCalled();
        expect(await handleEntranceJoin('cat', d)).toBe('played');
    });

    it('the arrival grace is measured from the join, not from when the profile read returns', async () => {
        const { d, advance } = deps({ sounds: { bob: CUSTOM } });
        d.personalization.mockImplementationOnce(async () => { advance(1_000); return { entrance_sound: CUSTOM }; });
        await handleEntranceJoin('bob', d);
        expect(d.waitForCustom).toHaveBeenCalledWith(HEX, CUSTOM_ARRIVAL_GRACE_MS - 1_000);
    });

    it('no sound, an unknown id, a failed read, or a zero gain -> nothing, never a throw', async () => {
        const { d } = deps({ sounds: { bob: null, cat: 'airhorn' } });
        expect(await handleEntranceJoin('bob', d)).toBe('none');
        expect(await handleEntranceJoin('cat', d)).toBe('unknown');
        d.personalization.mockRejectedValueOnce(new Error('offline'));
        expect(await handleEntranceJoin('dan', d)).toBe('none');
        const z = deps({ sounds: { eve: CUSTOM } });
        z.d.waitForCustom.mockResolvedValueOnce({ url: 'blob:x', gain: 0 });
        expect(await handleEntranceJoin('eve', z.d)).toBe('not-arrived');
    });
});

describe('a desktop that does not know custom ids falls back to no sound', () => {
    // What a pre-custom build does with `custom:<id>`: its sanitizer only knew
    // the catalog, its player only renders catalog recipes. Reproduced with
    // the catalog-only functions this build still ships.
    it('the catalog check rejects it, so an old sanitizer stores no sound', () => {
        expect(isEntranceSoundId(CUSTOM)).toBe(false);
        const oldSanitize = (v: unknown) => (isEntranceSoundId(v) ? v : null);
        expect(oldSanitize(CUSTOM)).toBeNull();
    });

    it('the built-in player renders nothing for it and does not throw', () => {
        expect(renderEntranceSound(CUSTOM)).toBeNull();
        expect(() => entranceSoundUrl(CUSTOM)).not.toThrow();
        expect(entranceSoundUrl(CUSTOM)).toBeNull();
    });

    it('this build keeps a well-formed custom value and drops a malformed one', () => {
        expect(sanitizeEntry({ entrance_sound: CUSTOM }).entrance_sound).toBe(CUSTOM);
        expect(sanitizeEntry({ entrance_sound: 'custom:XYZ' }).entrance_sound).toBeNull();
        expect(sanitizeEntry({ entrance_sound: `custom:${HEX.toUpperCase()}` }).entrance_sound).toBeNull();
    });
});
