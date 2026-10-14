/**
 * Off-screen unread logic (offscreenUnread.ts): which channels count, in which
 * direction, which one a click lands on, and the collapsed-category rule.
 *
 * Geometry used throughout: 30 px rows, a 300 px viewport, 900 px of content
 * (max scroll 600). PILL_ZONE is 40.
 */
import { describe, it, expect } from 'vitest';
import {
    channelBadgeKind, buildUnreadModel, visibleBand, classifyAnchors, summarize, pillLabel,
    pillAriaLabel, planJump, centeredScrollTop, PILL_ZONE,
    type MeasuredAnchor, type ScrollView, type BadgeInput, type ModelInput, type UnreadKind,
} from './offscreenUnread';

const VIEW = (scrollTop: number): ScrollView => ({ scrollTop, clientHeight: 300, scrollHeight: 900 });

const anchor = (id: string, center: number, kind: UnreadKind = 'unread', mentions = 0): MeasuredAnchor =>
    ({ key: `ch:${id}`, kind, mentions, channelId: id, center });

const badge = (over: Partial<BadgeInput>): ReturnType<typeof channelBadgeKind> =>
    channelBadgeKind({ unread: 0, mentions: 0, serverNotifMode: 'all', channelMuted: false, active: false, ...over });

describe('channelBadgeKind — must match what the row badges draw', () => {
    it('plain unread → counted lume badge', () => expect(badge({ unread: 3 })).toBe('unread'));
    it('mention → red, even alongside unread', () => expect(badge({ unread: 3, mentions: 1 })).toBe('mention'));
    it('nothing → null', () => expect(badge({})).toBeNull());

    it('a muted channel hides plain unreads…', () => expect(badge({ unread: 3, channelMuted: true })).toBeNull());
    it('…but never an @mention', () => expect(badge({ mentions: 2, channelMuted: true })).toBe('mention'));
    it('server set to "none" behaves like muted: no plain unread, mention still shows', () => {
        expect(badge({ unread: 3, serverNotifMode: 'none' })).toBeNull();
        expect(badge({ mentions: 1, serverNotifMode: 'none' })).toBe('mention');
    });

    it('"@mentions only" server: plain unread is the quiet grey dot', () => {
        expect(badge({ unread: 3, serverNotifMode: 'mentions' })).toBe('quiet');
    });
    it('"@mentions only" + muted channel: the quiet dot is suppressed too', () => {
        expect(badge({ unread: 3, serverNotifMode: 'mentions', channelMuted: true })).toBeNull();
    });
    it('"@mentions only": a mention is still red', () => {
        expect(badge({ unread: 3, mentions: 1, serverNotifMode: 'mentions' })).toBe('mention');
    });

    it('the open channel never counts, whatever it holds', () => {
        expect(badge({ unread: 5, active: true })).toBeNull();
        expect(badge({ unread: 5, mentions: 2, active: true })).toBeNull();
    });
});

describe('buildUnreadModel', () => {
    const ch = (id: string) => ({ channel_id: id });
    const base = (over: Partial<ModelInput>): ModelInput => ({
        uncategorized: [ch('g1')],
        categories: [
            { category_id: 'catA', channels: [ch('a1'), ch('a2'), ch('a3')] },
            { category_id: 'catB', channels: [ch('b1'), ch('b2')] },
        ],
        collapsed: {},
        serverNotifMode: 'all',
        activeChannelId: null,
        ...over,
    });
    const keys = (m: Map<string, unknown>) => [...m.keys()].sort();

    it('one entry per channel that shows a badge, none for read channels', () => {
        const m = buildUnreadModel(base({ unreadCounts: { g1: 1, a2: 4, b2: 9 }, mentionCounts: { b1: 2 } }));
        expect(keys(m)).toEqual(['ch:a2', 'ch:b1', 'ch:b2', 'ch:g1']);
        expect(m.get('ch:b1')).toMatchObject({ kind: 'mention', mentions: 2, channelId: 'b1' });
        expect(m.get('ch:a2')).toMatchObject({ kind: 'unread', mentions: 0 });
    });

    it('excludes the active channel', () => {
        const m = buildUnreadModel(base({ unreadCounts: { a1: 2, a2: 2 }, activeChannelId: 'a1' }));
        expect(keys(m)).toEqual(['ch:a2']);
    });

    it('excludes muted channels\' plain unreads but keeps their mentions', () => {
        const m = buildUnreadModel(base({
            unreadCounts: { a1: 2, a2: 2 }, mentionCounts: { a2: 1 }, mutedChannelIds: new Set(['a1', 'a2']),
        }));
        expect(keys(m)).toEqual(['ch:a2']);
        expect(m.get('ch:a2')?.kind).toBe('mention');
    });

    it('"@mentions only" yields quiet entries', () => {
        const m = buildUnreadModel(base({ unreadCounts: { a1: 2 }, serverNotifMode: 'mentions' }));
        expect(m.get('ch:a1')?.kind).toBe('quiet');
    });

    describe('collapsed categories (their rows are not rendered)', () => {
        it('the category header stands in: one entry, no per-channel entries', () => {
            const m = buildUnreadModel(base({ unreadCounts: { a1: 1, a3: 5 }, collapsed: { catA: true } }));
            expect(keys(m)).toEqual(['cat:catA']);
            expect(m.get('cat:catA')).toMatchObject({ kind: 'unread', channelId: 'a1', expandCategoryId: 'catA' });
        });

        it('rolls up to the strongest kind and sums mentions', () => {
            const m = buildUnreadModel(base({
                unreadCounts: { a1: 1 }, mentionCounts: { a2: 2, a3: 3 }, collapsed: { catA: true },
            }));
            expect(m.get('cat:catA')).toMatchObject({ kind: 'mention', mentions: 5, channelId: 'a1' });
        });

        it('a collapsed category holding nothing unread produces no entry', () => {
            const m = buildUnreadModel(base({ unreadCounts: { b1: 1 }, collapsed: { catA: true } }));
            expect(keys(m)).toEqual(['ch:b1']);
        });

        it('the active channel does not make a collapsed category look unread', () => {
            const m = buildUnreadModel(base({ unreadCounts: { a1: 4 }, collapsed: { catA: true }, activeChannelId: 'a1' }));
            expect(m.size).toBe(0);
        });

        it('only the muted-but-mentioned channel counts toward a collapsed header', () => {
            const m = buildUnreadModel(base({
                unreadCounts: { a1: 4, a2: 4 }, mentionCounts: { a2: 1 }, mutedChannelIds: new Set(['a1', 'a2']),
                collapsed: { catA: true },
            }));
            expect(m.get('cat:catA')).toMatchObject({ kind: 'mention', mentions: 1, channelId: 'a2' });
        });

        it('expanding turns the header entry back into per-channel entries', () => {
            const m = buildUnreadModel(base({ unreadCounts: { a1: 1, a3: 5 }, collapsed: { catA: false } }));
            expect(keys(m)).toEqual(['ch:a1', 'ch:a3']);
        });
    });
});

