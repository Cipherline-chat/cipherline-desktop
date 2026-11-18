/**
 * Source guard (owner, 2026-11-18): a divider category's rules must fill the
 * header row at once after a click. Nothing on the heading, its rules or the
 * "+" / "..." slot may animate a layout property, and no header slot may be
 * revealed by plain `focus-within` (a mouse click leaves the role=button row
 * focused, which kept the slot - and the short rule - until focus moved).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_HEADER_ACTIONS_CLASS } from './categoryHeadingStyle';

const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const LAYOUT_TRANSITION = /transition-(all|width|size|spacing|\[)|transition:\s*(all|width|flex)|transition-property:[^;]*(width|flex|max)/;

describe('category header action slot and divider rules', () => {
    it('the heading, divider visual and slot class define no layout transition', () => {
        for (const f of ['CategoryHeading.tsx', 'categoryHeadingStyle.ts']) expect(read(f), f).not.toMatch(LAYOUT_TRANSITION);
        // ChannelDividerVisual (above DividerHitArea) draws the rules.
        const divider = read('ChannelDividerRow.tsx').split('export const DIVIDER_HIT_MIN_PX')[0];
        expect(divider).not.toMatch(LAYOUT_TRANSITION);
    });

    it('the slot is revealed by hover or :focus-visible only, never focus-within', () => {
        const cls = CATEGORY_HEADER_ACTIONS_CLASS;
        // The row itself is the focus target (group-focus-visible); has() only sees descendants.
        expect(cls.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'group-hover:flex', 'group-focus-visible:flex', 'group-has-[:focus-visible]:flex', 'group-focus-visible:opacity-100']));
        expect(cls).not.toMatch(/focus-within/);
    });

    it('both panels use the shared slot class (the Calls panel used to keep the space, with transition-all)', () => {
        for (const f of ['ServerChannelList.tsx', 'ServerContextPanel.tsx']) {
            const src = read(f);
            expect(src, f).toContain('CATEGORY_HEADER_ACTIONS_CLASS');
            expect(src, f).not.toMatch(/opacity-0 group-hover:opacity-100 flex items-center gap-0\.5 transition-all/);
        }
    });
    it('the Calls panel header reserves the 22 px button height, so revealing the slot cannot grow the row (owner, 2026-11-18)', () => {
        // Without a min height the header is the 15 px icon / 12 px label tall and the 22 px "+" / "..." buttons
        // made it 22 px on hover: every call row below moved 6 px. Measured by harness/call-hover-shift-check.mjs.
        const src = read('ServerContextPanel.tsx');
        const header = src.split('aria-label={`${cat.name}, ${categoryDividerLook(cat) ? \'divider category\' : \'category\'}`}')[1]?.split('onClick=')[0] ?? '';
        expect(header).toContain("canManage ? 'min-h-[22px]'");
    });
});
