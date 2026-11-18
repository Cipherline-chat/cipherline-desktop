/**
 * Message text size (messageSize.ts + packages/shared MESSAGE_SIZES): an
 * allowlisted, capped, whole-message scale that every edit path carries and
 * every preview ignores.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_SIZES, isMessageSize } from '@cipherline/shared';
import { MAX_MESSAGE_SCALE, SIZE_OPTIONS, messageSizeOf, scaledPx, sizeField, sizeLabelFor, sizeScaleFor } from './messageSize';
import { withEditFont } from './messageFont';
import { editedContent } from '../channelHistoryMerge';
import { contentProblem } from '../contentValidation';
import { toPlainText } from '../messagePreviewText';

describe('the size allowlist', () => {
    it('Small / Normal / Large, with Normal sending nothing', () => {
        expect([...MESSAGE_SIZES]).toEqual(['small', 'large']);
        expect(SIZE_OPTIONS.map(o => [o.id, o.label, o.scale])).toEqual([['small', 'Small', 0.875], [null, 'Normal', 1], ['large', 'Large', 1.5]]);
        expect(sizeField(null)).toEqual({});
        expect(sizeField('large')).toEqual({ size: 'large' });
        expect(sizeLabelFor(null)).toBe('Normal');
    });

    it('sender-controlled: anything unknown is the normal size', () => {
        for (const v of ['huge', 'LARGE', 3, null, undefined, {}, '__proto__']) {
            expect(isMessageSize(v), String(v)).toBe(false);
            expect(messageSizeOf({ type: 'text', text: 'x', size: v })).toBeNull();
            expect(sizeScaleFor(v as never)).toBe(1);
        }
        expect(messageSizeOf({ type: 'text', text: 'x', size: 'small' })).toBe('small');
        expect(messageSizeOf(null)).toBeNull();
    });

    it('is capped so one message cannot take over the feed', () => {
        expect(MAX_MESSAGE_SCALE).toBe(1.5);
        for (const o of SIZE_OPTIONS) expect(sizeScaleFor(o.id)).toBeLessThanOrEqual(MAX_MESSAGE_SCALE);
        expect(scaledPx(15, 'large')).toBe('22.5px');
        expect(scaledPx(15, 'small')).toBe('13.125px');
        expect(scaledPx(15, null)).toBe('15px');
    });
});

describe('edits carry the size like the font (replace, or clear when absent)', () => {
    it('withEditFont sets / clears font AND size', () => {
        const orig = { type: 'text', text: 'a', font: 'mono', size: 'large' };
        expect(withEditFont(orig, 'serif', 'small')).toEqual({ type: 'text', text: 'a', font: 'serif', size: 'small' });
        expect(withEditFont(orig, undefined, undefined)).toEqual({ type: 'text', text: 'a' });
        expect(withEditFont(orig, 'mono', 'gigantic')).toEqual({ type: 'text', text: 'a', font: 'mono' });
    });
    it('editedContent (channel edits) passes the size through', () => {
        expect(editedContent({ type: 'text', text: 'old' }, 'new', undefined, undefined, 'large')).toEqual({ type: 'text', text: 'new', size: 'large' });
        expect(editedContent({ type: 'text', text: 'old', size: 'large' }, 'new')).toEqual({ type: 'text', text: 'new' });
    });
    it('every edit-apply site passes the edit\'s size (DM inbound, Dashboard live DM, channel)', () => {
        const dm = readFileSync(join(__dirname, '..', 'dmInbound.ts'), 'utf8');
        const dash = readFileSync(join(__dirname, '..', '..', 'components', 'Dashboard.tsx'), 'utf8');
        expect(dm).toContain('withEditFont({ ...currentThread[i].content, text: m.content.text }, m.content.font, m.content.size)');
        expect(dash).toContain('withEditFont({ ...currentThread[targetIdx].content, text: m.content.text }, m.content.font, m.content.size)');
        expect(dash).toContain('editedContent(thread[idx].content, content.text, content.channel_refs, content.font, content.size, content)');
    });
});

describe('validation and previews', () => {
    it('contentValidation refuses only a non-string / absurd size (unknown ids render normal)', () => {
        expect(contentProblem({ type: 'text', text: 'x', size: 'large' })).toBeNull();
        expect(contentProblem({ type: 'text', text: 'x', size: 'future-size' })).toBeNull();
        expect(contentProblem({ type: 'text', text: 'x', size: 7 })).not.toBeNull();
        expect(contentProblem({ type: 'text', text: 'x', size: 'x'.repeat(40) })).not.toBeNull();
        expect(contentProblem({ type: 'edit', target_id: 'm1', text: 'x', size: ['large'] })).not.toBeNull();
    });
    it('toPlainText (notifications, previews) never sees the size', () => {
        expect(toPlainText('**hi**')).toBe('hi');
        const src = readFileSync(join(__dirname, '..', 'messagePreviewText.ts'), 'utf8') + readFileSync(join(__dirname, 'plainText.ts'), 'utf8');
        expect(src).not.toMatch(/size/i);
    });
});
