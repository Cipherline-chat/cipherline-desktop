import { describe, it, expect } from 'vitest';
import { createPortalPicks, planPortalPick, pickFromListing, PORTAL_PICKS_KEPT } from './portal-pick';

const A = { id: 'screen:2:0', name: 'Screen A' };
const B = { id: 'window:7:0', name: 'Window B' };

describe('planPortalPick: the pick decides who is asked', () => {
    it('a placeholder never seen is a NEW pick: list (one dialog)', () => {
        expect(planPortalPick(createPortalPicks(), 'screen:portal-a:0')).toEqual({ action: 'list' });
    });
    it('the same placeholder again is the same pick: the SAME listed source, no listing', () => {
        const picks = createPortalPicks();
        picks.set('screen:portal-a:0', A);
        expect(planPortalPick(picks, 'screen:portal-a:0')).toEqual({ action: 'reuse', source: A });
    });
    it('restore can only target the original source: a new placeholder is never answered from an older pick', () => {
        const picks = createPortalPicks();
        picks.set('screen:portal-a:0', A);
        const plan = planPortalPick(picks, 'screen:portal-b:0');
        expect(plan).toEqual({ action: 'list' });          // Change source asks
        picks.set('screen:portal-b:0', B);
        expect(planPortalPick(picks, 'screen:portal-b:0')).toEqual({ action: 'reuse', source: B });
        // ... and the running share's own pick is untouched by it
        expect(planPortalPick(picks, 'screen:portal-a:0')).toEqual({ action: 'reuse', source: A });
    });
    it('a cancelled Change source (nothing set) leaves the running share restorable', () => {
        const picks = createPortalPicks();
        picks.set('screen:portal-a:0', A);
        planPortalPick(picks, 'screen:portal-b:0');          // listed, dialog closed: nothing is set
        expect(planPortalPick(picks, 'screen:portal-a:0')).toEqual({ action: 'reuse', source: A });
        expect(picks.size()).toBe(1);
    });
});

describe('createPortalPicks', () => {
    it('keeps the last few picks and drops the oldest', () => {
        const picks = createPortalPicks();
        for (let i = 0; i < PORTAL_PICKS_KEPT + 2; i++) picks.set(`screen:portal-${i}:0`, { id: `screen:${i}:0`, name: `s${i}` });
        expect(picks.size()).toBe(PORTAL_PICKS_KEPT);
        expect(picks.get('screen:portal-0:0')).toBeUndefined();
        expect(picks.get(`screen:portal-${PORTAL_PICKS_KEPT + 1}:0`)).toBeDefined();
    });
    it('setting a placeholder again refreshes it instead of growing', () => {
        const picks = createPortalPicks(2);
        picks.set('a', A); picks.set('b', B); picks.set('a', A);
        picks.set('c', { id: 'screen:9:0', name: 'c' });
        expect(picks.get('a')).toEqual(A);                   // 'b' was the oldest after the refresh
        expect(picks.get('b')).toBeUndefined();
    });
});

describe('pickFromListing', () => {
    it('takes the first usable entry (Wayland lists the one source the user chose)', () => {
        expect(pickFromListing([{ id: 'screen:2:0', name: 'Screen 1' }, { id: 'window:3:0', name: 'x' }])).toEqual({ id: 'screen:2:0', name: 'Screen 1' });
        expect(pickFromListing([{ id: 'screen:2:0:s' }])).toEqual({ id: 'screen:2:0:s', name: 'Screen or window' });
    });
    it('an empty or unusable listing is a closed dialog: no pick', () => {
        expect(pickFromListing([])).toBeNull();
        expect(pickFromListing(null)).toBeNull();
        expect(pickFromListing(undefined)).toBeNull();
        expect(pickFromListing([{ id: 42 }, { id: 'tab:1:2' }, { id: 'screen:abc:0' }, { name: 'no id' }])).toBeNull();
    });
    it('control: the matcher is what rejects, not the loop', () => {
        expect(pickFromListing([{ id: 'screen:abc:0' }, { id: 'screen:5:0' }])).toEqual({ id: 'screen:5:0', name: 'Screen or window' });
    });
});
