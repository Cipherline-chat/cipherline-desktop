/**
 * SlashableIcon (mic / camera / headphones with a DRAWN mute slash) and the
 * index.css rules that draw it.
 *
 * Rendered for real with react-dom/server (this suite is node-env, no DOM).
 * The CSS half reads index.css and checks the rule text, including the
 * property the earlier "only appeared via animation" bugs lacked: the muted
 * end state is a plain declaration, valid with every animation switched off.
 * Every assertion has a control that fails it.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mic, Video, Headphones } from 'lucide-react';
import { MicIcon, CamIcon, HeadphonesIcon, SlashableSvg, SLASH_PATH } from './SlashableIcon';

const h = React.createElement;
const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/** Shape elements (path/rect) of a markup string, as attribute-sorted tags. */
const shapes = (html: string): string[] =>
    (html.match(/<(path|rect)\b[^>]*>/g) ?? []).map(t => t.replace(/\s+(class|key)="[^"]*"/g, ''));

/** The shapes inside the glyph group (the masked <g>), excluding the slash. */
const glyphOf = (html: string): string[] => {
    const g = /<g mask="[^"]*">([\s\S]*?)<\/g>/.exec(html)?.[1] ?? '';
    return shapes(g);
};

describe('SlashableIcon markup', () => {
    it('off: the svg is .is-muted and carries a pathLength-normalised cl-slash path', () => {
        const html = render(h(MicIcon, { off: true }));
        expect(html).toMatch(/<svg[^>]*class="cl-slashable is-muted"/);
        expect(html).toMatch(/<path class="cl-slash" d="m2 2 20 20" pathLength="24"><\/path>/);
        expect(html).toContain('data-off="true"');
    });
    it('on: no .is-muted (so index.css keeps the slash hidden); the slash path is still in the DOM', () => {
        const html = render(h(MicIcon, { off: false }));
        expect(html).not.toContain('is-muted');
        expect(html).toContain('class="cl-slash"');
        expect(html).toContain('data-off="false"');
        // control: the same assertion fails for the off render
        expect(render(h(MicIcon, { off: true }))).toContain('is-muted');
    });
    it('off defaults to false', () => {
        expect(render(h(CamIcon))).not.toContain('is-muted');
    });
    it('keeps the lucide box: 24 viewBox, stroke 2, round caps/joins, currentColor, aria-hidden', () => {
        const html = render(h(HeadphonesIcon, { className: 'w-4 h-4' }));
        expect(html).toContain('viewBox="0 0 24 24"');
        expect(html).toContain('width="24"');
        expect(html).toContain('height="24"');
        expect(html).toContain('stroke="currentColor"');
        expect(html).toContain('stroke-width="2"');
        expect(html).toContain('stroke-linecap="round"');
        expect(html).toContain('stroke-linejoin="round"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('fill="none"');
        // the caller's sizing classes survive alongside ours
        expect(html).toMatch(/class="cl-slashable w-4 h-4"/);
    });
    it('the slash is the same diagonal lucide draws in its *Off glyphs', () => {
        expect(SLASH_PATH).toBe('m2 2 20 20');
    });
});

describe('glyphs match the lucide glyphs they replace', () => {
    // The "on" state must be pixel-identical to what shipped, so compare the
    // shapes against lucide-react's own render of the non-Off icon.
    it.each([
        ['Mic', MicIcon, Mic],
        ['Video', CamIcon, Video],
        ['Headphones', HeadphonesIcon, Headphones],
    ] as const)('%s', (_n, Ours, Lucide) => {
        const ours = glyphOf(render(h(Ours, {})));
        const theirs = shapes(render(h(Lucide as React.ComponentType, {})));
        expect(ours.length).toBeGreaterThan(0);
        expect(ours).toEqual(theirs);
    });
    it('control: a wrong glyph does not equal lucide', () => {
        expect(glyphOf(render(h(MicIcon, {})))).not.toEqual(shapes(render(h(Video as React.ComponentType, {}))));
    });
});

describe('glyph is cut by a mask that draws with the slash', () => {
    it('the mask is referenced by the glyph group and contains a cl-slash-gap copy of the slash', () => {
        const html = render(h(MicIcon, { off: true }));
        const id = /<mask id="([^"]+)"/.exec(html)?.[1] ?? '';
        expect(id).toMatch(/^cl-slash-mask-[A-Za-z0-9_-]+$/);
        expect(html).toContain(`<g mask="url(#${id})">`);
        const mask = /<mask[\s\S]*?<\/mask>/.exec(html)![0];
        expect(mask).toMatch(/class="cl-slash cl-slash-gap" d="m2 2 20 20" pathLength="24"/);
        expect(mask).toContain('stroke="#000"');          // black = cut out
        expect(mask).toMatch(/<rect[^>]*fill="#fff"/);    // white = keep
    });
    it('gap is wider than the 2px slash so the glyph has clear space around it', () => {
        const w = Number(/class="cl-slash cl-slash-gap"[^>]*stroke-width="([\d.]+)"/.exec(render(h(MicIcon, {})))?.[1]);
        expect(w).toBeGreaterThan(2);
    });
    it('two icons on one page never share a mask id (a duplicate id would mask the wrong glyph)', () => {
        const html = render(h('div', null, h(MicIcon, {}), h(MicIcon, {}), h(CamIcon, {})));
        const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map(m => m[1]);
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3);
    });
});

