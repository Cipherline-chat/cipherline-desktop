/* "Copy link" must sit vertically centred in the invite step's link row.

   Root cause being pinned: the kit's solid button is a cap plus two depth
   sheets hanging 2px/4px BELOW it that layout never sees, so a flex row's
   `align-items: center` centred only the cap and the visible button sat ~2px
   low. invite.css reserves the ledge and compensates the two states that change
   the silhouette. The real pixel measurement lives in harness/onboarding-shots.mjs;
   this guards the rules it depends on. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const INVITE_CSS = readFileSync(resolve(__dirname, 'invite.css'), 'utf8');
const KIT_CSS = readFileSync(resolve(__dirname, '..', '..', '..', 'styles', 'cl-kit.css'), 'utf8');
const INVITE_TSX = readFileSync(resolve(__dirname, 'InviteStep.tsx'), 'utf8');

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list contains exactly `selector`, merged in source order. */
function decls(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of strip(css).matchAll(re)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

describe('decls() helper', () => {
  it('reads a rule, merges repeats, and ignores comments (positive + negative control)', () => {
    const css = '/* .a { x: 1 } */ .a { color: red; } .b, .a { align-items: center; }';
    expect(decls(css, '.a')).toEqual({ color: 'red', 'align-items': 'center' });
    expect(decls(css, '.c')).toEqual({});
  });
});

describe('invite link row: Copy link is vertically centred', () => {
  it('.lbox is a flex row that centres its children', () => {
    const d = decls(INVITE_CSS, '.ob .ob-invite .lbox');
    expect(d.display).toBe('flex');
    expect(d['align-items']).toBe('center');
  });

  it('.ob-inv-btn centres its icon and label (inline-flex, align-items: center, gap)', () => {
    const d = decls(INVITE_CSS, '.ob .ob-invite .ob-inv-btn');
    expect(d.display).toBe('inline-flex');
    expect(d['align-items']).toBe('center');
    expect(d.gap).toMatch(/^\d+px$/);
  });

  it('the kit cap it sits in is itself a centring inline-flex (ClButton is not modified)', () => {
    const cap = decls(KIT_CSS, '.cap');
    expect(cap.display).toBe('inline-flex');
    expect(cap['align-items']).toBe('center');
    const label = decls(KIT_CSS, '.cap>span');
    expect(label['align-items']).toBe('center');
  });

  it('reserves the depth-sheet ledge so the row centres cap + ledge as one unit', () => {
    const d = decls(INVITE_CSS, '.ob .ob-invite .lbox .clb');
    expect(d['margin-bottom']).toMatch(/var\(--o2/);
    expect(d.flex).toBe('none');
  });

  it('the ledge the button hangs below its cap is what the kit actually draws (--o2 = 4px, sheets translated by --o1/--o2)', () => {
    expect(decls(KIT_CSS, '.clb')['--o2']).toBe('4px');
    expect(decls(KIT_CSS, '.clb .l2').transform).toBe('translateY(var(--o2))');
  });

  it('the pressed states (Copied, and the disabled loading link) are nudged up by half the press depth', () => {
    for (const sel of ['.ob .ob-invite .lbox .clb.dis', '.ob .ob-invite .lbox .clb.is-done']) {
      expect(decls(INVITE_CSS, sel).transform).toMatch(/translateY\(calc\(var\(--o1, 2px\) \/ -2\)\)/);
    }
    // the kit really does press the cap by --o1 in both
    expect(decls(KIT_CSS, '.clb.dis .cap').transform).toMatch(/translateY\(2px\)/);
    expect(decls(INVITE_CSS, '.ob .ob-invite .clb.is-done .cap').transform).toBe('translateY(2px)');
  });

  it('the markup keeps the pieces the CSS targets', () => {
    expect(INVITE_TSX).toMatch(/<div className="lbox">/);
    expect(INVITE_TSX).toMatch(/<ClButton size="sm"[^>]*className=\{copied \? 'is-done' : undefined\}/);
    expect(INVITE_TSX).toMatch(/<span className="ob-inv-btn">/);
    expect(INVITE_TSX).toMatch(/disabled=\{!referral\}/);
  });

  it('NEGATIVE CONTROL: the pre-fix stylesheet (no ledge reservation) is rejected by the same check', () => {
    const before = INVITE_CSS.replace(/\.ob \.ob-invite \.lbox \.clb \{ margin-bottom:[^}]*\}/, '');
    expect(before).not.toBe(INVITE_CSS);
    expect(decls(before, '.ob .ob-invite .lbox .clb')['margin-bottom']).toBeUndefined();
    expect(decls(INVITE_CSS, '.ob .ob-invite .lbox .clb')['margin-bottom']).toBeDefined();
  });
});
