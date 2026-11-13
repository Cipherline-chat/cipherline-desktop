// @vitest-environment jsdom
import { beforeAll, describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ClButton -> clPhysics reads matchMedia at import time; jsdom has none.
let ShareOverloadCard: typeof import('./ShareOverloadOffer').ShareOverloadCard;
beforeAll(async () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    ({ ShareOverloadCard } = await import('./ShareOverloadOffer'));
}, 60_000);

describe('the offer card (encoder overload and game starvation)', () => {
    const noop = () => { /* click handlers are not exercised here */ };
    const html = (p: Parameters<typeof ShareOverloadCard>[0]) => renderToStaticMarkup(React.createElement(ShareOverloadCard, p));

    it('the encoder-overload card looks exactly as before: its title, sentence and Switch / Keep current', () => {
        const h = html({ current: 'Source at 90 fps', suggested: '1440p at 90 fps', sizeChange: '3024×1964 → 2216×1438', onSwitch: noop, onDismiss: noop });
        expect(h).toContain('Your computer can’t keep up');
        expect(h).toContain('Source at 90 fps is too much for it. 1440p at 90 fps should run smoothly.');
        expect(h).toContain('Stream size: 3024×1964 → 2216×1438');
        expect(h).toContain('>Switch<');
        expect(h).toContain('>Keep current<');
        expect(h).toContain('aria-label="Your computer can’t keep up with this stream"');
    });

    it('a starvation offer carries its own words and button labels', () => {
        const h = html({ title: 'Your share is stuttering', body: 'Only about 6 frames a second are getting through.', acceptLabel: 'Turn on', dismissLabel: 'Not now', onSwitch: noop, onDismiss: noop });
        expect(h).toContain('Your share is stuttering');
        expect(h).toContain('Only about 6 frames a second are getting through.');
        expect(h).toContain('>Turn on<');
        expect(h).toContain('>Not now<');
        expect(h).not.toContain('>Switch<');
        expect(h).not.toContain('is too much for it');
    });

    it('a tip has a single "Got it" and no accept button', () => {
        const h = html({ title: 'Your share is stuttering', body: 'Cap the game’s frame rate.', dismissLabel: 'Got it', onDismiss: noop });
        expect(h).toContain('>Got it<');
        expect(h).not.toContain('>Switch<');
        expect(h).not.toContain('>Turn on<');
        expect(h.match(/<button/g)!.length).toBe(2); // "Got it" and the X
    });
});