describe('visibleBand', () => {
    it('at the very top there is no top zone; the bottom zone is the pill strip', () => {
        expect(visibleBand(VIEW(0))).toEqual({ top: 0, bottom: 300 - PILL_ZONE });
    });
    it('mid-list both zones apply', () => {
        expect(visibleBand(VIEW(300))).toEqual({ top: 300 + PILL_ZONE, bottom: 600 - PILL_ZONE });
    });
    it('at the very bottom the bottom zone vanishes (nothing left to point at)', () => {
        expect(visibleBand(VIEW(600))).toEqual({ top: 600 + PILL_ZONE, bottom: 900 });
    });
    it('zones shrink continuously near the ends — no jump at one pixel', () => {
        expect(visibleBand(VIEW(5)).top).toBe(10);
        expect(visibleBand(VIEW(595)).bottom).toBe(895 - 5);
    });
    it('content shorter than the viewport has no zones at all', () => {
        expect(visibleBand({ scrollTop: 0, clientHeight: 300, scrollHeight: 200 })).toEqual({ top: 0, bottom: 300 });
    });
    it('clamps an overscrolled offset', () => {
        expect(visibleBand(VIEW(-50))).toEqual(visibleBand(VIEW(0)));
        expect(visibleBand(VIEW(9999))).toEqual(visibleBand(VIEW(600)));
    });
});

describe('classifyAnchors', () => {
    it('splits by direction, nearest to the viewport first', () => {
        const as = [anchor('far-below', 800), anchor('in', 450), anchor('near-below', 620), anchor('far-above', 20), anchor('near-above', 250)];
        const { above, below } = classifyAnchors(as, VIEW(300));
        expect(above.map(a => a.channelId)).toEqual(['near-above', 'far-above']);
        expect(below.map(a => a.channelId)).toEqual(['near-below', 'far-below']);
    });

    it('an anchor in view counts for neither', () => {
        const { above, below } = classifyAnchors([anchor('x', 450)], VIEW(300));
        expect(above).toEqual([]);
        expect(below).toEqual([]);
    });

    it('a row hidden BEHIND the pill (bottom strip) counts as below even though it is inside the scrollport', () => {
        // scrollTop 0: viewport spans 0-300, pill strip is 260-300.
        expect(classifyAnchors([anchor('under-pill', 285)], VIEW(0)).below).toHaveLength(1);
        expect(classifyAnchors([anchor('clear', 255)], VIEW(0)).below).toHaveLength(0);
    });

    it('at the very top the first row is never "above"; at the very bottom the last row is never "below"', () => {
        expect(classifyAnchors([anchor('first', 15)], VIEW(0)).above).toHaveLength(0);
        expect(classifyAnchors([anchor('last', 885)], VIEW(600)).below).toHaveLength(0);
    });

    it('negative control: the top-of-list state with unreads only in view yields no pill at all', () => {
        const { above, below } = classifyAnchors([anchor('a', 40), anchor('b', 100), anchor('c', 200)], VIEW(0));
        expect(summarize(above)).toBeNull();
        expect(summarize(below)).toBeNull();
    });
});

