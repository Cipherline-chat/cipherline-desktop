import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A personal-emoji status renders from THIS device's library / received cache
 * only: held -> the image, not held -> nothing (the status text still shows),
 * and the component can reach no network.
 */
const urlState = vi.hoisted(() => ({ value: { status: 'missing', url: null } as { status: string; url: string | null } }));
vi.mock('../hooks/usePersonalEmojis', () => ({ usePersonalEmojiUrl: () => urlState.value }));
vi.mock('../hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));
vi.mock('../utils/personalEmoji/service', () => ({ personalEmojis: () => ({ store: { meta: () => ({ m: 'image/png', a: 0, n: 'x' }), read: async () => null } }) }));
vi.mock('../utils/personalEmoji/stillFrame', () => ({ stillFrameUrl: async () => null }));

const { StatusLine } = await import('./StatusLine');
const { StatusPersonalEmoji } = await import('./StatusPersonalEmoji');

const REF = 'cl:p_' + 'a'.repeat(32);
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const entry = { status: 'online', custom_status_text: 'lunch', custom_status_emoji: REF, current_game: null } as never;

describe('StatusPersonalEmoji - device-only', () => {
    it('holder: renders the cached image', () => {
        urlState.value = { status: 'ready', url: 'blob:abc' };
        expect(html(React.createElement(StatusPersonalEmoji, { id: 'p_' + 'a'.repeat(32) }))).toContain('src="blob:abc"');
        const line = html(React.createElement(StatusLine, { entry }));
        expect(line).toContain('blob:abc');
        expect(line).toContain('lunch');
    });

    it('non-holder (not delivered yet / not a friend): NOTHING for the emoji, the text still shows, never the raw ref', () => {
        for (const status of ['missing', 'loading']) {
            urlState.value = { status, url: null };
            expect(html(React.createElement(StatusPersonalEmoji, { id: 'p_' + 'a'.repeat(32) }))).toBe('');
            const line = html(React.createElement(StatusLine, { entry }));
            expect(line).toContain('lunch');
            expect(line).not.toContain('<img');
            expect(line).not.toContain('cl:p_');
            expect(line).not.toContain('p_aaaa');
        }
    });

    it('has no network path: no fetch, axios, API url or server-fetch helper in the render modules', () => {
        for (const f of ['StatusPersonalEmoji.tsx', 'personalStatusEmoji.ts']) {
            const src = readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            expect(src).not.toMatch(/\bfetch\s*\(|axios|XMLHttpRequest|apiUrl|API_BASE|ensureStatusEmoji|status-emoji/);
        }
    });

    it('the status emoji module exports no fetcher either', async () => {
        const mod = await import('../utils/personalEmoji/statusEmoji');
        expect(Object.keys(mod).filter(k => /fetch|ensure|http/i.test(k))).toEqual([]);
    });

    it('useUserStatus sends only the ref: no image bytes in the status PATCH', () => {
        const src = readFileSync(join(__dirname, '../hooks/useUserStatus.ts'), 'utf8');
        expect(src).not.toContain('custom_status_emoji_image');
        expect(src).not.toContain('withStatusEmojiImage');
    });
});
