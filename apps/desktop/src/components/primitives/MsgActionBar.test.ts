/**
 * Message hover toolbar placement: the bar is anchored at the hovered row's
 * TOP-RIGHT and centred on its top edge — half inside the row, half poking out
 * above it (it used to float a full bar-height above, at -top-11).
 *
 * The desktop suite runs in a node environment with no layout engine, so this
 * checks what node CAN prove:
 *   1. the component's markup/classes/semantics (react-dom/server),
 *   2. the stylesheet's placement rules and their ARITHMETIC (top:0 +
 *      translateY(-50%) => the poke-out is half the bar height, which must fit in
 *      the feed's top padding or the first message's bar is clipped), parsed
 *      from index.css and ChatPane,
 *   3. ChatPane's wiring (source scan, same technique as the other
 *      ChatPane.*.test.ts files) — every action and permission rule survived.
 * Real-browser geometry (bar centred on each row's top edge with ~50% overlap,
 * painted above the previous message, not clipped on the first row; the hover
 * handoff onto the bar's upper half; keyboard; reduced motion; the old placement
 * failing the same checks) is harness/msgbar-shots.mjs.
 *
 * Section 2 has NEGATIVE CONTROLS: the same analyzer is run over deliberately
 * broken copies of the stylesheet and must report violations.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { MsgActionBar, MSG_ACTION_BAR_CLASS } from './MsgActionBar';
import { MsgBarBtn } from './MsgBarBtn';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'index.css'), 'utf8');
const chatPane = readFileSync(join(here, '..', 'ChatPane.tsx'), 'utf8');

// ── 1. component ─────────────────────────────────────────────────────────────
describe('MsgActionBar markup', () => {
    const html = renderToStaticMarkup(
        React.createElement(
            MsgActionBar,
            null,
            React.createElement(MsgBarBtn, { icon: 'r', label: 'React', onClick: () => {} }),
            React.createElement(MsgBarBtn, { icon: 'p', label: 'Reply', onClick: () => {} }),
        ),
    );

    it('carries the inline placement classes', () => {
        expect(MSG_ACTION_BAR_CLASS).toBe('msgbar msgbar-inline');
        expect(html).toContain('class="msgbar msgbar-inline"');
    });

    it('is a labelled group of real, tabbable <button>s (keyboard access)', () => {
        expect(html).toContain('role="group"');
        expect(html).toContain('aria-label="Message actions"');
        const buttons = html.match(/<button\b[^>]*>/g) ?? [];
        expect(buttons).toHaveLength(2);
        for (const b of buttons) {
            expect(b).toContain('type="button"');
            expect(b).not.toContain('tabindex="-1"');
        }
        expect(html).toContain('aria-label="React"');
        expect(html).toContain('aria-label="Reply"');
    });

    it('NEGATIVE CONTROL: no above-the-row utility classes are emitted', () => {
        expect(html).not.toMatch(/-top-\d/);
        expect(html).not.toMatch(/\bright-14\b/);
    });
});

// ── 2. stylesheet geometry ───────────────────────────────────────────────────
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first rule whose selector is exactly `selector`, comments removed. */
function ruleBody(source: string, selector: string): string | null {
    const clean = stripComments(source);
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(clean);
    return m ? m[1] : null;
}
const px = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
    return m ? Number(m[1]) : null;
};
const decl = (body: string | null, prop: string): string | undefined =>
    body?.split(';').map(d => d.trim()).find(d => d.startsWith(`${prop}:`))?.slice(prop.length + 1).trim();
const cssVar = (source: string, name: string): number | null => {
    const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(stripComments(source));
    return m ? px(m[1]) : null;
};

/** ChatPane's scroller: the clip edge for anything poking out above the first row. */
function feedTopPaddingPx(source: string): number | null {
    const m = /className="flex-1 overflow-y-auto overflow-x-hidden [^"]*\bpy-(\d+)\b/.exec(source);
    return m ? Number(m[1]) * 4 : null; // tailwind spacing: 1 unit = 4px
}