describe('summarize / labels', () => {
    it('null for an empty direction', () => expect(summarize([])).toBeNull());

    it('plain unreads → "New unreads", unread tone', () => {
        const s = summarize([anchor('a', 1), anchor('b', 2)])!;
        expect(s).toMatchObject({ kind: 'unread', count: 2, mentions: 0 });
        expect(pillLabel(s)).toBe('New unreads');
    });

    it('any mention flips the pill red and shows the summed mention count', () => {
        const s = summarize([anchor('a', 1), anchor('b', 2, 'mention', 1), anchor('c', 3, 'mention', 1)])!;
        expect(s).toMatchObject({ kind: 'mention', count: 3, mentions: 2 });
        expect(pillLabel(s)).toBe('2 mentions');
    });

    it('singular, and 99+ cap', () => {
        expect(pillLabel(summarize([anchor('a', 1, 'mention', 1)])!)).toBe('1 mention');
        expect(pillLabel(summarize([anchor('a', 1, 'mention', 140)])!)).toBe('99+ mentions');
    });

    it('only quiet unreads → quiet tone, same words', () => {
        const s = summarize([anchor('a', 1, 'quiet')])!;
        expect(s.kind).toBe('quiet');
        expect(pillLabel(s)).toBe('New unreads');
    });

    it('quiet + unread → unread tone (the stronger one)', () => {
        expect(summarize([anchor('a', 1, 'quiet'), anchor('b', 2, 'unread')])!.kind).toBe('unread');
    });

    it('aria-label names the direction; mentions are appended', () => {
        expect(pillAriaLabel('below', summarize([anchor('a', 1)])!)).toBe('Jump to next unread channel below');
        expect(pillAriaLabel('above', summarize([anchor('a', 1)])!)).toBe('Jump to next unread channel above');
        expect(pillAriaLabel('below', summarize([anchor('a', 1, 'mention', 2)])!)).toBe('Jump to next unread channel below, 2 mentions');
    });
});

describe('planJump', () => {
    it('picks the NEAREST off-screen unread in the direction, not the strongest', () => {
        const as = [anchor('near', 620, 'unread'), anchor('far-mention', 800, 'mention', 3)];
        const plan = planJump(as, VIEW(300), 'below', false)!;
        expect(plan.anchor.channelId).toBe('near');
    });

    it('going up picks the nearest above', () => {
        const as = [anchor('a', 20), anchor('b', 250), anchor('c', 100)];
        expect(planJump(as, VIEW(300), 'above', false)!.anchor.channelId).toBe('b');
    });

    it('scrolls so the target is centred', () => {
        const plan = planJump([anchor('t', 620)], VIEW(300), 'below', false)!;
        expect(plan.scrollTop).toBe(620 - 150);
    });

    it('clamps to the scrollable range', () => {
        expect(planJump([anchor('t', 880)], VIEW(0), 'below', false)!.scrollTop).toBe(600);
        expect(centeredScrollTop(10, VIEW(300))).toBe(0);
    });

    it('smooth by default, instant under reduced motion', () => {
        expect(planJump([anchor('t', 620)], VIEW(300), 'below', false)!.behavior).toBe('smooth');
        expect(planJump([anchor('t', 620)], VIEW(300), 'below', true)!.behavior).toBe('instant');
    });

    it('null when nothing is off-screen that way (negative control)', () => {
        expect(planJump([anchor('in-view', 450)], VIEW(300), 'below', false)).toBeNull();
        expect(planJump([anchor('only-below', 700)], VIEW(300), 'above', false)).toBeNull();
        expect(planJump([], VIEW(0), 'below', false)).toBeNull();
    });

    it('repeated clicks step through the unreads in order and then stop', () => {
        const as = [anchor('u1', 400), anchor('u2', 560), anchor('u3', 760), anchor('u4', 860)];
        let scrollTop = 0;
        const visited: string[] = [];
        for (let i = 0; i < 10; i++) {
            const plan = planJump(as, VIEW(scrollTop), 'below', false);
            if (!plan) break;
            visited.push(plan.anchor.channelId);
            scrollTop = plan.scrollTop;
        }
        // u3 sits near the end of the content: landing on it clamps to max scroll,
        // which also brings u4 into view, so the walk ends there (no dead click).
        expect(visited).toEqual(['u1', 'u2', 'u3']);
        // …and after the last jump nothing is left below.
        expect(classifyAnchors(as, VIEW(scrollTop)).below).toEqual([]);
    });

    it('the landed-on anchor is no longer off-screen (the click makes progress)', () => {
        const as = [anchor('t', 700)];
        const plan = planJump(as, VIEW(0), 'below', false)!;
        const after = classifyAnchors(as, VIEW(plan.scrollTop));
        expect(after.below).toEqual([]);
        expect(after.above).toEqual([]);
    });
});
