import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The composer FLOATS over the message feed (absolute, bottom-4; the feed only
 * reserves a spacer for its height), so the form's own fill is the only thing
 * that hides messages scrolled underneath it. The disabled look — shared by
 * "Waiting for channel keys", "Couldn't install channel key — retrying…" and
 * "You don't have permission to send messages" (all are `!canSend`) — used a
 * bare rgba(255,255,255,.02) fill, so message text showed straight through the
 * bar. ChatPane has no render harness; this pins the fill at source level.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const formStart = src.indexOf('className="cl-composer"');
const form = src.slice(formStart, src.indexOf('<input type="file" multiple', formStart));

/** The !canSend fill must be stacked on a solid cl-* surface token. */
function disabledFillIsOpaque(formSrc: string): boolean {
    const m = formSrc.match(/background:\s*!canSend\s*\?\s*([^:]+?)\s*:\s*'var\(--cl-surface\)'/s);
    if (!m) return false;
    return /var\(--cl-(deep|surface|abyss|sink)\)/.test(m[1]);
}

describe('composer disabled state does not let the feed show through', () => {
    it('the composer form and its !canSend background are found', () => {
        expect(formStart).toBeGreaterThan(-1);
        expect(form).toContain('!canSend');
    });

    it('the disabled fill is layered over a solid cl-* surface token', () => {
        expect(disabledFillIsOpaque(form)).toBe(true);
    });

    it('does not use a bare translucent rgba as the disabled fill', () => {
        expect(form).not.toMatch(/background:\s*!canSend\s*\?\s*'rgba\(255,255,255,\.02\)'/);
    });

    it('key-wait, cooling-off and no-permission all ride the same !canSend fill', () => {
        const canSendDef = src.slice(src.indexOf('const canSend '), src.indexOf('const canAttach '));
        expect(canSendDef).toContain('SEND_MESSAGES');
        expect(canSendDef).toContain('!keyMissing');
    });

    it('positive control: the checker rejects the old translucent-only fill', () => {
        const old = "background: !canSend ? 'rgba(255,255,255,.02)' : 'var(--cl-surface)',";
        expect(disabledFillIsOpaque(old)).toBe(false);
    });
});
