import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrollTopToReveal } from './rail/railScrollReveal';
import { wordmarkSide } from './wordmarkSide';
import { railOverflows, thumbGeometry, scrollTopForThumbDrag, scrollTopForTrackClick, SCROLL_SHOW_MS } from './rail/railScrollbarMath';

const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
const sortable = readFileSync(join(__dirname, 'rail', 'SortableServerTile.tsx'), 'utf8');
const railScrollbarSrc = readFileSync(join(__dirname, 'rail', 'RailScrollbar.tsx'), 'utf8');
const railTrackSrc = readFileSync(join(__dirname, 'rail', 'RailTrack.tsx'), 'utf8');

/** The rail <nav> block of Dashboard.tsx (from its opening tag to </nav>). */
function railNav(source: string): string {
    const start = source.indexOf('className="shrink-0 app-rail"');
    expect(start, 'rail <nav> not found').toBeGreaterThan(-1);
    const end = source.indexOf('</nav>', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('rail overflow — the server BOX is the scroll region', () => {
    const nav = railNav(dash);
    const dndOpen = nav.indexOf('<DndContext');
    const dndClose = nav.indexOf('</DndContext>');
    const scrollTrack = nav.indexOf('<RailTrack\n                    scroll');
    const spacer = nav.indexOf("marginTop: 'auto'");
    const bottomTrack = nav.indexOf("activeTab === 'friends' ? 0 : settingsOpen ? 1 : -1");
    const statusPicker = nav.indexOf('<StatusPicker');

    it('the top RailTrack (DMs/Groups/servers/+) is the `scroll` one, inside the DndContext', () => {
        expect(scrollTrack).toBeGreaterThan(dndOpen);
        expect(scrollTrack).toBeLessThan(dndClose);
        expect(nav.slice(scrollTrack, scrollTrack + 200)).toContain('scrollRef={railScrollRef}');
    });

    it('there is NO separate wrapper scroller any more (the box itself scrolls)', () => {
        expect(nav).not.toContain('cl-rail-scroll');
        expect(nav).not.toContain('is-hot');
    });

    it('the bottom group (update / Friends / Settings / avatar) is a sibling AFTER the spacer, and its track does not scroll', () => {
        for (const [name, at] of [['spacer', spacer], ['bottom track', bottomTrack], ['StatusPicker', statusPicker]] as const) {
            expect(at, name).toBeGreaterThan(dndClose);
        }
        expect(bottomTrack).toBeGreaterThan(spacer);
        expect(statusPicker).toBeGreaterThan(bottomTrack);
        const bottomOpen = nav.lastIndexOf('<RailTrack', bottomTrack);
        expect(nav.slice(bottomOpen, bottomTrack)).not.toContain('scroll');
    });

    it('RailTrack wraps a scroll track in .cl-rail-box with the overlay scrollbar', () => {
        const fn = railTrackSrc.slice(railTrackSrc.indexOf('export const RailTrack: React.FC'));
        expect(fn.length).toBeGreaterThan(100);
        expect(dash).toContain("import { RailTrack } from './rail/RailTrack';");
        expect(fn).toContain("'cl-rail-track cl-rail-track--scroll'");
        expect(fn).toContain('<div className="cl-rail-box">');
        expect(fn).toContain('<RailScrollbar target={track} />');
    });

    it('the nav column is allowed to shrink its child (min-height:0) and the rhythm tightens on short windows', () => {
        expect(nav).toContain("minHeight: 0 }}");
        expect(css).toMatch(/@media \(max-height: 640px\)\{\s*:root\{--cl-rail-gap:10px;--cl-rail-pad:10px\}/);
    });

    it('the add-server menu stays position:fixed so the clipping box cannot cut it', () => {
        expect(nav).not.toContain('absolute left-full top-0 ml-3');
        expect(nav).toContain("position: 'fixed', left: addServerMenuPos");
    });

    it('every server tile is addressable for scroll-into-view', () => {
        expect(sortable).toContain('data-rail-id={id}');
        expect(dash).toContain('[data-rail-id="srv:${activeRailServerId}"]');
        expect(dash).toContain('scrollTopToReveal(');
    });

    it('positive control: the extractor really does see the nav', () => {
        expect(nav).toContain('<Mascot');
        expect(nav).not.toContain('Main Content Area');
    });
});

describe('rail box — overlay scrollbar CSS', () => {
    const block = css.slice(css.indexOf('/* ── Rail server box'), css.indexOf('/* Short windows: tighten'));
    const rule = (sel: string, src = block) => {
        const i = src.indexOf(sel + '{');
        expect(i, sel).toBeGreaterThan(-1);
        return src.slice(i, src.indexOf('}', i));
    };
    const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '');

    it('the box scrolls itself and hides the native bar (the app-wide `* {scrollbar-width: thin}` would show it)', () => {
        expect(css).toMatch(/\*\s*\{\s*scrollbar-width:\s*thin;/); // why the explicit none is needed
        const r = rule('.cl-rail-track--scroll');
        expect(r).toContain('overflow-y:auto');
        expect(r).toContain('scrollbar-width:none');
        expect(block).toContain('.cl-rail-track--scroll::-webkit-scrollbar{display:none');
    });

    it('no fade: nothing is masked at the top/bottom', () => {
        expect(block).not.toMatch(/mask-image/);
    });

    it('the strip is flush at the box\'s far-left edge, clipped to its rounded corners, measurable when empty', () => {
        const r = rule('.cl-rail-sb');
        expect(r).toContain('left:0');
        expect(r).toContain('visibility:hidden');
        expect(noComments(r)).not.toContain('display:none');
        expect(rule('.cl-rail-box')).toMatch(/border-radius:16px;overflow:hidden/);
        // the resting bar starts right inside the 1px inset border, no gap
        expect(rule('.cl-rail-sb-thumb::after')).toMatch(/left:1px;width:2px/);
    });

    it('the grab strip is no wider than the box padding, so it can never cover a tile', () => {
        const strip = Number(/width:(\d+)px/.exec(rule('.cl-rail-sb'))![1]);
        const hit = Number(/width:(\d+)px/.exec(rule('.cl-rail-sb-thumb'))![1]);
        const pad = Number(/\.cl-rail-track\{[^}]*padding:(\d+)px/.exec(css)![1]);
        expect(strip).toBeLessThanOrEqual(6);
        expect(strip).toBeLessThanOrEqual(pad);
        expect(hit).toBeLessThanOrEqual(pad);
    });

    it('hidden at rest: the bar is opacity 0 unless a rule shows it', () => {
        expect(rule('.cl-rail-sb-thumb::after')).toContain('opacity:0');
    });

    it('shown on box hover, while scrolling, and while dragging — exactly those three', () => {
        const shown = /([^{}]+)\{opacity:1\}/.exec(noComments(block))![1].split(',').map(x => x.trim());
        expect(shown.sort()).toEqual([
            '.cl-rail-box:hover .cl-rail-sb-thumb::after',
            '.cl-rail-sb.is-drag .cl-rail-sb-thumb::after',
            '.cl-rail-sb.is-scrolling .cl-rail-sb-thumb::after',
        ]);
    });

    it('expanded (2px → 5px, from the left edge) ONLY over the strip itself or mid-drag — never on box hover', () => {
        const m = /(\.cl-rail-sb:hover \.cl-rail-sb-thumb::after,\s*\.cl-rail-sb\.is-drag \.cl-rail-sb-thumb::after)\{\s*width:5px/.exec(block);
        expect(m).not.toBeNull();
        // no width change is keyed on the box's hover
        expect(block).not.toMatch(/\.cl-rail-box:hover[^{]*\{[^}]*width/);
        // left edge unchanged when expanded: grows rightwards
        expect(block).not.toMatch(/\.cl-rail-sb:hover[^{]*\{[^}]*left:/);
    });

    it('positive control: the gating assertions catch a box-hover expansion and an always-visible bar', () => {
        const expandOnBox = block + '\n.cl-rail-box:hover .cl-rail-sb-thumb::after{width:5px}';
        expect(expandOnBox).toMatch(/\.cl-rail-box:hover[^{]*\{[^}]*width/);
        const alwaysOn = block.replace(/opacity:0;/, 'opacity:1;');
        expect(/\.cl-rail-sb-thumb::after\{[^}]*/.exec(alwaysOn)![0]).not.toContain('opacity:0');
    });

    it('fades (opacity/width transition), and none of it under reduced motion', () => {
        expect(rule('.cl-rail-sb-thumb::after')).toMatch(/transition:opacity \.12s/);
        expect(block).toMatch(/prefers-reduced-motion: reduce\)\{\s*\.cl-rail-sb-thumb::after\{transition:none\}/);
    });
});

describe('rail column — always centred, never shifts for the scrollbar', () => {
    // Painted geometry: the 40px icon sits 2px inside the 44px button and has
    // a 1px outer ring (paints button+1 .. button+43); the box's visible edge
    // is its 1px INSET border. Cross-checked on real pixels at DPR 2 and 4 in
    // the folders harness (pixmeasure.py).
    const TILE = 44, ICON_INSET = 2, RING = 1, BORDER = 1;
    const pad = () => Number(/\.cl-rail-track\{[^}]*padding:(\d+)px/.exec(css)![1]);
    const painted = (padL: number, padR: number) => {
        const width = padL + TILE + padR;
        return {
            left: (padL + ICON_INSET - RING) - BORDER,
            right: (width - BORDER) - (padL + TILE - ICON_INSET + RING),
        };
    };

    it('there is no overflow-driven layout at all (no column shift, no glide)', () => {
        expect(css).not.toContain('data-rail-overflow');
        expect(railScrollbarSrc).not.toContain('data-rail-overflow');
        const box = css.slice(css.indexOf('/* ── Rail server box'), css.indexOf('/* Short windows: tighten'));
        expect(box).not.toMatch(/padding-left:/);
        expect(box).not.toMatch(/margin-left:/);
        expect(box).not.toMatch(/transition:padding|transition:margin/);
    });

    it('the tile column is centred on painted pixels (one padding, both sides)', () => {
        const g = painted(pad(), pad());
        expect(g.left).toBe(g.right);
        expect(g.left).toBe(6);
    });

    it('positive control: the old overflow geometry (padding-left 11) is off-centre in the box', () => {
        const g = painted(11, pad());
        expect(g.left).not.toBe(g.right);
    });

    it('the nav padding lives in CSS (no inline padding) and is symmetric', () => {
        const nav = railNav(dash);
        expect(nav).not.toMatch(/padding:\s*'var\(--cl-rail-pad/);
        expect(css).toMatch(/\.app-rail\{\s*padding:var\(--cl-rail-pad,16px\) 0;\s*\}/);
    });

    it('the pill re-measures on padding changes: RailTrack observes the BORDER box', () => {
        expect(railTrackSrc).toContain("ro.observe(el, { box: 'border-box' })");
    });

    it('scrolling shows the bar via a class (no React re-render), cleared after SCROLL_SHOW_MS', () => {
        expect(railScrollbarSrc).toContain("strip.classList.add('is-scrolling')");
        expect(railScrollbarSrc).toContain("strip.classList.remove('is-scrolling')");
        expect(railScrollbarSrc).toContain('SCROLL_SHOW_MS');
        expect(SCROLL_SHOW_MS).toBe(800);
        // re-evaluated on resize (ResizeObserver) and when tiles are added/removed (MutationObserver)
        expect(railScrollbarSrc).toContain('new ResizeObserver(sync)');
        expect(railScrollbarSrc).toContain('new MutationObserver(');
    });

    it('overflow predicate: threshold is >1px, and it alone decides whether a bar exists', () => {
        expect(railOverflows(300, 300)).toBe(false);
        expect(railOverflows(301, 300)).toBe(false);
        expect(railOverflows(301.5, 300)).toBe(true);
        expect(railOverflows(934, 223)).toBe(true);
        for (const [sh, ch] of [[300, 300], [301, 300], [302, 300], [900, 200]] as const) {
            expect(thumbGeometry(0, sh, ch, 200).visible).toBe(railOverflows(sh, ch));
        }
    });
});

describe('RailScrollbar geometry', () => {
    it('hides when the content fits', () => {
        expect(thumbGeometry(0, 300, 300, 280).visible).toBe(false);
        expect(thumbGeometry(0, 300.5, 300, 280).visible).toBe(false);
    });
    it('thumb length is the visible fraction, floored at the minimum', () => {
        expect(thumbGeometry(0, 600, 300, 280).height).toBeCloseTo(140);
        expect(thumbGeometry(0, 6000, 300, 280).height).toBe(28);
    });
    it('thumb sits at the top / bottom of the track at the scroll extremes', () => {
        const top = thumbGeometry(0, 600, 300, 280);
        const bottom = thumbGeometry(300, 600, 300, 280);
        expect(top.top).toBe(0);
        expect(bottom.top + bottom.height).toBeCloseTo(280);
        // over-scroll (rubber band) never leaves the track
        expect(thumbGeometry(999, 600, 300, 280).top + thumbGeometry(999, 600, 300, 280).height).toBeLessThanOrEqual(280.0001);
    });
    it('dragging the thumb maps linearly onto scrollTop and clamps', () => {
        // 600 content in 300 window, 280 track, 140 thumb → travel 140, range 300
        expect(scrollTopForThumbDrag(0, 70, 600, 300, 280, 140)).toBeCloseTo(150);
        expect(scrollTopForThumbDrag(0, 9999, 600, 300, 280, 140)).toBe(300);
        expect(scrollTopForThumbDrag(100, -9999, 600, 300, 280, 140)).toBe(0);
    });
    it('clicking the track centres the thumb on the click', () => {
        expect(scrollTopForTrackClick(140, 600, 300, 280, 140)).toBeCloseTo(150); // thumb centred mid-track
        expect(scrollTopForTrackClick(0, 600, 300, 280, 140)).toBe(0);
        expect(scrollTopForTrackClick(280, 600, 300, 280, 140)).toBe(300);
    });
    it('positive control: a wrong (inverted) mapping would fail the extremes', () => {
        const inverted = (st: number) => 280 - thumbGeometry(st, 600, 300, 280).top;
        expect(inverted(0)).not.toBe(thumbGeometry(0, 600, 300, 280).top);
    });
});

describe('scrollTopToReveal', () => {
    // visible box: top 100, height 200 (viewport coords); margin 12
    it('does nothing when the tile is fully inside', () => {
        expect(scrollTopToReveal(50, 100, 200, 150, 44)).toBe(50);
    });
    it('scrolls up by the overhang when the tile is above the box', () => {
        expect(scrollTopToReveal(300, 100, 200, 60, 44)).toBe(300 + (60 - 100) - 12);
    });
    it('scrolls down by the overhang when the tile is below the box', () => {
        expect(scrollTopToReveal(0, 100, 200, 330, 44)).toBe((330 - 100) + 44 - (200 - 12));
    });
    it('never returns a negative scrollTop', () => {
        expect(scrollTopToReveal(5, 100, 200, 50, 44)).toBe(0);
    });
    it('positive control: a tile partly clipped at the bottom edge IS moved', () => {
        expect(scrollTopToReveal(0, 100, 200, 270, 44)).toBeGreaterThan(0);
    });
});

describe('title-bar wordmark', () => {
    it('Windows and Linux put it on the left, macOS on the right', () => {
        expect(wordmarkSide('windows', '')).toBe('left');
        expect(wordmarkSide('linux', '')).toBe('left');
        expect(wordmarkSide('mac', '')).toBe('right');
    });
    it('falls back to the user agent only when the preload gave no platform', () => {
        expect(wordmarkSide(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('right');
        expect(wordmarkSide(undefined, 'Mozilla/5.0 (Windows NT 10.0)')).toBe('left');
        // preload wins over a contradictory UA
        expect(wordmarkSide('windows', 'Macintosh')).toBe('left');
    });

    it('is mounted inside the Dashboard drag-region title bar, ahead of the Linux window controls', () => {
        const bar = dash.indexOf('<div className="drag-region h-[34px]');
        expect(bar).toBeGreaterThan(-1);
        const wm = dash.indexOf('<TitleBarWordmark />', bar);
        const ctrl = dash.indexOf('<WindowControls />', bar);
        expect(wm).toBeGreaterThan(bar);
        expect(wm).toBeLessThan(ctrl);
        // and nothing between the bar and the wordmark closes the bar
        expect(dash.slice(bar, wm)).not.toContain('</div>');
    });

    it('is draggable + unselectable text with no logo, and never no-drag', () => {
        const comp = readFileSync(join(__dirname, 'TitleBarWordmark.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(comp).not.toMatch(/<img|<svg|cipherlineMark|no-drag/);
        const rule = css.slice(css.indexOf('.cl-titlebar-wordmark{'));
        const decl = rule.slice(0, rule.indexOf('}'));
        expect(decl).toContain('font-family:var(--cl-font-display)');
        expect(decl).toContain('user-select:none');
        expect(decl).not.toContain('app-region:no-drag');
        // dimmed a step below the muted text colour
        const op = /opacity:([0-9.]+)/.exec(decl);
        expect(op, 'wordmark must set an opacity').not.toBeNull();
        expect(Number(op![1])).toBeLessThan(0.7);
        expect(Number(op![1])).toBeGreaterThanOrEqual(0.4); // still legible
    });
});