/** Everything that must hold for a bar straddling the row's top edge. */
function analyzeBarCss(source: string, feedPad: number | null): string[] {
    const v: string[] = [];
    const bar = ruleBody(source, '.msgbar.msgbar-inline');
    if (!bar) return ['missing .msgbar.msgbar-inline rule'];
    if (decl(bar, 'position') !== 'absolute') v.push('bar is not position:absolute');
    const top = decl(bar, 'top');
    if (!(top === '0' || px(top) === 0)) v.push(`bar must be anchored at top: 0 (the row's top edge), got ${decl(bar, 'top')}`);
    if (decl(bar, 'bottom') !== undefined) v.push('bar sets `bottom` (anchor with top + translateY only)');
    if (decl(bar, 'transform')?.replace(/\s/g, '') !== 'translateY(-50%)') v.push(`bar must be centred on the edge with translateY(-50%), got ${decl(bar, 'transform')}`);
    const right = px(decl(bar, 'right'));
    if (right === null || right < 0) v.push(`right offset must be a non-negative px value, got ${decl(bar, 'right')}`);
    const z = Number(decl(bar, 'z-index'));
    if (!(z >= 30)) v.push(`z-index must be >= 30 so the bar paints over the previous message, got ${decl(bar, 'z-index')}`);

    const btn = cssVar(source, '--msgbar-btn');
    const pad = cssVar(source, '--msgbar-pad');
    if (btn === null || pad === null) return [...v, 'sizing custom properties missing'];
    const BORDER = 1; // `.msgbar { border: 1px solid ... }`
    const barH = btn + 2 * pad + 2 * BORDER;
    if (feedPad === null) v.push('could not read the feed scroller top padding from ChatPane');
    else if (barH / 2 > feedPad) v.push(`poke-out ${barH / 2}px exceeds the feed's ${feedPad}px top padding: the first message's bar would be clipped`);
    if (ruleBody(source, '.msg-row')) v.push('.msg-row min-height rule should be gone (the bar no longer needs a taller row)');
    return v;
}

