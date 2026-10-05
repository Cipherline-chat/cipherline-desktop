/**
 * Guards for the opt-in modal height cap (`.mcard--scroll`).
 *
 * Source scans rather than behavioural assertions, for the same reason as
 * stripeAppearance.test.ts: the desktop app has no component-test setup to
 * render a modal in, and both failure modes here are invisible at runtime
 * until a card happens to overflow.
 *
 * The bug: `.mcard` has no max-height and `.mod` centres it in a fixed,
 * non-scrolling flexbox. A card taller than the viewport overflows off BOTH
 * edges at once, and the half above the fold cannot be scrolled back to —
 * centred-flex overflow clamps scrollTop at 0. Measured in headless Chrome at
 * 1280x720: SafetyVerificationModal 750px at 3 devices / 1008px at 5, and
 * ServerInviteModal 739px with its link settings expanded.
 *
 * The fix is deliberately opt-in: an unconditional `overflow-y` on every
 * `.mcard` would clip the popovers other modals let escape.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), 'utf8');

/** Modals that opt into the cap, and why they need it. Heights are the measured
 *  worst case at 1280x720 (headless Chrome, real components):
 *    SafetyVerificationModal  750px @ 3 devices, 1008px @ 5   (unbounded list)
 *    ServerInviteModal        739px with link settings expanded
 *    HistoryRequestModal      877px — the tallest in the app
 *    HistorySyncBanner        774px @ 10 devices               (unbounded list)
 *  The budget is 672px: a 720px viewport minus the cap's 48px gutter. */
const OPTED_IN: [name: string, path: string[]][] = [
    ['SafetyVerificationModal', ['..', 'SafetyVerificationModal.tsx']],
    ['ServerInviteModal', ['..', 'server', 'ServerInviteModal.tsx']],
    ['HistoryRequestModal', ['..', 'HistoryRequestModal.tsx']],
    ['HistorySyncBanner', ['..', 'HistorySyncBanner.tsx']],
];

describe('mcard--scroll', () => {
    it('is a real rule, in the stylesheet both apps load', () => {
        // A class name passed as a string is a typo away from doing nothing.
        const css = read('..', '..', 'styles', 'cl-kit-ext.css');
        expect(css).toMatch(/\.mcard--scroll\s*\{[^}]*overflow-y:\s*auto/);
        expect(css).toMatch(/\.mcard--scroll\s*\{[^}]*max-height/);
    });

    it.each(OPTED_IN)('%s opts into the height cap', (_name, path) => {
        expect(read(...path)).toContain('mcard--scroll');
    });

    it.each(OPTED_IN)(
        '%s does not also set an inline overflow, which would beat the class',
        (_name, path) => {
            // ClModal spreads cardStyle onto the element's style attribute, so an
            // inline `overflow`/`overflowY` wins over the stylesheet and silently
            // turns the cap into a no-op that still clips. ServerInviteModal
            // shipped exactly this combination (`cardStyle={{ padding: 0,
            // overflow: 'hidden' }}`) before the cap was added to it.
            const src = read(...path);
            const cardStyle = src.match(/cardStyle=\{\{[^}]*\}\}/s)?.[0] ?? '';
            expect(cardStyle).not.toMatch(/overflow/);
        },
    );

    it('ClModal merges cardClassName rather than replacing the base class', () => {
        // Two of the opted-in modals already passed a cardClassName, so the
        // class has to compose — `.mcard` itself must survive.
        const src = read('ClModal.tsx');
        expect(src).toMatch(/\['mcard',\s*cardClassName/);
    });
});
