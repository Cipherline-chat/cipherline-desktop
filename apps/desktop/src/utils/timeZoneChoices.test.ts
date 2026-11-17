import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    allTimeZoneIds, buildTimeZoneInfos, describeTimeZone, filterTimeZones, formatUtcOffset,
    parseOffsetQuery, resetTimeZoneIdCacheForTests, timeZoneLabel, warmTimeZoneFormatters, FALLBACK_TIME_ZONES,
} from './timeZoneChoices';

// Fixed instants so DST is deterministic: January (northern winter) and July.
const JAN = new Date('2026-01-15T02:41:00Z'); // 8:41 PM on the 14th in Chicago (CST, −6)
const JUL = new Date('2026-07-15T01:41:00Z'); // 8:41 PM on the 14th in Chicago (CDT, −5)

const ids = (list: { id: string }[]) => list.map((z) => z.id);

describe('formatUtcOffset', () => {
    it('formats with a true minus sign and zero padding', () => {
        expect(formatUtcOffset(-360)).toBe('UTC−06:00');
        expect(formatUtcOffset(330)).toBe('UTC+05:30');
        expect(formatUtcOffset(345)).toBe('UTC+05:45');
        expect(formatUtcOffset(0)).toBe('UTC+00:00');
        expect(formatUtcOffset(-570)).toBe('UTC−09:30');
    });
});

describe('describeTimeZone', () => {
    it('describes Chicago in winter: city, region, offset, local time, long name', () => {
        const z = describeTimeZone('America/Chicago', JAN)!;
        expect(z.city).toBe('Chicago');
        expect(z.region).toBe('America');
        expect(z.offsetMinutes).toBe(-360);
        expect(z.offsetLabel).toBe('UTC−06:00');
        expect(z.time).toBe('8:41 PM');
        expect(z.longName).toBe('Central Standard Time');
        expect(timeZoneLabel(z)).toBe('Chicago (America) — UTC−06:00, 8:41 PM');
    });

    it('is DST-aware (same zone, summer instant)', () => {
        const z = describeTimeZone('America/Chicago', JUL)!;
        expect(z.offsetMinutes).toBe(-300);
        expect(z.time).toBe('8:41 PM');
    });

    it('handles half/quarter-hour offsets and nested regions', () => {
        expect(describeTimeZone('Asia/Kolkata', JAN)!.offsetMinutes).toBe(330);
        expect(describeTimeZone('Asia/Kathmandu', JAN)!.offsetMinutes).toBe(345);
        const ba = describeTimeZone('America/Argentina/Buenos_Aires', JAN)!;
        expect(ba.city).toBe('Buenos Aires');
        expect(ba.region).toBe('Argentina, America');
    });

    it('labels region-less UTC without empty parentheses', () => {
        const z = describeTimeZone('UTC', JAN)!;
        expect(z.offsetMinutes).toBe(0);
        expect(timeZoneLabel(z)).toBe('UTC — UTC+00:00, 2:41 AM');
    });

    it('returns null for an id the runtime cannot format', () => {
        expect(describeTimeZone('Not/AZone', JAN)).toBeNull();
    });
});

describe('allTimeZoneIds', () => {
    afterEach(() => { vi.restoreAllMocks(); resetTimeZoneIdCacheForTests(); });

    it('is the full runtime list plus UTC (Chromium omits it)', () => {
        resetTimeZoneIdCacheForTests();
        const all = allTimeZoneIds();
        expect(all.length).toBeGreaterThan(300);
        expect(all).toContain('UTC');
        expect(all).toContain('America/Chicago');
        expect(new Set(all).size).toBe(all.length);
    });

    it('keeps a saved alias selectable, but never an invalid value', () => {
        resetTimeZoneIdCacheForTests();
        expect(allTimeZoneIds('Asia/Calcutta')).toContain('Asia/Calcutta');
        expect(allTimeZoneIds('Not/AZone')).not.toContain('Not/AZone');
    });

    it('falls back to a broad list (not just one zone) without Intl.supportedValuesOf', () => {
        resetTimeZoneIdCacheForTests();
        const intl = Intl as unknown as { supportedValuesOf?: unknown };
        const orig = intl.supportedValuesOf;
        intl.supportedValuesOf = undefined;
        try {
            const all = allTimeZoneIds();
            expect(all.length).toBeGreaterThanOrEqual(FALLBACK_TIME_ZONES.length - 2);
            expect(all).toContain('America/Chicago');
            expect(all).toContain('Asia/Kolkata');
        } finally {
            intl.supportedValuesOf = orig;
        }
    });
});