describe('dash maths: 24 must cover the whole slash', () => {
    const diagonal = Math.hypot(20, 20);
    it('the raw diagonal (28.28) is LONGER than 24, so un-normalised dashes would leave a tail', () => {
        expect(diagonal).toBeGreaterThan(24);
    });
    it('every slash path (visible and gap) is pathLength-normalised to 24', () => {
        const html = render(h(SlashableSvg, { off: true, children: h('path', { d: 'M0 0' }) }));
        const slashes = html.match(/<path class="cl-slash[^"]*"[^>]*>/g) ?? [];
        expect(slashes).toHaveLength(2);
        for (const s of slashes) expect(s).toContain('pathLength="24"');
    });
});

describe('index.css: the slash draws, and is visible with animations off', () => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');

    /** Top-level rule bodies for an exact selector LIST member. */
    const rulesFor = (src: string, sel: string): string[] => {
        const out: string[] = [];
        const re = /([^{}]+)\{([^{}]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
            const sels = m[1].split(',').map(s => s.trim());
            if (sels.includes(sel)) out.push(m[2]);
        }
        return out;
    };
    const noMedia = flat.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
    const media = [...flat.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*[^{}]*)\}/g)].map(m => m[1]).join('\n');

    it('the guide rule is present verbatim: dashed 24/24 and hidden, .25s ease transition', () => {
        const [r] = rulesFor(noMedia, '.cl-slash');
        expect(r).toBeDefined();
        expect(r.replace(/\s/g, '')).toBe('stroke-dasharray:24;stroke-dashoffset:24;transition:stroke-dashoffset.25sease');
    });
    it('.is-muted zeroes the offset for the website selector AND the desktop icon', () => {
        for (const sel of ['.cl-btn.is-muted .cl-slash', '.cl-slashable.is-muted .cl-slash']) {
            const [r] = rulesFor(noMedia, sel);
            expect(r?.replace(/\s/g, ''), sel).toBe('stroke-dashoffset:0');
        }
    });
    it('the muted end state is a static declaration — no keyframes drive the slash', () => {
        expect(flat).not.toMatch(/@keyframes[^{]*slash/i);
        const decls = [...rulesFor(noMedia, '.cl-slash'), ...rulesFor(noMedia, '.cl-slashable.is-muted .cl-slash')].join(';');
        expect(decls).not.toMatch(/animation/);
        expect(decls).not.toMatch(/opacity\s*:\s*0(?![.\d])|visibility\s*:\s*hidden|display\s*:\s*none/);
    });
    it('reduced motion removes the transition and leaves the end state alone', () => {
        const [r] = rulesFor(media, '.cl-slash');
        expect(r?.replace(/\s/g, '')).toBe('transition:none;');
        // it must NOT also change the offset (that would hide a muted slash)
        expect(media).not.toMatch(/\.cl-slash[^{]*\{[^}]*stroke-dashoffset/);
    });
    it('control: a rule that only revealed the slash by animation would be caught', () => {
        const bad = '.cl-slashable.is-muted .cl-slash{animation:draw .25s forwards}';
        expect(/animation/.test(rulesFor(bad, '.cl-slashable.is-muted .cl-slash').join(';'))).toBe(true);
    });
    it('the old opacity cross-fade is gone (a stale .ico-off at opacity 0 would hide a glyph)', () => {
        expect(flat).not.toContain('.cl-ico--tog');
    });
});

describe('.cl-ico spring-back transition (icon motion part 1)', () => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    it('.cl-ico eases transform back with the design-system spring', () => {
        expect(css).toMatch(/\.cl-ico\{display:inline-flex;transition:transform \.3s var\(--cl-spring\)\}/);
        expect(css).toMatch(/--cl-spring:\s*cubic-bezier\(\.34, 1\.56, \.64, 1\)/);
    });
    it('does not fight per-icon transitions: no other .cl-ico rule sets its own transform transition', () => {
        const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const bad = [...flat.matchAll(/([^{}]*\.cl-ico\b(?![-\w])[^{},]*)\{([^{}]*)\}/g)]
            .filter(m => /transition\s*:/.test(m[2]) && !/^\s*\.cl-ico\s*$/.test(m[1]));
        expect(bad.map(m => m[1].trim())).toEqual([]);
    });
});
