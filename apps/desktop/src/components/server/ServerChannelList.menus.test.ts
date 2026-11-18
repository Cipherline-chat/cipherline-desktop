/**
 * Where "Create Sub-category" is offered, pinned at the source: only from a
 * TOP-LEVEL category (its right-click menu and its "+"), never from blank space.
 * The menu contents themselves are exercised in a real browser by
 * harness/subcat-menus-shots.mjs (the category "+" menu, the sub-category "+"
 * menu, the blank-space menu).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, 'ServerChannelList.tsx'), 'utf8');
const between = (from: string, to: string) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
};

describe('ServerChannelList: sub-category entry points', () => {
    it('the blank-space (background) create menu has Channel / Category / Divider and no sub-category', () => {
        const bg = between('createMenu.open(e, [', ']);');
        expect(bg).toContain("label: 'Create Channel'");
        expect(bg).toContain("label: 'Create Category'");
        expect(bg).toContain("label: 'Add Divider'");
        expect(bg).not.toMatch(/sub-?category/i);
    });

    it('the header "+" menu: sub-category only when the header is a top-level category', () => {
        const menu = between('const buildAddMenu', 'const buildDividerMenu');
        expect(menu).toContain("label: 'Create Channel'");
        expect(menu).toContain("label: 'Add Divider'");
        expect(menu).toMatch(/\.\.\.\(!isSub \? \[\{[\s\S]*label: 'Create Sub-category'/);
        // each option preselects the category it was opened from
        expect(menu).toContain('defaultCategoryId: cat.category_id');
        expect(menu).toContain('container: cat.category_id');
        expect(menu).toContain('parentCategoryId: cat.category_id');
    });

    it('the category right-click menu keeps its sub-category entry for top-level categories only', () => {
        const menu = between('const buildCategoryMenu', 'const buildAddMenu');
        expect(menu).toMatch(/\.\.\.\(!isSub \? \[\{[\s\S]*Create Sub-category Here/);
        expect(menu).not.toContain('Move to top level');
    });

    it("both header \"+\" buttons open that menu anchored to the button, and header keys ignore the buttons' own keystrokes", () => {
        expect((src.match(/buildAddMenu\(cat\)/g) ?? []).length).toBe(2);
        expect(src).toContain('buttonAnchor(e.currentTarget as HTMLElement)');
        expect((src.match(/if \(e\.target !== e\.currentTarget\) return;/g) ?? []).length).toBe(2);
    });
});

// Owner, 2026-11-16: "the icon that is default when creating a sub category is
// not being applied". The dialog previews CornerDownRight when no icon is
// picked; the sidebar header must draw the same default, not nothing.
describe('sub-category header icon', () => {
    it('falls back to the dialog default (CornerDownRight) when no icon was picked', () => {
        expect(src).toMatch(/\{cat\.icon_name \? \(\s*<ChannelIconRenderer[\s\S]{0,600}?\) : \(\s*<CornerDownRight[\s\S]{0,300}?data-testid="subcat-default-icon"/);
    });
    it('the dialog default is the same icon', () => {
        const dlg = readFileSync(resolve(__dirname, 'CategoryFormDialog.tsx'), 'utf8');
        expect(dlg).toContain('fallbackIcon={<CornerDownRight size={16} />}');
    });
});

describe('ServerChannelList: sub-category label weight', () => {
    // Owner, 2026-11-17: "I don't like how sub categories have bold text". The label was the
    // rounded display font at medium weight, which reads bold; it now matches channel names.
    it('the sub-category label is plain: normal weight, body font, no display font', () => {
        const label = between('data-testid="subcat-label"', '{cat.name}');
        expect(label).toContain('font-normal');
        expect(label).not.toMatch(/font-(medium|semibold|bold|extrabold)|cl-font-display/);
    });
    it('the drag preview of a sub-category does not switch to the display font', () => {
        expect(src).not.toContain("activeParsed?.kind === 'subcategory' ? { fontFamily: 'var(--cl-font-display)' }");
    });
});
