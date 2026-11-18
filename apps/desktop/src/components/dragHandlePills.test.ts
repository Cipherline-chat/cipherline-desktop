import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Owner, 2026-11-18: "The drag bar that appears when you hover is two different sizes ... make the left side one the
// same size as the right side one." Both hover pills (channel list | chat, chat | member list) are 2px x 64px.
const dash = readFileSync(resolve(__dirname, 'Dashboard.tsx'), 'utf8');
const pill = (side: string) => {
    const m = dash.match(new RegExp(`data-drag-pill="${side}" className="([^"]+)"`));
    expect(m, side).toBeTruthy();
    return m![1].split(/\s+/);
};

describe('panel drag-handle hover pills', () => {
    it('left and right pills are the same size (w-[2px] h-16)', () => {
        for (const side of ['left', 'right']) {
            const cls = pill(side);
            expect(cls).toContain('w-[2px]');
            expect(cls).toContain('h-16');
        }
    });
    it('the left pill no longer uses the old 4px x 128px size', () => {
        expect(pill('left')).not.toContain('w-1');
        expect(pill('left')).not.toContain('h-32');
    });
});
