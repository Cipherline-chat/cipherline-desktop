import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Class-level pin for the pinned-row squeeze fix.
 *
 * There is no DOM testing library in this suite (vitest runs `environment:
 * 'node'`, see vitest.config.ts, and the include glob is `*.test.ts` only —
 * PinnedMessagesPanel.tsx itself can't be mounted here), so this asserts
 * against the component's SOURCE rather than a rendered tree: the hover
 * action bar must be pulled out of the row's normal flex flow (so it
 * reserves no width while hidden — the actual bug, an `opacity-0` element
 * still consumes its flex-item width) and the row must be `relative` so an
 * `absolute` action bar positions against it, not some ancestor.
 *
 * A regression here (e.g. someone puts `shrink-0` back on the actions div,
 * which is exactly how this bug shipped) would be invisible to a plain
 * "does it render" check anyway, since `opacity-0` content still renders
 * fine — the bug is purely a layout/box-model one. This is deliberately a
 * narrow, brittle-on-purpose pin: it should break loudly if the relevant
 * className strings change shape, prompting a human to re-verify the fix
 * still holds rather than silently drifting back to the squeeze.
 */

const filePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'PinnedMessagesPanel.tsx',
);
const source = readFileSync(filePath, 'utf-8');

describe('PinnedMessagesPanel — pinned row hover-actions layout', () => {
    it('the pinned row container is a positioning root (`relative`) for its overlaid actions', () => {
        // Two rows share the `<div key={id} className="...">` shape: the
        // tombstone (no local message, always-visible Unpin) and the real
        // row this fix targets. Anchor on the real row's own distinguishing
        // classes so this can't accidentally pass by matching the tombstone.
        const rowMatch = source.match(/<div key=\{id\} className="(group relative flex gap-3[^"]+)">/);
        expect(rowMatch, 'real pinned row <div key={id} className="group relative flex gap-3..."> not found — did the row markup change shape?').not.toBeNull();
        const rowClassName = rowMatch![1];
        expect(rowClassName).toContain('relative');
        expect(rowClassName).toContain('group');
    });

    it('the hover action bar is taken out of flex flow (`absolute`), not merely hidden in place', () => {
        // Anchor on the actions block via its own comment so this doesn't
        // accidentally match the tombstone row's always-visible Unpin button
        // (which intentionally keeps normal flex layout — it has no text
        // column to squeeze).
        const actionsMatch = source.match(/\{\/\* Actions —[\s\S]{0,2500}?<div className="([^"]+)">/);
        expect(actionsMatch, 'hover actions block (the "{/* Actions —" comment) not found — did it move or get reworded?').not.toBeNull();
        const actionsClassName = actionsMatch![1];

        // The actual bug: `shrink-0` (or any non-`absolute` flex item) keeps
        // its layout width even at `opacity-0`, squeezing the text column
        // next to it. `absolute` removes it from the flex flow entirely so
        // the text column gets the row's full width at rest.
        expect(actionsClassName).toContain('absolute');
        expect(actionsClassName).not.toMatch(/\bshrink-0\b/);

        // Hidden at rest...
        expect(actionsClassName).toContain('opacity-0');
        expect(actionsClassName).toContain('pointer-events-none');
        // ...but reachable by mouse hover AND by keyboard focus (Tab into a
        // child button), per the requirement that Tab must still reach them.
        expect(actionsClassName).toContain('group-hover:opacity-100');
        expect(actionsClassName).toContain('focus-within:opacity-100');
        expect(actionsClassName).toContain('group-hover:pointer-events-auto');
        expect(actionsClassName).toContain('focus-within:pointer-events-auto');
    });

    it('the text column claims the full row width (`flex-1`), not a fixed/shrunk column', () => {
        const contentMatch = source.match(/\{\/\* Content \*\/\}\s*<div className="([^"]+)">/);
        expect(contentMatch, 'the "{/* Content */}" column div not found — did it move or get reworded?').not.toBeNull();
        expect(contentMatch![1]).toContain('flex-1');
    });
});
