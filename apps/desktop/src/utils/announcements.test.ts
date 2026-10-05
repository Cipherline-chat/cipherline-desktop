import { describe, it, expect } from 'vitest';
import {
    ANNOUNCEMENT_COLOR_TOKENS,
    ANNOUNCEMENT_ICONS,
    DEFAULT_ANNOUNCEMENT_COLOR,
    MAX_REMEMBERED_DISMISSALS,
    MAX_VISIBLE_ANNOUNCEMENTS,
    type BannerView,
    boundAnnouncementStack,
    filterDismissed,
    formatEndsIn,
    isDismissed,
    parseDismissedIds,
    recordDismissal,
    resolveAnnouncementColor,
    resolveAnnouncementIcon,
} from './announcements';

function banner(id: string, overrides: Partial<BannerView> = {}): BannerView {
    return {
        id,
        title: null,
        body: `body-${id}`,
        icon: null,
        color: 'lume',
        dismissible: true,
        starts_at: null,
        ends_at: null,
        ...overrides,
    };
}

describe('resolveAnnouncementColor', () => {
    it('resolves known presets to their token set', () => {
        // These are the SERVER's preset names. This test previously asserted
        // lume/flash/amber — names guessed while the client and API halves were
        // built in parallel, before the server settled on semantic ones.
        expect(resolveAnnouncementColor('info')).toEqual(ANNOUNCEMENT_COLOR_TOKENS.info);
        expect(resolveAnnouncementColor('warn')).toEqual(ANNOUNCEMENT_COLOR_TOKENS.warn);
        expect(resolveAnnouncementColor('danger')).toEqual(ANNOUNCEMENT_COLOR_TOKENS.danger);
        expect(resolveAnnouncementColor('neutral')).toEqual(ANNOUNCEMENT_COLOR_TOKENS.neutral);
    });

    it('falls back to neutral for an unknown preset name, rather than crashing or passing the raw value through', () => {
        expect(resolveAnnouncementColor('totally-made-up')).toEqual(ANNOUNCEMENT_COLOR_TOKENS[DEFAULT_ANNOUNCEMENT_COLOR]);
        expect(resolveAnnouncementColor('')).toEqual(ANNOUNCEMENT_COLOR_TOKENS[DEFAULT_ANNOUNCEMENT_COLOR]);
        expect(resolveAnnouncementColor(null)).toEqual(ANNOUNCEMENT_COLOR_TOKENS[DEFAULT_ANNOUNCEMENT_COLOR]);
        expect(resolveAnnouncementColor(undefined)).toEqual(ANNOUNCEMENT_COLOR_TOKENS[DEFAULT_ANNOUNCEMENT_COLOR]);
    });

    // POSITIVE CONTROL: prove the fallback assertion above can actually fail.
    // If resolveAnnouncementColor did NOT fall back (e.g. returned undefined
    // for an unknown name), this would need to fail — verified by hand while
    // authoring this suite (temporarily made the function return
    // ANNOUNCEMENT_COLOR_TOKENS[color] with no guard, re-ran, watched the
    // "falls back to neutral" test above fail with `undefined` vs the neutral
    // object, then restored the guard).
    it('a "neutral" preset and an unknown preset are genuinely the same object (guards the assertion itself)', () => {
        expect(resolveAnnouncementColor('unknown-xyz')).toBe(resolveAnnouncementColor('neutral'));
    });
});

describe('resolveAnnouncementIcon', () => {
    it('resolves a known icon name to a component', () => {
        expect(resolveAnnouncementIcon('megaphone')).toBe(ANNOUNCEMENT_ICONS.megaphone);
    });

    it('returns null for an unknown/absent icon name rather than throwing', () => {
        expect(resolveAnnouncementIcon('not-a-real-icon')).toBeNull();
        expect(resolveAnnouncementIcon(null)).toBeNull();
        expect(resolveAnnouncementIcon(undefined)).toBeNull();
        expect(resolveAnnouncementIcon('')).toBeNull();
    });
});

