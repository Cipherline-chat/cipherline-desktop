// @vitest-environment jsdom
/**
 * Divider rows: label shown exactly as typed (no automatic decoration), every
 * style (and an unknown one) draws, managers get a real hit area, members get
 * an inert plain row, and no divider is ever marked or dimmed as "hidden".
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DIVIDER_STYLES, isLabelDividerStyle } from '@cipherline/shared';
import { ChannelDividerVisual, DividerHitArea, DIVIDER_HIT_MIN_PX } from './ChannelDividerRow';
import type { DividerInfo } from '../../hooks/useServers';

const d = (style: string, label: string | null = 'Test'): Pick<DividerInfo, 'style' | 'label' | 'color'> =>
    ({ style: style as DividerInfo['style'], label, color: null });
const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const vis = (divider: Parameters<typeof ChannelDividerVisual>[0]['divider']) => html(h(ChannelDividerVisual, { divider }));
const row = (interactive: boolean, extra: Partial<React.ComponentProps<typeof DividerHitArea>> = {}) =>
    html(h(DividerHitArea, { divider: d('line', null), interactive, ariaLabel: 'Divider', tabIndex: 0, ...extra }));

describe('ChannelDividerVisual', () => {
    it.each(DIVIDER_STYLES.filter(isLabelDividerStyle))('%s: the label is exactly as typed - no added stars, no forced capitals', (style) => {
        const out = vis(d(style, 'Test'));
        expect(out).toContain('>Test<');
        expect(out).not.toMatch(/[✦✧✨]/);
        expect(out).not.toContain('uppercase');
    });

    it('an emoji pasted into the label is kept as typed', () => {
        expect(vis(d('header', '✨ Crafts ✨'))).toContain('✨ Crafts ✨');
    });

    it('an unknown (newer) style draws as a line, never nothing', () => {
        expect(vis(d('wavy', null))).toContain('h-px');
    });

    it('the label styles use the divider colour', () => {
        const out = vis({ style: 'pill', label: 'x', color: '#25e0c8' });
        expect(out).toContain('rgba(37, 224, 200');
    });
});

describe('DividerHitArea', () => {
    it('managers: >= 24px minimum height, pointer affordance, hover wash, keyboard stop', () => {
        expect(DIVIDER_HIT_MIN_PX).toBeGreaterThanOrEqual(24);
        const out = row(true);
        expect(out).toContain(`min-h-[${DIVIDER_HIT_MIN_PX}px]`);
        expect(out).toContain('cursor-grab');
        expect(out).toContain('hover:bg-');
        expect(out).toContain('tabindex="0"');
        expect(out).toContain('data-divider-interactive="true"');
    });

    it('members: inert - no min height, cursor, hover or tab stop', () => {
        const out = row(false);
        expect(out).not.toContain('min-h-');
        expect(out).not.toContain('cursor-');
        expect(out).not.toContain('hover:');
        expect(out).not.toContain('tabindex');
        expect(out).toContain('data-divider-interactive="false"');
    });

    it('line + dots visuals hold their spacing as padding (a child margin would collapse out of the row, leaving a 1px hit area)', () => {
        for (const style of ['line', 'dots']) {
            const out = vis(d(style, null));
            expect(out).not.toMatch(/class="[^"]*\bmy-/);
            expect(out).toMatch(/py-/);
        }
    });

    it('every divider is drawn as-is: no hidden mark, no tooltip, never dimmed (owner 2026-11-24)', () => {
        for (const style of DIVIDER_STYLES) {
            const out = html(h(DividerHitArea, { divider: d(style, 'x'), interactive: true, ariaLabel: 'Divider' }));
            expect(out).not.toContain('divider-hidden-mark');
            expect(out).not.toContain('data-hidden-from-members');
            expect(out).not.toMatch(/opacity/);
        }
    });

    it('a text divider with no words still draws (a hairline) rather than an empty box; with words it is the words', () => {
        expect(vis(d('text', null))).toContain('h-px');
        expect(vis(d('text', ''))).toContain('h-px');
        expect(vis(d('text', 'Words'))).toContain('>Words<');
    });
});
