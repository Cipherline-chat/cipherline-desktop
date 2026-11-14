import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat text must keep ClearType / subpixel antialiasing.
 *
 * The message column (contentRef) used to carry `will-change: transform`
 * permanently, for the FLIP slide that runs when a new message arrives.
 * Chromium never gives a will-change:transform layer LCD text (cc's
 * LCDTextDisallowedReason::kWillChangeTransform), so every message in every
 * chat was drawn with greyscale antialiasing and looked soft next to Discord.
 * The promotion now exists only while the slide runs. ChatPane has no render
 * harness, so this pins it at source level.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

describe('chat text keeps subpixel antialiasing', () => {
    it('the message column has no permanent will-change', () => {
        const open = src.match(/<div ref=\{contentRef\}[^>]*>/);
        expect(open).not.toBeNull();
        expect(open![0]).not.toMatch(/will-?change/i);
    });

    it('the FLIP slide promotes the column only while it runs, and clears it after', () => {
        const start = src.indexOf('const revealNewMessage = useCallback(');
        expect(start).toBeGreaterThan(-1);
        const body = src.slice(start, src.indexOf('}, []);', start));
        expect(body).toContain("c.style.willChange = 'transform'");
        const onEnd = body.slice(body.indexOf('const onEnd'));
        expect(onEnd).toContain("c.style.willChange = ''");
        expect(onEnd).toContain("c.style.transform = ''");
    });

    it('a bubbled transitionend from a child cannot end the slide early', () => {
        const start = src.indexOf('const revealNewMessage = useCallback(');
        const body = src.slice(start, src.indexOf('}, []);', start));
        expect(body).toMatch(/e\.target !== c \|\| e\.propertyName !== 'transform'/);
    });
});
