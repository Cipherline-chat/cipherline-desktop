import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

import { DEFAULT_EMBED_PREFS, EMBED_PREFS_CHANGED_EVENT, EMBED_PREFS_KEY, GIF_BOX, getEmbedPrefs, parseEmbedPrefs, setEmbedCompact, videoCardVariant, webCardStyleFor } from './embedPrefs';
import { classifyKvKey } from '../services/backupRegistry';

describe('Compact embeds setting', () => {
    beforeEach(() => store.clear());

    it('defaults to EXPANDED (owner: ask nothing)', () => {
        expect(DEFAULT_EMBED_PREFS).toEqual({ compact: false });
        expect(getEmbedPrefs()).toEqual({ compact: false });
    });

    it('a user change persists and notifies; nothing else writes', () => {
        const seen = vi.fn();
        const g = globalThis as unknown as { window: { dispatchEvent?: (e: Event) => boolean } };
        const prev = g.window.dispatchEvent;
        g.window.dispatchEvent = (e: Event) => { if (e.type === EMBED_PREFS_CHANGED_EVENT) seen(); return true; };
        try {
            getEmbedPrefs();
            expect(store.size).toBe(0);
            setEmbedCompact(true);
            expect(JSON.parse(store.get(EMBED_PREFS_KEY)!)).toEqual({ compact: true });
            expect(getEmbedPrefs()).toEqual({ compact: true });
            expect(seen).toHaveBeenCalledTimes(1);
        } finally {
            g.window.dispatchEvent = prev;
        }
    });

    it('strict parse', () => {
        for (const bad of [null, '', 'x', '[]', '{"compact":"yes"}', '{}']) expect(parseEmbedPrefs(bad)).toEqual({ compact: false });
        expect(parseEmbedPrefs('{"compact":true,"extra":1}')).toEqual({ compact: true });
    });

    it('per device: classified in the backup registry as NOT backed up', () => {
        expect(classifyKvKey(EMBED_PREFS_KEY, 'u1')).toBe('exclude');
    });

    it('extension points for phase 3: the card-layout chooser and the per-layout sizes', () => {
        expect(webCardStyleFor('compact', 'wide')).toBe('ambient-wide'); // owner 2026-11-23: compact = the Amazon card's layout
        expect(webCardStyleFor('compact', 'square')).toBe('ambient-square');
        expect(webCardStyleFor('compact', 'none')).toBe('tile-no-image');
        expect(webCardStyleFor('expanded', 'wide')).toBe('island');
        expect(webCardStyleFor('expanded', 'square')).toBe('ambient');
        expect(webCardStyleFor('expanded', 'none')).toBe('tile-no-image');
        expect(videoCardVariant('compact')).toBe('clip-card');
        expect(videoCardVariant('expanded')).toBe('player');
        expect(GIF_BOX).toEqual({ compact: { maxW: 240, maxH: 180 }, expanded: { maxW: 400, maxH: 300 } });
    });
});

describe('light mode: no lines on any embed (source check of the shipped CSS)', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'link-embeds.css'), 'utf8');
    it('the clip card has no border in light themes, a soft shadow instead', () => {
        expect(css).toMatch(/:root\[data-scheme="light"\] \.cl-ve \{\s*border: 0;\s*box-shadow:/);
    });
    it('every border inside the embed row is cleared, except the marks drawn on the picture', () => {
        expect(css).toContain(':root[data-scheme="light"] .cl-embed-row *:not(.cl-ve-spin):not(.cl-ve-play) { border-color: transparent !important; }');
        expect(readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8')).toMatch(/className="cl-embed-row /);
    });
});
