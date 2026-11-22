/**
 * Inline emoji must never lose their tops (owner, 2026-11-18: "emojis sent in
 * the chat when sent with text the top of them gets cut off").
 *
 * A native emoji in message text is drawn 1.25em in a line sized for 1em text
 * (ChatPane renderSegmentWithEmojis; line-height 'normal'), so its glyph rises
 * ~0.2em above the line box (Noto: 3 px at 15 px; more with a taller face such
 * as Windows' Segoe UI Emoji). The row body used to be `overflow: hidden`, and
 * the long-message preview clipped at its top edge too, so every emoji on a
 * message's first line was cut flat. jsdom has no layout, so this pins the CSS
 * contract; the pixels are measured in Chromium by harness/emoji-inline-check.mjs
 * (every emoji vs every clipping ancestor at the four window sizes, with a
 * positive control that must clip).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_BODY_CLASS } from './messageSize';

const desktop = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(desktop, ...p), 'utf8');
/** The declarations of one rule (`selector{...}`), whitespace-collapsed. */
function rule(css: string, selector: string): string {
    const at = css.indexOf(`${selector}{`);
    expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
    return css.slice(at + selector.length + 1, css.indexOf('}', at)).replace(/\s+/g, '');
}

describe('the message body never clips vertically', () => {
    it('the body class has no vertical clip of its own', () => {
        const classes = MESSAGE_BODY_CLASS.split(/\s+/);
        expect(classes).toContain('cl-msg-body');
        // Tailwind classes that clip both axes (or y) would cut the emoji again.
        for (const c of classes) expect(c).not.toMatch(/^(overflow(-y)?-(hidden|clip|auto|scroll)|truncate|line-clamp-\d+)$/);
    });

    it('.cl-msg-body clips sideways only, and keeps the block formatting context', () => {
        const r = rule(read('src', 'styles', 'formatting.css'), '.cl-msg-body');
        expect(r).toContain('overflow-y:visible');
        expect(r).toContain('overflow-x:clip');
        // `overflow: hidden` made the body a BFC (child margins stay inside); flow-root keeps that.
        expect(r).toContain('display:flow-root');
        expect(r).not.toMatch(/(^|;)overflow:|contain:|clip-path|mask/);
    });

    it('ChatPane draws the text body with that class (not a hand-written copy)', () => {
        const src = read('src', 'components', 'ChatPane.tsx');
        expect(src).toContain('className={MESSAGE_BODY_CLASS}');
        expect(src).not.toContain('break-words whitespace-pre-wrap overflow-hidden');
    });
});

describe('the long-message preview clips the bottom only', () => {
    const r = rule(read('src', 'styles', 'long-message.css'), '.lm-text--clipped');
    it('the clip edge sits --lm-ink above the text without moving it', () => {
        expect(r).toMatch(/--lm-ink:\.?\d/);
        expect(r).toContain('padding-top:var(--lm-ink)');
        expect(r).toContain('margin-top:calc(-1*var(--lm-ink))');
        // border-box (Tailwind preflight): the padding is added to the cap, so 11.5em of text still shows.
        // Relaxed line spacing scales the 11.5em with --cl-msg-leading-mult (1 by default).
        expect(r).toContain('max-height:calc(11.5em*var(--cl-msg-leading-mult,1)+var(--lm-ink))');
    });
    it('the room is at least as tall as an inline emoji rises (~0.4em with a tall face)', () => {
        const ink = parseFloat(/--lm-ink:([\d.]+)em/.exec(r)?.[1] ?? '0');
        expect(ink).toBeGreaterThanOrEqual(0.4);
    });
});
