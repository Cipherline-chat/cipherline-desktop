import { describe, it, expect } from 'vitest';
import {
    NO_CALL_MEDIA,
    hasAnyCallMedia,
    readCallMediaByUser,
    readCallMediaState,
} from '@cipherline/shared';

/**
 * The shared out-of-call media readers (packages/shared/call-media.ts), now
 * carrying self mute / deafen next to camera / screen share. They sit on the
 * wire boundary, so they are strict about types and silent about absence.
 */

const st = (o: Record<string, boolean> = {}) =>
    ({ camera: false, screen_share: false, muted: false, deafened: false, ...o });

describe('readCallMediaState', () => {
    it('reads all four flags', () => {
        expect(readCallMediaState({ camera: true, screen_share: true, muted: true, deafened: true }))
            .toEqual(st({ camera: true, screen_share: true, muted: true, deafened: true }));
    });

    it('an older sender (no muted / deafened) reads as not muted / not deafened', () => {
        expect(readCallMediaState({ camera: true, screen_share: false })).toEqual(st({ camera: true }));
    });

    it('is strict: only literal `true` counts (no truthy coercion)', () => {
        const r = readCallMediaState({ camera: 1, screen_share: 'true', muted: 'yes', deafened: {} });
        expect(r).toEqual(st());
        expect(readCallMediaState({ muted: 1 }).muted).toBe(false);
        expect(readCallMediaState({ deafened: 'true' }).deafened).toBe(false);
    });

    it.each([[null], [undefined], ['cs'], [42], [true]])('reads %s as nothing on', (raw) => {
        expect(readCallMediaState(raw)).toEqual(st());
    });

    it('returns a fresh object, never the frozen NO_CALL_MEDIA', () => {
        expect(readCallMediaState(null)).not.toBe(NO_CALL_MEDIA);
    });
});

describe('hasAnyCallMedia', () => {
    it('is true for any one of the four flags, muted-only and deafened-only included', () => {
        expect(hasAnyCallMedia(st({ camera: true }))).toBe(true);
        expect(hasAnyCallMedia(st({ screen_share: true }))).toBe(true);
        expect(hasAnyCallMedia(st({ muted: true }))).toBe(true);
        expect(hasAnyCallMedia(st({ deafened: true }))).toBe(true);
    });
    it('is false when everything is off, and for null / undefined', () => {
        expect(hasAnyCallMedia(st())).toBe(false);
        expect(hasAnyCallMedia(NO_CALL_MEDIA)).toBe(false);
        expect(hasAnyCallMedia(null)).toBe(false);
        expect(hasAnyCallMedia(undefined)).toBe(false);
    });
});

describe('NO_CALL_MEDIA', () => {
    it('has all four flags false and is frozen', () => {
        expect(NO_CALL_MEDIA).toEqual(st());
        expect(Object.isFrozen(NO_CALL_MEDIA)).toBe(true);
    });
});

describe('readCallMediaByUser', () => {
    it('keeps a muted-only participant (seeds include them) and drops all-off ones', () => {
        const out = readCallMediaByUser({
            a: { muted: true },
            b: { camera: false, screen_share: false, muted: false, deafened: false },
            c: { deafened: true },
            d: 'garbage',
        });
        expect(out).toEqual({ a: st({ muted: true }), c: st({ deafened: true }) });
    });

    it('an older server seed (camera / screen only) still reads, with muted / deafened false', () => {
        expect(readCallMediaByUser({ a: { camera: true, screen_share: false } })).toEqual({ a: st({ camera: true }) });
    });

    it('non-object / array input is an empty map', () => {
        expect(readCallMediaByUser(undefined)).toEqual({});
        expect(readCallMediaByUser([{ muted: true }])).toEqual({});
    });
});