describe('filterDismissed', () => {
    it('removes only banners whose id is in the dismissed set', () => {
        const banners = [banner('a'), banner('b'), banner('c')];
        expect(filterDismissed(banners, ['b']).map(b => b.id)).toEqual(['a', 'c']);
    });

    it('preserves server order (never re-sorts)', () => {
        const banners = [banner('z'), banner('a'), banner('m')];
        expect(filterDismissed(banners, []).map(b => b.id)).toEqual(['z', 'a', 'm']);
    });

    it('accepts a Set as well as an array', () => {
        const banners = [banner('a'), banner('b')];
        expect(filterDismissed(banners, new Set(['a'])).map(b => b.id)).toEqual(['b']);
    });

    // POSITIVE CONTROL: an id that ISN'T dismissed must not be removed —
    // confirmed by temporarily swapping `!set.has(b.id)` to `set.has(b.id)`
    // in announcements.ts, re-running (this test then failed, returning []
    // instead of both banners), and reverting.
    it('keeps everything when nothing is dismissed', () => {
        const banners = [banner('a'), banner('b')];
        expect(filterDismissed(banners, [])).toHaveLength(2);
    });
});

describe('isDismissed', () => {
    it('true only for an id present in the list', () => {
        expect(isDismissed(['a', 'b'], 'a')).toBe(true);
        expect(isDismissed(['a', 'b'], 'c')).toBe(false);
        expect(isDismissed([], 'a')).toBe(false);
    });
});

describe('boundAnnouncementStack', () => {
    it('splits into visible (first N) and overflow (the rest)', () => {
        const banners = [banner('1'), banner('2'), banner('3'), banner('4')];
        const { visible, overflow } = boundAnnouncementStack(banners, 2);
        expect(visible.map(b => b.id)).toEqual(['1', '2']);
        expect(overflow.map(b => b.id)).toEqual(['3', '4']);
    });

    it('defaults to MAX_VISIBLE_ANNOUNCEMENTS when no cap is given', () => {
        const banners = Array.from({ length: MAX_VISIBLE_ANNOUNCEMENTS + 3 }, (_, i) => banner(String(i)));
        const { visible, overflow } = boundAnnouncementStack(banners);
        expect(visible).toHaveLength(MAX_VISIBLE_ANNOUNCEMENTS);
        expect(overflow).toHaveLength(3);
    });

    it('never drops below a cap of 1, even if asked for 0 or a negative number', () => {
        const banners = [banner('1'), banner('2')];
        expect(boundAnnouncementStack(banners, 0).visible).toHaveLength(1);
        expect(boundAnnouncementStack(banners, -5).visible).toHaveLength(1);
    });

    it('does not discard overflow banners — they are recoverable, not dropped', () => {
        const banners = [banner('1'), banner('2'), banner('3')];
        const { visible, overflow } = boundAnnouncementStack(banners, 1);
        expect(visible.length + overflow.length).toBe(banners.length);
    });

    // POSITIVE CONTROL: a cap larger than the list must not fabricate
    // overflow — confirmed by temporarily hardcoding `overflow:
    // banners.slice(1)` (ignoring `cap`), re-running (this test then failed:
    // overflow was non-empty for a 2-cap over a 2-item list), and reverting.
    it('produces empty overflow when everything already fits under the cap', () => {
        const banners = [banner('1'), banner('2')];
        expect(boundAnnouncementStack(banners, 5).overflow).toEqual([]);
    });
});

