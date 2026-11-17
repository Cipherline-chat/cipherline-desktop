/**
 * Source-level wiring for the rail's off-screen ping arrows: Dashboard has no
 * render harness, so this pins that the real rail feeds RailTrack the pinged
 * keys from the SAME badge sources its tiles draw, and that the DM / Group
 * tiles carry the ids the arrows look up. The behaviour itself is covered by
 * rail/RailPingArrows.test.ts (rendered through the real RailTrack) and
 * rail/railOffscreenPings.test.ts (the pure rules).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const railTrack = readFileSync(join(__dirname, 'rail', 'RailTrack.tsx'), 'utf8');
const railTile = readFileSync(join(__dirname, 'rail', 'RailTile.tsx'), 'utf8');

function railNav(source: string): string {
    const start = source.indexOf('className="shrink-0 app-rail"');
    expect(start, 'rail <nav> not found').toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('</nav>', start));
}

describe('rail off-screen ping arrows — wiring', () => {
    const nav = railNav(dash);
    const scrollTrack = nav.indexOf('<RailTrack\n                    scroll');
    const scrollTrackProps = nav.slice(scrollTrack, nav.indexOf('>\n', nav.indexOf('activeIndex={', scrollTrack)));

    it('the scrolling rail track is given pingKeys from pingedRailKeys over the tiles\' own badge sources', () => {
        expect(scrollTrack).toBeGreaterThan(-1);
        expect(scrollTrackProps).toContain('pingKeys={pingedRailKeys({');
        expect(scrollTrackProps).toContain('dm: railBadges.dm');
        expect(scrollTrackProps).toContain('group: railBadges.group');
        expect(scrollTrackProps).toContain('items: railItems');
        expect(scrollTrackProps).toContain('serverBadge: railServerBadge');
        expect(scrollTrackProps).toContain('activeServerId: activeRailServerId');
    });

    it('only the scrolling track gets arrows (the Friends/Settings track does not)', () => {
        expect(nav.match(/pingKeys=/g)?.length).toBe(1);
    });

    it('the DM and Group tiles carry the data-rail-id the arrows look up', () => {
        expect(nav).toMatch(/badge=\{railBadges\.dm\}\s*\n\s*railId=\{RAIL_DM_KEY\}/);
        expect(nav).toMatch(/badge=\{railBadges\.group\}\s*\n\s*railId=\{RAIL_GROUP_KEY\}/);
        expect(railTile).toContain('data-rail-id={railId}');
    });

    it('RailTrack renders the arrows beside the scrollbar inside .cl-rail-box, not inside the track', () => {
        const box = railTrack.slice(railTrack.indexOf('<div className="cl-rail-box">'));
        expect(box).toContain('{trackEl}');
        expect(box).toContain('<RailPingArrows target={track} pingKeys={pingKeys} />');
        expect(box.indexOf('<RailPingArrows')).toBeGreaterThan(box.indexOf('{trackEl}'));
    });
});
