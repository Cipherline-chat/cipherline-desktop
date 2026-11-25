// @vitest-environment jsdom
/**
 * The composer's link previews (useComposerEmbeds + ComposerEmbedPreviews):
 * built after typing pauses, shown with an ×, dropped with it, never built
 * while the setting is off, and the send never waits past its deadline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useComposerEmbeds, _clearComposerEmbedCache, _setSnapshotApi, awaitFinalPreview, DEBOUNCE_MS, type ComposerEmbeds } from './useComposerEmbeds';
import { ComposerEmbedPreviews } from '../components/embeds/ComposerEmbedPreviews';
import type { PreparedEmbed } from '../utils/linkEmbeds/prepare';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | null = null;
let host: HTMLDivElement;
const box: { api: ComposerEmbeds | null } = { api: null };

const ready = (url: string, title = 'Title'): PreparedEmbed => ({ url, embed: { url, kind: 'card', title, site: 'Site' } });

function Probe({ text, enabled, prepare }: { text: string; enabled: boolean; prepare: (u: string) => Promise<PreparedEmbed | null> }) {
    const e = useComposerEmbeds(text, enabled, prepare);
    box.api = e;
    return h(ComposerEmbedPreviews, { embeds: e });
}
function render(text: string, enabled: boolean, prepare: (u: string) => Promise<PreparedEmbed | null>) {
    act(() => { root!.render(h(Probe, { text, enabled, prepare })); });
}
const settle = async (ms = DEBOUNCE_MS + 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

beforeEach(() => {
    _clearComposerEmbedCache();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); box.api = null; });

describe('useComposerEmbeds', () => {
    it('builds after typing pauses (not per keystroke), shows the preview, and × drops it from the send', async () => {
        const prepare = vi.fn(async (u: string) => ready(u, `T ${u.slice(-1)}`));
        render('look https://a.example/', true, prepare);
        render('look https://a.example/1', true, prepare);
        render('look https://a.example/1 and https://b.example/2', true, prepare);
        expect(prepare).not.toHaveBeenCalled();
        await settle();
        await settle(10);
        expect(prepare.mock.calls.map((c) => c[0])).toEqual(['https://a.example/1', 'https://b.example/2']);
        expect(host.querySelectorAll('.cl-cep-item')).toHaveLength(2);
        expect(host.textContent).toContain('T 1');

        await act(async () => { (host.querySelector('button[aria-label^="Don\'t include a preview of a.example"]') as HTMLButtonElement).click(); });
        expect(host.querySelectorAll('.cl-cep-item')).toHaveLength(1);
        const sent = await box.api!.take('look https://a.example/1 and https://b.example/2', 100);
        expect(sent.map((p) => p.url)).toEqual(['https://b.example/2']);

        act(() => box.api!.reset());
        expect((await box.api!.take('look https://a.example/1', 100)).map((p) => p.url)).toEqual(['https://a.example/1']);
    });

    it('off (setting / no link permission): nothing is built and nothing is sent', async () => {
        const prepare = vi.fn(async (u: string) => ready(u));
        render('https://a.example/1', false, prepare);
        await settle();
        expect(prepare).not.toHaveBeenCalled();
        expect(await box.api!.take('https://a.example/1', 50)).toEqual([]);
        expect(host.querySelector('.cl-cep')).toBeNull();
    });

    it('a slow site never holds the send past the deadline; it goes with the minimal card (its site) instead of its preview', async () => {
        const prepare = vi.fn((u: string) => (u.includes('slow') ? new Promise<PreparedEmbed | null>(() => {}) : Promise.resolve(ready(u))));
        render('https://slow.example/x https://fast.example/y', true, prepare);
        await settle();
        expect(host.querySelector('[data-status="loading"]')).not.toBeNull();
        const t0 = Date.now();
        const got = await box.api!.take('https://slow.example/x https://fast.example/y', 200);
        expect(Date.now() - t0).toBeLessThan(600);
        expect(got.map((p) => p.url)).toEqual(['https://slow.example/x', 'https://fast.example/y']);
        expect(got[0].embed).toEqual({ url: 'https://slow.example/x', kind: 'card', site: 'slow.example' });
        expect(got[0].thumb).toBeUndefined();
    });

    it('a link typed and sent before the debounce still gets its preview (started at send)', async () => {
        const prepare = vi.fn(async (u: string) => ready(u));
        render('https://now.example/a', true, prepare);
        const got = await box.api!.take('https://now.example/a', 300);
        expect(got.map((p) => p.url)).toEqual(['https://now.example/a']);
    });

    it('a built preview is reused (edits, retyping) — the site is visited once per session', async () => {
        const prepare = vi.fn(async (u: string) => ready(u));
        render('https://once.example/a', true, prepare);
        await settle();
        render('edited https://once.example/a', true, prepare);
        await settle();
        await box.api!.take('https://once.example/a', 100);
        expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('a link that yields no preview shows nothing', async () => {
        render('https://none.example/a', true, vi.fn(async () => null));
        await settle();
        await settle(10);
        expect(host.querySelector('.cl-cep')).toBeNull();
    });
});

describe('page snapshots (2026-11-23): a card with no picture gets a snapshot, cancelled when nobody wants it', () => {
    const fakeThumb = { blob: new Blob(['x']), mime: 'image/webp' as const, width: 1200, height: 675 };
    const pending = (url: string): PreparedEmbed => ({ url, embed: { url, kind: 'card', title: 'No picture', site: 'Site' }, snapshot: 'pending' });
    let upgrades: { url: string; token: string; finish: (ok: boolean) => void }[];
    let cancelled: string[];
    beforeEach(() => {
        upgrades = [];
        cancelled = [];
        _setSnapshotApi({
            now: () => Date.now(),
            upgrade: (p, token) => new Promise<PreparedEmbed>((ok) => {
                upgrades.push({
                    url: p.url, token,
                    finish: (good) => ok(good ? { ...p, snapshot: undefined, thumb: fakeThumb, embed: { ...p.embed, image_large: true }, snapshotResult: 'ok' } : { ...p, snapshot: undefined, snapshotResult: 'bot-wall' }),
                });
            }),
            cancel: (token: string) => {
                cancelled.push(token);
                const u = upgrades.find((x) => x.token === token);
                // main answers a cancelled job with reason 'cancelled'
                if (u) u.finish = () => {};
                return undefined;
            },
        });
    });

    it('the card is ready at once, the snapshot follows and becomes its picture; the chip spins meanwhile', async () => {
        render('see https://nopic.example/a', true, vi.fn(async (u: string) => pending(u)));
        await settle();
        await settle(10);
        expect(upgrades.map((u) => u.url)).toEqual(['https://nopic.example/a']);
        expect(host.querySelector('[data-snapshot="taking"]')).not.toBeNull();
        expect(host.textContent).toContain('No picture');
        await act(async () => { upgrades[0].finish(true); await Promise.resolve(); });
        await settle(10);
        expect(host.querySelector('[data-snapshot="taking"]')).toBeNull();
        expect(host.querySelector('[data-snapshot="ok"] img')).not.toBeNull();
        const got = await box.api!.take('see https://nopic.example/a', 100);
        expect(got[0].thumb).toBe(fakeThumb);
        expect(got[0].embed.image_large).toBe(true);
        expect(got[0].late).toBeUndefined();
    });

    it('a wall / login / error page: no picture, the designed card (snapshot refused by main)', async () => {
        render('https://wall.example/a', true, vi.fn(async (u: string) => pending(u)));
        await settle();
        await settle(10);
        await act(async () => { upgrades[0].finish(false); await Promise.resolve(); });
        await settle(10);
        const got = await box.api!.take('https://wall.example/a', 100);
        expect(got[0].thumb).toBeUndefined();
        expect(got[0].snapshotResult).toBe('bot-wall');
        expect(got[0].late).toBeUndefined();
    });

    it('deleting the link from the draft CANCELS its snapshot; × on its preview too', async () => {
        render('https://gone.example/a https://x.example/b', true, vi.fn(async (u: string) => pending(u)));
        await settle();
        await settle(10);
        expect(upgrades).toHaveLength(2);
        render('https://x.example/b', true, vi.fn(async (u: string) => pending(u)));
        await settle(10);
        expect(cancelled).toEqual([upgrades[0].token]);
        await act(async () => { (host.querySelector('button[aria-label^="Don\'t include a preview of x.example"]') as HTMLButtonElement).click(); });
        await settle(10);
        expect(cancelled).toEqual([upgrades[0].token, upgrades[1].token]);
    });

    it('sent before the snapshot: the card goes now marked late, the snapshot is NOT cancelled when the composer clears, and awaitFinalPreview hands it over', async () => {
        render('https://late.example/a', true, vi.fn(async (u: string) => pending(u)));
        await settle();
        await settle(10);
        const got = await box.api!.take('https://late.example/a', 100);
        expect(got[0].late).toBe(true);
        expect(got[0].thumb).toBeUndefined();
        render('', false, vi.fn(async (u: string) => pending(u))); // the composer clears after the send
        await settle(10);
        expect(cancelled).toEqual([]);
        const final = awaitFinalPreview('https://late.example/a', Date.now() + 2000);
        await act(async () => { upgrades[0].finish(true); await Promise.resolve(); });
        expect((await final)?.thumb).toBe(fakeThumb);
    });

    it('a late preview that never comes is given up at the deadline (null), and the hold is released (cancelled)', async () => {
        render('https://never.example/a', true, vi.fn(async (u: string) => pending(u)));
        await settle();
        await settle(10);
        await box.api!.take('https://never.example/a', 50);
        render('', false, vi.fn(async () => null));
        await settle(10);
        const t0 = Date.now();
        const final = await awaitFinalPreview('https://never.example/a', Date.now() + 150);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(final?.thumb).toBeUndefined(); // the card as it was, no picture
        expect(cancelled).toEqual([upgrades[0].token]);
    });

    it('a link still loading at send is late too (the minimal card goes now)', async () => {
        let resolve!: (p: PreparedEmbed) => void;
        render('https://slowpage.example/a', true, vi.fn(() => new Promise<PreparedEmbed | null>((ok) => { resolve = ok; })));
        await settle();
        const got = await box.api!.take('https://slowpage.example/a', 50);
        expect(got[0]).toMatchObject({ late: true, embed: { kind: 'card', site: 'slowpage.example' } });
        const final = awaitFinalPreview('https://slowpage.example/a', Date.now() + 2000);
        await act(async () => { resolve(ready('https://slowpage.example/a', 'Real title')); await Promise.resolve(); });
        expect((await final)?.embed.title).toBe('Real title');
    });
});