describe('recordDismissal / bounded growth', () => {
    it('appends a new id', () => {
        expect(recordDismissal(['a'], 'b')).toEqual(['a', 'b']);
    });

    it('moves a re-dismissed id to the end instead of duplicating it', () => {
        expect(recordDismissal(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
    });

    it('caps the list at `max`, evicting the OLDEST entries first', () => {
        const ids = ['a', 'b', 'c'];
        expect(recordDismissal(ids, 'd', 3)).toEqual(['b', 'c', 'd']);
    });

    it('never grows unbounded across many dismissals — stays at the cap', () => {
        let ids: string[] = [];
        for (let i = 0; i < MAX_REMEMBERED_DISMISSALS + 50; i++) {
            ids = recordDismissal(ids, `banner-${i}`);
        }
        expect(ids).toHaveLength(MAX_REMEMBERED_DISMISSALS);
        // The most recent one made it in...
        expect(ids).toContain(`banner-${MAX_REMEMBERED_DISMISSALS + 49}`);
        // ...and the very first ever dismissed ("months ago and long
        // deleted", per the task) has been evicted.
        expect(ids).not.toContain('banner-0');
    });

    // POSITIVE CONTROL: prove the cap assertion above can fail — confirmed by
    // temporarily removing the `next.length > cap ? next.slice(...) : next`
    // truncation in announcements.ts (returning `next` unconditionally),
    // re-running (the "stays at the cap" test then failed with length
    // MAX_REMEMBERED_DISMISSALS + 50 instead of MAX_REMEMBERED_DISMISSALS),
    // and restoring the truncation.
    it('a tiny explicit cap actually bites', () => {
        expect(recordDismissal(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
        expect(recordDismissal(['a', 'b'], 'c', 2)).not.toContain('a');
    });
});

describe('parseDismissedIds', () => {
    it('parses a valid JSON array of strings', () => {
        expect(parseDismissedIds('["a","b"]')).toEqual(['a', 'b']);
    });

    it('returns [] for null/undefined/empty input', () => {
        expect(parseDismissedIds(null)).toEqual([]);
        expect(parseDismissedIds(undefined)).toEqual([]);
        expect(parseDismissedIds('')).toEqual([]);
    });

    it('returns [] for malformed JSON rather than throwing', () => {
        expect(parseDismissedIds('{not json')).toEqual([]);
    });

    it('returns [] for valid JSON that is not a string array (e.g. an object)', () => {
        expect(parseDismissedIds('{"a":1}')).toEqual([]);
    });

    it('drops non-string entries from an otherwise-valid array', () => {
        expect(parseDismissedIds('["a", 1, null, "b"]')).toEqual(['a', 'b']);
    });
});

describe('formatEndsIn', () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');

    it('returns null when there is no ends_at', () => {
        expect(formatEndsIn(null, now)).toBeNull();
        expect(formatEndsIn(undefined, now)).toBeNull();
    });

    it('returns null for an unparsable date', () => {
        expect(formatEndsIn('not-a-date', now)).toBeNull();
    });

    it('returns null once the window has already elapsed (display-only — never used to filter)', () => {
        expect(formatEndsIn('2026-09-13T11:00:00.000Z', now)).toBeNull();
    });

    it('formats minutes, hours, and days appropriately', () => {
        expect(formatEndsIn('2026-09-13T12:30:00.000Z', now)).toBe('ends in 30m');
        expect(formatEndsIn('2026-09-13T15:00:00.000Z', now)).toBe('ends in 3h');
        expect(formatEndsIn('2026-09-16T12:00:00.000Z', now)).toBe('ends in 3d');
    });

    // POSITIVE CONTROL: an already-elapsed ends_at must not print a
    // countdown — confirmed by temporarily changing `ms <= 0` to `ms < 0` in
    // announcements.ts (so exactly-now no longer counted as elapsed),
    // re-running (a boundary case then printed "ends in 0m" instead of null
    // — not exercised by the exact test above but caught while hand-checking
    // this control), and reverting.
    it('treats exactly-now as elapsed', () => {
        expect(formatEndsIn('2026-09-13T12:00:00.000Z', now)).toBeNull();
    });
});

describe('client presets cover the SERVER allowlist', () => {
    // These two lists are the server's, from admin/src/announcements.validate.js.
    // They are duplicated here on purpose: the client cannot import from the
    // admin app, so the only thing that can catch drift is an assertion. This
    // already bit once — the two halves were built in parallel, the client
    // guessed lume/flash/amber, the server settled on semantic names, and
    // `warn` and `danger` silently rendered as grey neutral chrome. Three
    // server icons were likewise unmapped and would have rendered nothing.
    const SERVER_COLORS = ['neutral', 'info', 'warn', 'danger'];
    const SERVER_ICONS = [
        'info', 'megaphone', 'bell', 'wrench', 'alert-triangle', 'alert-octagon',
        'calendar-clock', 'clock', 'shield', 'sparkles', 'gift', 'rocket',
    ];

    it('maps every server colour to a non-neutral style (except neutral itself)', () => {
        const neutral = resolveAnnouncementColor('neutral');
        for (const c of SERVER_COLORS) {
            const got = resolveAnnouncementColor(c);
            expect(got, `colour "${c}" is unmapped`).toBeDefined();
            if (c !== 'neutral') {
                // An unmapped name falls back to neutral — which is exactly how
                // the original bug hid. Assert it did NOT fall back.
                expect(got, `colour "${c}" silently fell back to neutral`).not.toEqual(neutral);
            }
        }
    });

    it('maps every server icon to a real component', () => {
        for (const i of SERVER_ICONS) {
            expect(resolveAnnouncementIcon(i), `icon "${i}" is unmapped`).toBeTruthy();
        }
    });
});
