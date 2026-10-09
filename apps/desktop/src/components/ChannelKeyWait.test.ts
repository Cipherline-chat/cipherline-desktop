// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelKeyWait } from './ChannelKeyWait';
import {
    useChannelKeyWait, KEY_WAIT_EXIT_MS, KEY_WAIT_REDUCED_EXIT_MS, KEY_WAIT_REGRESSION_HOLD_MS,
    KEY_WAIT_DECRYPT_HOLD_MS, type ChannelKeyWaitState,
} from '../hooks/useChannelKeyWait';
import {
    KEY_WAIT_COPY, KEY_WAIT_STALL_MS, beginChannelPageDecrypt, noteChannelKeyReceived, noteKeyRequestAcked,
    resetKeyWaitSignals,
} from '../utils/channelKeyWait';
import { channelPlaceholderContent } from '../utils/channelDecryptFailure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The key-wait layer's contract with ChatPane:
 *   - it is up only while the newest page is all key_missing (and the list is
 *     not rendered at all meanwhile — no pill ever paints);
 *   - its copy follows the real signals Dashboard notes;
 *   - it leaves when the page is readable AND the decrypt has folded in, with
 *     a handoff (the list renders with `ckw-list-in` during the exit), and
 *     never comes back for the same pane;
 *   - under reduced motion it is a still picture that is fully visible, its
 *     text still updates, and the exit is a short opacity fade.
 */

let root: Root | null = null;
let host: HTMLDivElement;
let reduce = false;

const CH = 'chan-1';
let n = 0;
const pill = () => ({ id: `p${++n}`, content: channelPlaceholderContent('key_missing', 2), sender_device_id: 'd' });
const msg = () => ({ id: `m${++n}`, content: { type: 'text', text: 'hello' }, sender_device_id: 'd' });
const page = (k: number, f: () => object) => Array.from({ length: k }, f);

type Rows = Array<{ id?: string; content?: unknown; sender_device_id?: string }>;
let lastState: ChannelKeyWaitState | null = null;
const recordState = (s: ChannelKeyWaitState) => { lastState = s; };

/** ChatPane in miniature: the same hook, the same render rules. */
const Pane: React.FC<{ rows: Rows; enabled?: boolean; onState: (s: ChannelKeyWaitState) => void }> = ({ rows, enabled = true, onState }) => {
    const kw = useChannelKeyWait({ enabled, channelId: CH, messages: rows });
    React.useEffect(() => { onState(kw); });
    return React.createElement('div', { className: 'pane' },
        kw.holdList ? null : React.createElement('div', { className: kw.handoff ? 'list ckw-list-in' : 'list' },
            rows.map(r => React.createElement('div', { key: r.id, className: 'row' }, String((r.content as { type?: string })?.type)))),
        kw.phase !== 'hidden' ? React.createElement(ChannelKeyWait, { phase: kw.phase, stage: kw.stage, reduced: kw.reduced }) : null,
    );
};

function render(rows: Rows, enabled = true) {
    act(() => { root!.render(React.createElement(Pane, { rows, enabled, onState: recordState })); });
}
const layer = () => host.querySelector('.ckw-root') as HTMLElement | null;
const list = () => host.querySelector('.list') as HTMLElement | null;
const status = () => host.querySelector('[role="status"]') as HTMLElement | null;
const title = () => host.querySelector('.ckw-copy-in .ckw-title')?.textContent ?? null;

beforeEach(() => {
    vi.useFakeTimers();
    resetKeyWaitSignals();
    reduce = false;
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (q: string) => ({
            matches: q.includes('prefers-reduced-motion') ? reduce : false,
            media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
            onchange: null, dispatchEvent: () => false,
        }),
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    lastState = null;
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.useRealTimers();
});

describe('when it shows', () => {
    it('a page of nothing but key_missing pills: the layer is up and NO row renders', () => {
        render(page(100, pill));
        expect(layer()).not.toBeNull();
        expect(list()).toBeNull();
        expect(host.querySelectorAll('.row')).toHaveLength(0);
    });
    it('control: a readable page renders the list and no layer', () => {
        render([...page(99, pill), msg()]);
        expect(layer()).toBeNull();
        expect(host.querySelectorAll('.row')).toHaveLength(100);
    });
    it('not for an empty channel, and not when disabled (DMs)', () => {
        render([]);
        expect(layer()).toBeNull();
        render(page(10, pill), false);
        expect(layer()).toBeNull();
    });
    it('appears the moment the first page lands as pills (no frame of pills)', () => {
        render([]);
        expect(layer()).toBeNull();
        render(page(100, pill));
        expect(layer()).not.toBeNull();
        expect(host.querySelectorAll('.row')).toHaveLength(0);
    });
    it('accessible: a polite status region, nothing focusable, decorations hidden', () => {
        render(page(5, pill));
        expect(status()?.getAttribute('aria-live')).toBe('polite');
        expect(host.querySelector('.ckw-root button, .ckw-root [tabindex]')).toBeNull();
        expect(host.querySelector('.ckw-emblem')?.getAttribute('aria-hidden')).toBe('true');
        expect(host.querySelector('.ckw-ghosts')?.getAttribute('aria-hidden')).toBe('true');
    });
});