describe('.msgbar-inline stylesheet', () => {
    const feedPad = feedTopPaddingPx(chatPane);

    it("meta: ChatPane's feed scroller padding is readable (20px)", () => {
        expect(feedPad).toBe(20);
    });

    it("anchors top-right, centred on the row's top edge, above neighbours, and fits the feed padding", () => {
        expect(analyzeBarCss(css, feedPad)).toEqual([]);
    });

    it('the bar is full size (owner 2026-10-13): 28px buttons, 16px glyphs, 36px bar, 18px poking out', () => {
        const barH = cssVar(css, '--msgbar-btn')! + 2 * cssVar(css, '--msgbar-pad')! + 2;
        expect(cssVar(css, '--msgbar-btn')).toBe(28);
        expect(barH).toBe(36);
        expect(barH / 2).toBe(18);
        expect(stripComments(css)).toMatch(/\.msgbar-inline \.msgbar-btn svg\s*\{\s*width:\s*16px;\s*height:\s*16px;/);
    });

    it('NEGATIVE CONTROL: the old fully-above placement (top: -44px, no transform) is detected', () => {
        const broken = css.replace(/(\.msgbar\.msgbar-inline\s*\{\s*position:\s*absolute;\s*)top:\s*0;(\s*right:\s*8px;\s*)transform:\s*translateY\(-50%\);/, '$1top: -44px;$2');
        expect(broken).not.toBe(css);
        const v = analyzeBarCss(broken, feedPad);
        expect(v.some(x => x.includes('top: 0'))).toBe(true);
        expect(v.some(x => x.includes('translateY(-50%)'))).toBe(true);
    });

    it('NEGATIVE CONTROL: the previous bottom-right-inside placement is detected', () => {
        const broken = css.replace(/top:\s*0;(\s*right:\s*8px;\s*)transform:\s*translateY\(-50%\);/, 'bottom: 1px;$1');
        expect(broken).not.toBe(css);
        expect(analyzeBarCss(broken, feedPad).some(x => x.includes('`bottom`'))).toBe(true);
    });

    it('NEGATIVE CONTROL: a bar too tall for the feed padding (first row would clip) is detected', () => {
        const broken = css.replace(/--msgbar-btn:\s*\d+px;/, '--msgbar-btn: 40px;');
        expect(broken).not.toBe(css);
        expect(analyzeBarCss(broken, feedPad).some(x => x.includes('first message'))).toBe(true);
        // and a feed that lost its top padding is equally caught
        expect(analyzeBarCss(css, 0).some(x => x.includes('first message'))).toBe(true);
    });

    it('NEGATIVE CONTROL: a low z-index (bar would paint under the previous message) is detected', () => {
        const broken = css.replace(/(\.msgbar\.msgbar-inline\s*\{[^}]*?)z-index:\s*30;/, '$1z-index: 1;');
        expect(broken).not.toBe(css);
        expect(analyzeBarCss(broken, feedPad).some(x => x.includes('z-index'))).toBe(true);
    });

    it('motion: short fade only, and none under prefers-reduced-motion', () => {
        const bar = stripComments(ruleBody(css, '.msgbar.msgbar-inline') ?? '');
        expect(bar).toContain('animation: msgbar-inline-in');
        const kf = /@keyframes msgbar-inline-in\s*\{([\s\S]*?)\}\s*\}/.exec(stripComments(css))?.[1] ?? '';
        expect(kf).not.toContain('transform'); // no travel
        // the reduced-motion block that targets the inline bar turns the animation off
        const rm = [...stripComments(css).matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/g)].map(m => m[1]);
        expect(rm.some(b => b.includes('.msgbar.msgbar-inline') && /animation:\s*none/.test(b))).toBe(true);
    });

    it('keyboard: the bar buttons have a visible focus-visible ring', () => {
        expect(stripComments(css)).toMatch(/\.msgbar-btn:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    });
});

// ── 3. ChatPane wiring ───────────────────────────────────────────────────────
describe('ChatPane message row wiring', () => {
    const start = chatPane.indexOf('<MsgActionBar');
    const end = chatPane.indexOf('</MsgActionBar>', start);
    const bar = chatPane.slice(start, end);

    it('meta: found the bar block', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('the row keeps its original box (no min-height hack) and is not an overflow clip', () => {
        const row = /className=\{`group relative flex gap-3 py-0\.5 pr-2 pl-3 [^`]*`\}/.exec(chatPane)?.[0] ?? '';
        expect(row).not.toBe('');
        expect(row).not.toMatch(/overflow-|min-h-|msg-row/);
    });

    it('NEGATIVE CONTROL: the above-the-row placement is gone from ChatPane', () => {
        expect(chatPane).not.toMatch(/msgbar absolute/);
        expect(chatPane).not.toMatch(/'-top-11'|'-top-9'/);
    });

    it('the bar has no leave timer of its own (it would hide the bar when sliding back onto the message)', () => {
        // just the opening tag + its handler props, up to the first child
        const props = bar.slice(0, bar.indexOf('{/* React button')).replace(/\/\/.*$/gm, '');
        expect(props.length).toBeGreaterThan(0);
        expect(props).toContain('onPointerEnterBar');
        expect(props).not.toMatch(/onMouseLeave|onPointerLeave/);
        expect(props).not.toContain('setHoveredMsgId(null)');
        expect(props).not.toContain('setTimeout');
    });

    it('the row still owns hover, focus and the context menu', () => {
        expect(chatPane).toContain('hoverTimeoutRef.current = setTimeout(() => setHoveredMsgId(msg.id), 160);');
        expect(chatPane).toContain('hoverLeaveTimerRef.current = setTimeout(() => setHoveredMsgId(null), 200);');
        expect(chatPane).toContain('tabIndex={0}');
        expect(chatPane).toContain('handleContextMenu(e, msg);');
        // gating of WHEN the bar mounts is unchanged
        expect(chatPane).toContain('hoveredMsgId === msg.id && !isUnconfirmedSend(msg) && (isServerChannel || isFriend || activeChat?.type === \'group\') && (\n                                    <MsgActionBar');
    });

    it('every action and its permission gate survived the move', () => {
        for (const label of ['label="React"', 'label="Reply"', "'Unpin — stays saved to the server'", 'Save to server', "'Save for me'", 'label="Edit"', "label={isMe ? 'Delete — Shift to skip prompt'"]) {
            expect(bar).toContain(label);
        }
        expect(bar).toContain('(isServerChannel ? canReactServer : (isFriend || activeChat?.type === \'group\'))');
        expect(bar).toContain("isMe && msg.content?.type === 'text'");
        expect(bar).toContain('(isMe || (canManageMessages && !isMe))');
        expect(bar).toContain('canPinInThisChat');
        expect(bar).toContain('serverSaveActionFor(msg.id)');
        expect(bar).toContain("entryPoint: e.detail === 0 ? 'msgbar-keyboard' : 'msgbar-mouse'");
    });

    it('system / placeholder rows still render no bar (they return before the message row)', () => {
        const sys = chatPane.indexOf("if (msg.content?.type === 'system') {");
        expect(sys).toBeGreaterThan(0);
        expect(sys).toBeLessThan(start);
        // exactly one bar mount in the whole pane
        expect(chatPane.split('<MsgActionBar').length - 1).toBe(1);
    });
});