describe('warmTimeZoneFormatters', () => {
    it('finishes (in slices) and calls onDone once; cancel stops it', async () => {
        const done = vi.fn();
        warmTimeZoneFormatters(done);
        await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 10_000 });
        const never = vi.fn();
        const cancel = warmTimeZoneFormatters(never);
        cancel();
        await new Promise((r) => setTimeout(r, 50));
        expect(never).not.toHaveBeenCalled();
    });
});

describe('parseOffsetQuery', () => {
    it.each([
        ['UTC-6', -360], ['utc−6', -360], ['GMT+1', 60], ['gmt +1', 60], ['UTC+05:30', 330], ['+5:30', 330],
        ['-03', -180], ['UTC+0545', 345], ['utc', 0], ['GMT', 0], ['UTC±0', 0], ['UTC+14', 840],
    ])('%s → %d', (q, mins) => {
        expect(parseOffsetQuery(q)).toBe(mins);
    });

    it.each(['chicago', 'central', '6', 'UTC+15', 'UTC+5:75', 'America/Chicago', ''])('%s is not an offset', (q) => {
        expect(parseOffsetQuery(q)).toBeNull();
    });
});

describe('filterTimeZones', () => {
    const all = buildTimeZoneInfos(null, JAN);

    it('empty query returns everything, sorted west → east', () => {
        const out = filterTimeZones(all, '   ');
        expect(out).toHaveLength(all.length);
        for (let i = 1; i < out.length; i++) expect(out[i].offsetMinutes).toBeGreaterThanOrEqual(out[i - 1].offsetMinutes);
    });

    it('city search is case-insensitive and ranks the city prefix first', () => {
        const out = filterTimeZones(all, 'chi');
        expect(out.length).toBeGreaterThan(1);
        expect(out[0].city.toLowerCase().startsWith('chi')).toBe(true);
        expect(ids(out)).toContain('America/Chicago');
        expect(ids(filterTimeZones(all, 'CHICAGO'))).toEqual(['America/Chicago']);
    });

    it('finds zones by long name ("central") and by its initials ("cst")', () => {
        expect(ids(filterTimeZones(all, 'central'))).toContain('America/Chicago');
        expect(ids(filterTimeZones(all, 'cst'))).toContain('America/Chicago');
        expect(ids(filterTimeZones(all, 'pacific standard'))).toContain('America/Los_Angeles');
    });

    it('finds by region and full zone id, with spaces for underscores', () => {
        expect(ids(filterTimeZones(all, 'America/Chicago'))).toEqual(['America/Chicago']);
        // V8/ICU lists the CLDR-canonical "America/Buenos_Aires" (not the
        // IANA "America/Argentina/Buenos_Aires"); either way it's findable.
        const ba = ids(filterTimeZones(all, 'buenos aires'));
        expect(ba.some((id) => id.endsWith('Buenos_Aires'))).toBe(true);
        // …and by country, via the long name "Argentina Standard Time".
        expect(ids(filterTimeZones(all, 'argentina')).some((id) => id.endsWith('Buenos_Aires'))).toBe(true);
        // Multi-token: every token must match somewhere.
        expect(ids(filterTimeZones(all, 'america chicago'))).toEqual(['America/Chicago']);
    });

    it('offset queries keep exactly the zones at that offset NOW', () => {
        const minus6 = filterTimeZones(all, 'UTC-6');
        expect(ids(minus6)).toContain('America/Chicago');
        expect(minus6.every((z) => z.offsetMinutes === -360)).toBe(true);
        const plus1 = filterTimeZones(all, 'GMT+1');
        expect(ids(plus1)).toContain('Europe/Paris');
        expect(plus1.every((z) => z.offsetMinutes === 60)).toBe(true);
        // In July Chicago is UTC−5, so a −6 search no longer lists it.
        expect(ids(filterTimeZones(buildTimeZoneInfos(null, JUL), 'UTC-6'))).not.toContain('America/Chicago');
    });

    it('finds renamed cities by their current name, whatever id the runtime lists', () => {
        const kolkata = filterTimeZones(all, 'kolkata');
        expect(kolkata.length).toBeGreaterThan(0);
        expect(kolkata[0].city).toBe('Kolkata');
        expect(ids(kolkata)[0]).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
        expect(filterTimeZones(all, 'kyiv').map((z) => z.city)).toContain('Kyiv');
        // The old name still works too.
        expect(ids(filterTimeZones(all, 'calcutta')).length + ids(filterTimeZones(all, 'kolkata')).length).toBeGreaterThan(1);
    });

    it('"utc" alone lists the zero-offset zones', () => {
        const out = filterTimeZones(all, 'utc');
        expect(ids(out)).toContain('UTC');
        expect(ids(out)).toContain('Europe/London'); // GMT in January
    });

    it('nothing matches gibberish', () => {
        expect(filterTimeZones(all, 'zzqqxx')).toEqual([]);
    });
});