describe('stages from real signals', () => {
    it('asking → asked → received → building, each from its own signal', () => {
        render(page(100, pill));
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);
        expect(status()!.textContent).toContain(KEY_WAIT_COPY.asking.detail);

        act(() => { noteKeyRequestAcked(CH); });
        expect(status()!.textContent).toContain(KEY_WAIT_COPY.asked.detail);

        act(() => { noteChannelKeyReceived(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.received.title);
        expect(layer()!.classList.contains('is-unlocked')).toBe(true);

        act(() => { beginChannelPageDecrypt(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.building.title);
        expect(layer()!.classList.contains('is-resolved')).toBe(true);
    });
    it('a key for some OTHER channel changes nothing', () => {
        render(page(100, pill));
        act(() => { noteChannelKeyReceived('another-channel'); });
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);
    });
    it('timeout: nothing arrives for ~18 s → the calm "no one has answered" copy', () => {
        render(page(100, pill));
        act(() => { noteKeyRequestAcked(CH); });
        act(() => { vi.advanceTimersByTime(KEY_WAIT_STALL_MS - 1000); });
        expect(title()).toBe(KEY_WAIT_COPY.asked.title);
        act(() => { vi.advanceTimersByTime(1500); });
        expect(title()).toBe(KEY_WAIT_COPY.stalled.title);
        expect(layer()!.classList.contains('is-stalled')).toBe(true);
        // and a key still moves it on
        act(() => { noteChannelKeyReceived(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.received.title);
    });
    it('a key that did not cover the page steps back — after a hold, not in a flash', () => {
        render(page(100, pill));
        act(() => { noteKeyRequestAcked(CH); noteChannelKeyReceived(CH); });
        let end = () => {};
        act(() => { end = beginChannelPageDecrypt(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.building.title);
        act(() => { end(); });
        // rows still all pills: the key was for another epoch
        expect(title()).toBe(KEY_WAIT_COPY.building.title);
        act(() => { vi.advanceTimersByTime(KEY_WAIT_REGRESSION_HOLD_MS + 10); });
        expect(title()).toBe(KEY_WAIT_COPY.asked.title);
    });
});

describe('leaving', () => {
    it('hands over to the list once the page is readable: list fades in under the exiting layer, then the layer is gone', () => {
        const pills = page(100, pill);
        render(pills);
        let end = () => {};
        act(() => { noteChannelKeyReceived(CH); end = beginChannelPageDecrypt(CH); });
        const readable = pills.map(p => ({ ...p, content: { type: 'text', text: 'x' } }));
        act(() => { end(); });
        render(readable);
        expect(layer()!.classList.contains('is-exiting')).toBe(true);
        expect(list()!.classList.contains('ckw-list-in')).toBe(true);
        expect(host.querySelectorAll('.row')).toHaveLength(100);
        // stage frozen while leaving (the decrypt that finished is not read
        // as "that key failed" just because the rows land a beat later)
        expect(title()).toBe(KEY_WAIT_COPY.building.title);
        act(() => { vi.advanceTimersByTime(KEY_WAIT_EXIT_MS + 10); });
        expect(layer()).toBeNull();
        expect(list()!.classList.contains('ckw-list-in')).toBe(false);
    });
    it('holds while a page decrypt is still folding rows in (no half-pill page)', () => {
        render(page(100, pill));
        let end = () => {};
        act(() => { noteChannelKeyReceived(CH); end = beginChannelPageDecrypt(CH); });
        // one live message decrypted first; the page's decrypt is still running
        render([...page(99, pill), msg()]);
        expect(lastState!.phase).toBe('shown');
        expect(list()).toBeNull();
        act(() => { end(); });
        expect(lastState!.phase).toBe('exiting');
    });
    it('…but not forever', () => {
        render(page(100, pill));
        act(() => { beginChannelPageDecrypt(CH); }); // never ends
        render([...page(99, pill), msg()]);
        expect(lastState!.phase).toBe('shown');
        act(() => { vi.advanceTimersByTime(KEY_WAIT_DECRYPT_HOLD_MS + 10); });
        expect(lastState!.phase).toBe('exiting');
    });
    it('never comes back for the same pane (a later undecryptable live row cannot flicker it)', () => {
        render(page(3, pill));
        render([...page(3, pill), msg()]);
        act(() => { vi.advanceTimersByTime(KEY_WAIT_EXIT_MS + 10); });
        expect(layer()).toBeNull();
        render(page(5, pill));
        expect(layer()).toBeNull();
        expect(host.querySelectorAll('.row')).toHaveLength(5);
    });
});

describe('reduced motion', () => {
    it('renders the full picture statically: lock, rows and copy present, no bloom, no outgoing copy layer', () => {
        reduce = true;
        render(page(100, pill));
        expect(lastState!.reduced).toBe(true);
        expect(layer()!.hasAttribute('data-reduced')).toBe(true);
        expect(host.querySelector('.ckw-lock')).not.toBeNull();
        expect(host.querySelectorAll('.ckw-ghost').length).toBeGreaterThan(0);
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);
        act(() => { noteChannelKeyReceived(CH); });
        // text still updates, instantly, with nothing stacked behind it
        expect(title()).toBe(KEY_WAIT_COPY.received.title);
        expect(host.querySelector('.ckw-copy-out')).toBeNull();
        expect(host.querySelector('.ckw-bloom')).toBeNull();
    });
    it('control: with motion on, the outgoing copy crossfades and the bloom plays', () => {
        render(page(100, pill));
        act(() => { noteChannelKeyReceived(CH); });
        expect(host.querySelector('.ckw-copy-out')).not.toBeNull();
        expect(host.querySelector('.ckw-bloom')).not.toBeNull();
        act(() => { vi.advanceTimersByTime(400); });
        expect(host.querySelector('.ckw-copy-out')).toBeNull();
    });
    it('exit is the short fade', () => {
        reduce = true;
        render(page(3, pill));
        render([...page(3, pill), msg()]);
        expect(lastState!.phase).toBe('exiting');
        act(() => { vi.advanceTimersByTime(KEY_WAIT_REDUCED_EXIT_MS + 5); });
        expect(layer()).toBeNull();
    });
    it('window hidden pauses the loops', () => {
        render(page(3, pill));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(layer()!.hasAttribute('data-paused')).toBe(true);
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(layer()!.hasAttribute('data-paused')).toBe(false);
    });
});

describe('stylesheet rules (key-wait.css)', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'key-wait.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)];
    const ruleBodies = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));

    it('keyframes animate only transform/opacity and reference no custom property', () => {
        expect(keyframes.length).toBeGreaterThan(5);
        for (const [, name, body] of keyframes) {
            const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
            for (const p of props) expect([name, p]).toEqual([name, expect.stringMatching(/^(transform|opacity)$/)]);
            expect(body).not.toMatch(/var\(/);
        }
    });
    it('transitions name only transform/opacity; no filter, backdrop-filter or box-shadow', () => {
        for (const { body } of ruleBodies) {
            for (const m of body.matchAll(/transition\s*:\s*([^;]+)/g)) {
                // split on top-level commas only (cubic-bezier has its own)
                for (const part of m[1].split(/,(?![^(]*\))/)) expect(part.trim()).toMatch(/^(transform|opacity|none)\b/);
            }
        }
        expect(css).not.toMatch(/(^|[\s;{])(filter|backdrop-filter|box-shadow)\s*:/);
    });
    it('every intro fills backwards (resting = visible), every outro rests at opacity 0', () => {
        for (const { sel, body } of ruleBodies) {
            const m = body.match(/animation\s*:\s*([^;]+)/);
            if (!m || /none/.test(m[1])) continue;
            expect(m[1]).not.toMatch(/\bforwards\b|\bboth\b/);
            if (/copy-out|bloom/.test(m[1])) expect(body, sel).toMatch(/opacity:\s*0\s*;/);
        }
    });
    it('control: the rule scanners catch a bad rule', () => {
        const bad = '@keyframes x{from{width:0}}';
        const [k] = [...bad.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)];
        expect([...k[2].matchAll(/([a-z-]+)\s*:/g)].map(m => m[1])).toEqual(['width']);
    });
    it('reduced motion turns every animation off and keeps only short opacity fades', () => {
        const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
        expect(at).toBeGreaterThan(-1);
        const block = css.slice(at);
        expect(block).toMatch(/\.ckw-root \*[^{]*\{\s*animation:\s*none !important/);
        expect(block).toMatch(/\.ckw-shackle\s*\{\s*transition:\s*none/);
        for (const m of block.matchAll(/(\d+)ms/g)) expect(Number(m[1])).toBeLessThanOrEqual(160);
        for (const m of block.matchAll(/animation:\s*([\w-]+)\s/g)) expect(m[1]).toMatch(/^(none|ckw-fade-in)$/);
    });
    it('loops pause while hidden', () => {
        expect(css).toMatch(/\.ckw-root\[data-paused\] \*\s*\{\s*animation-play-state:\s*paused/);
    });
});
