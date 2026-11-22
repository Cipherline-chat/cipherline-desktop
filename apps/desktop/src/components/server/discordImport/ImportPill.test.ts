// @vitest-environment jsdom
/**
 * The background import's title-bar pill (owner 2026-11-22: "could be a little
 * bigger ... just make it look better"): what it says in every state, and what
 * it renders (fill only while running, the name in its own truncating span,
 * the click still opens the import).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImportPill } from './ImportPill';
import { importPillModel } from './importPillModel';
import type { ChannelReport } from '../../../utils/discordImport/history/runner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const rep = (name: string, error: string | null = null): ChannelReport => ({
    channelId: `c-${name}`, name, messages: 10, rows: error ? 0 : 10, filesImported: 0, filesSkipped: [], pinsSaved: 0, pinsNoRoom: 0,
    truncated: false, ceilingHit: false, reactionsSkipped: 0, error, savable: [],
});
const base = { serverName: 'Fusion', percent: 0 } as const;

describe('importPillModel', () => {
    it('running: "Importing <name>" with the percentage, and the fill at that percentage', () => {
        const m = importPillModel({ ...base, phase: 'history', percent: 17 });
        expect(m).toMatchObject({ tone: 'run', lead: 'Importing', name: 'Fusion', detail: null, tail: '17%', tailKind: 'percent', percent: 17 });
        expect(m.label).toBe('Importing Fusion · 17%');
        expect(importPillModel({ ...base, phase: 'structure', percent: 3 }).tail).toBe('3%');
    });

    it('a copy into an existing server says "Copying into"', () => {
        expect(importPillModel({ ...base, kind: 'copy', phase: 'history', percent: 40 }).label).toBe('Copying into Fusion · 40%');
    });

    it('percent boundaries: 0 shows 0%, 99 still runs, 100 while running is "finishing…"; junk is clamped', () => {
        expect(importPillModel({ ...base, phase: 'history', percent: 0 }).tail).toBe('0%');
        expect(importPillModel({ ...base, phase: 'history', percent: 99 })).toMatchObject({ tone: 'run', tail: '99%' });
        expect(importPillModel({ ...base, phase: 'history', percent: 100 })).toMatchObject({ tone: 'finishing', tail: 'finishing…', percent: 100 });
        expect(importPillModel({ ...base, phase: 'history', percent: 140 }).tail).toBe('finishing…');
        expect(importPillModel({ ...base, phase: 'history', percent: -5 }).tail).toBe('0%');
        expect(importPillModel({ ...base, phase: 'history', percent: Number.NaN }).tail).toBe('0%');
        expect(importPillModel({ ...base, phase: 'history', percent: 41.6 }).tail).toBe('42%');
    });

    it('Stop pressed, waiting for the runner: "stopping…" (the fill stays where it was)', () => {
        expect(importPillModel({ ...base, phase: 'history', percent: 55, stopping: true })).toMatchObject({ tone: 'finishing', tail: 'stopping…', percent: 55 });
    });

    it('done: "<name> imported · See report" (copy: "Messages copied into <name>")', () => {
        const m = importPillModel({ ...base, phase: 'done', percent: 100, hReports: [rep('general')] });
        expect(m).toMatchObject({ tone: 'ok', detail: 'imported', tail: 'See report', tailKind: 'action', percent: null });
        expect(m.label).toBe('Fusion imported · See report');
        expect(importPillModel({ ...base, kind: 'copy', phase: 'done', percent: 100 }).label).toBe('Messages copied into Fusion · See report');
    });

    it('done with failed channels: DANGER (red), the count, and "Retry" only when the report can retry them', () => {
        const hReports = [rep('general'), rep('memes', 'boom'), rep('art', 'boom')];
        const failed = hReports.filter(r => r.error);
        expect(importPillModel({ ...base, phase: 'done', percent: 100, hReports }, { failed, retryable: failed, any: true }))
            .toMatchObject({ tone: 'danger', detail: '2 channels failed', tail: 'Retry', label: 'Fusion 2 channels failed · Retry' });
        expect(importPillModel({ ...base, phase: 'done', percent: 100, hReports }, { failed, retryable: [], any: true }))
            .toMatchObject({ tone: 'danger', label: 'Fusion 2 channels failed · See report' });
        expect(importPillModel({ ...base, phase: 'done', percent: 100, hReports: [rep('memes', 'x')] }, { failed: [rep('memes', 'x')], retryable: [rep('memes', 'x')], any: true }).detail).toBe('1 channel failed');
        // Without the issues: failed channels still read from the reports (red), nothing counted as retryable.
        expect(importPillModel({ ...base, phase: 'done', percent: 100, hReports })).toMatchObject({ tone: 'danger', tail: 'See report' });
    });

    it('done with lesser issues (files left out, a partial channel) and nothing failed: amber "imported with issues"', () => {
        expect(importPillModel({ ...base, phase: 'done', percent: 100, hReports: [rep('general')] }, { failed: [], retryable: [], any: true }))
            .toMatchObject({ tone: 'warn', label: 'Fusion imported with issues · See report' });
        expect(importPillModel({ ...base, kind: 'copy', phase: 'done', percent: 100 }, { failed: [], retryable: [], any: true }).label).toBe('Fusion copied with issues · See report');
        expect(importPillModel({ ...base, phase: 'done', percent: 100 }, { failed: [], retryable: [], any: false }).tone).toBe('ok');
    });

    it('stopped by the user / history failed / structure failed: warning with the right action', () => {
        expect(importPillModel({ ...base, phase: 'done', percent: 100, stopped: { deleted: 0 }, hReports: [rep('general')] }).label).toBe('Fusion import stopped · See report');
        expect(importPillModel({ ...base, phase: 'history-failed', percent: 60 })).toMatchObject({ tone: 'warn', label: 'Fusion import stopped · See report', percent: null });
        expect(importPillModel({ ...base, phase: 'structure-failed', percent: 4 })).toMatchObject({ tone: 'warn', tail: 'Try again', label: 'Fusion import stopped · Try again' });
    });
});

describe('<ImportPill>', () => {
    let root: Root;
    let host: HTMLDivElement;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const render = (model: ReturnType<typeof importPillModel>, onClick = vi.fn()) => {
        act(() => root.render(h(ImportPill, { model, onClick, title: 'From the Discord server Fusion HQ' })));
        return host.querySelector<HTMLButtonElement>('[data-testid="import-pill"]')!;
    };

    it('running: a no-drag button with the tone, the fill at the percentage, the name and the mono percentage', () => {
        const btn = render(importPillModel({ ...base, phase: 'history', percent: 17 }));
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.type).toBe('button');
        expect(btn.classList.contains('no-drag')).toBe(true);
        expect(btn.dataset.tone).toBe('run');
        expect(btn.getAttribute('aria-label')).toBe('Importing Fusion · 17%. Open the import');
        expect(btn.title).toBe('From the Discord server Fusion HQ');
        expect(host.querySelector<HTMLElement>('[data-testid="import-pill-fill"]')!.style.width).toBe('17%');
        expect(host.querySelector('[data-testid="import-pill-name"]')!.textContent).toBe('Fusion');
        const tail = host.querySelector('[data-testid="import-pill-tail"]')!;
        expect(tail.textContent).toBe('17%');
        expect(tail.classList.contains('is-percent')).toBe(true);
    });

    it('a tiny percentage still shows a sliver of fill', () => {
        render(importPillModel({ ...base, phase: 'structure', percent: 0 }));
        expect(host.querySelector<HTMLElement>('[data-testid="import-pill-fill"]')!.style.width).toBe('4%');
    });

    it('finished states have no fill; the action is a chip', () => {
        render(importPillModel({ ...base, phase: 'done', percent: 100 }));
        expect(host.querySelector('[data-testid="import-pill-fill"]')).toBeNull();
        expect(host.querySelector('[data-testid="import-pill-tail"]')!.className).toContain('is-action');
        const bad = [rep('a', 'x'), rep('b', 'y')];
        const warn = render(importPillModel({ ...base, phase: 'done', percent: 100, hReports: bad }, { failed: bad, retryable: bad, any: true }));
        expect(warn.dataset.tone).toBe('danger');
        expect(warn.classList.contains('is-danger')).toBe(true);
        expect(warn.textContent).toBe('Fusion2 channels failedRetry');
        expect(warn.querySelector('[data-testid="import-pill-tail"] svg')).not.toBeNull(); // the retry glyph
    });

    it('a click calls onClick (the host opens the progress / report view)', () => {
        const onClick = vi.fn();
        const btn = render(importPillModel({ ...base, phase: 'history', percent: 50 }), onClick);
        act(() => btn.click());
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('the long name is its own span (the stylesheet truncates it, never the percentage)', () => {
        render(importPillModel({ ...base, serverName: 'The Extremely Long Community Server Name That Never Ends', phase: 'history', percent: 9 }));
        expect(host.querySelector('[data-testid="import-pill-name"]')!.textContent).toBe('The Extremely Long Community Server Name That Never Ends');
        expect(host.querySelector('[data-testid="import-pill-tail"]')!.textContent).toBe('9%');
    });
});

describe('discord-import-pill.css', () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'discord-import-pill.css'), 'utf8');
    const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };

    it('fills the 34 px title bar with even room: 28 px tall, 3 px from the top', () => {
        expect(rule('.cl-import-pill')).toMatch(/height: 28px;/);
        expect(rule('.cl-import-pill')).toMatch(/top: 3px;/);
    });
    it('stays a no-drag click target above the app drag strip (z-index 9999)', () => {
        expect(rule('.cl-import-pill')).toMatch(/-webkit-app-region: no-drag;/);
        expect(rule('.cl-import-pill')).toMatch(/z-index: 10000;/);
    });
    it('the name truncates with an ellipsis, the percentage is tabular mono', () => {
        expect(rule('.cl-import-pill-name')).toMatch(/text-overflow: ellipsis;/);
        expect(rule('.cl-import-pill-name')).toMatch(/var\(--cl-font-display\)/);
        expect(rule('.cl-import-pill-tail.is-percent')).toMatch(/tabular-nums/);
        expect(rule('.cl-import-pill-tail.is-percent')).toMatch(/var\(--cl-font-mono\)/);
    });
    it('a failed channel paints the pill in the danger colour (owner: red), never the amber warning', () => {
        expect(rule('.cl-import-pill.is-danger')).toMatch(/--cl-danger-rgb/);
        expect(css).toMatch(/\.cl-import-pill\.is-danger \.cl-import-pill-ico \{ color: var\(--cl-danger-text\)/);
        expect(css).toMatch(/\.cl-import-pill\.is-danger \.cl-import-pill-tail\.is-action \{ color: var\(--cl-danger-text\)/);
    });
    it('Reduce motion stops the shimmer and the spinner', () => {
        const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(rm).toMatch(/\.cl-import-pill-fill::after \{ animation: none;/);
        expect(rm).toMatch(/\.cl-import-pill-spin \{ animation: none;/);
    });
});
