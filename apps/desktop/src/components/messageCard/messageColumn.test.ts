// @vitest-environment jsdom
/**
 * The composer preview's max width = the feed's message column
 * (messageColumn.ts). The gutter constant mirrors ChatPane's row classes;
 * this test pins them so a change to the row fails here instead of the
 * preview silently wrapping somewhere else than the posted message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_ROW_GUTTER_PX, messageColumnWidth } from './messageColumn';

const cp = readFileSync(join(__dirname, '..', 'ChatPane.tsx'), 'utf8');

describe('message column', () => {
    it('the gutter is ChatPane\'s row: pl-3 (12) + w-10 avatar (40) + gap-3 (12) + pr-2 (8)', () => {
        expect(MESSAGE_ROW_GUTTER_PX).toBe(72);
        expect(cp).toMatch(/className=\{`group relative flex gap-3 py-0\.5 pr-2 pl-3 /);
        expect(cp).toMatch(/className="w-10 h-10 shrink-0 mt-0\.5 ring-1 ring-white\/5 shadow-sm"/);
        expect(cp).toMatch(/<div className="w-10 shrink-0" \/>/);
        expect(cp).toMatch(/<div className="relative flex flex-col min-w-0 flex-1">/);
    });
    it('feed content width minus the gutter (the scrollbar is already outside clientWidth)', () => {
        const feed = document.createElement('div');
        feed.style.paddingLeft = '24px';
        feed.style.paddingRight = '8px';
        let w = 440;
        Object.defineProperty(feed, 'clientWidth', { get: () => w });
        document.body.appendChild(feed);
        expect(messageColumnWidth(feed)).toBe(440 - 32 - 72);
        w = 50;
        expect(messageColumnWidth(feed)).toBe(0);
    });
    it('ChatPane measures its own feed for the preview', () => {
        expect(cp).toMatch(/const composerCardColumnW = useMessageColumnWidth\(feedRef, !!composerCard\);/);
    });
});
