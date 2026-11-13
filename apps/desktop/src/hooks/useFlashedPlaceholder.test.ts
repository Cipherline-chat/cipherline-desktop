// @vitest-environment jsdom
/**
 * Regression: "after I send a message the 'Message…' placeholder goes away and
 * never comes back". The composer's placeholder override (egg lines after a
 * send, an empty send, erasing a draft, arrow-up shrug) used to setAttribute
 * then removeAttribute('placeholder') on the DOM node; React never rewrote the
 * unchanged prop, so the attribute stayed gone. The override is now state, and
 * the textarea's placeholder prop always renders the right line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFlashedPlaceholder } from './useFlashedPlaceholder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'Message…';
let flash: (line: string, ms?: number) => void = () => {};
let setBase: (b: string) => void = () => {};
let send: () => void = () => {};
let type: (v: string) => void = () => {};
let root: Root;
let host: HTMLDivElement;

/** A miniature composer: same placeholder wiring and same value lifecycle as
 *  ChatPane's textarea (controlled value, cleared on send, focused throughout). */
const Composer: React.FC = () => {
    const [flashed, flashFn] = useFlashedPlaceholder();
    const [base, setBaseState] = React.useState(BASE);
    const [value, setValue] = React.useState('');
    flash = flashFn;
    setBase = setBaseState;
    type = setValue;
    send = () => { setValue(''); flashFn('the clock just struck', 2400); };
    return React.createElement('textarea', {
        id: 'ta', value, placeholder: flashed ?? base, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setValue(e.target.value),
    });
};
const ta = () => host.querySelector('#ta') as HTMLTextAreaElement;

beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Composer)));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

describe('useFlashedPlaceholder', () => {
    it('shows the normal placeholder initially', () => {
        expect(ta().getAttribute('placeholder')).toBe(BASE);
    });

    it('flash shows the line, then the normal placeholder comes BACK (attribute present again)', () => {
        act(() => flash('nothing to send'));
        expect(ta().getAttribute('placeholder')).toBe('nothing to send');
        act(() => { vi.advanceTimersByTime(2400); });
        expect(ta().hasAttribute('placeholder')).toBe(true);
        expect(ta().getAttribute('placeholder')).toBe(BASE);
    });

    it('stays correct across many flashes (the old code lost it for good after the first)', () => {
        for (let i = 0; i < 3; i++) {
            act(() => flash(`line ${i}`));
            expect(ta().getAttribute('placeholder')).toBe(`line ${i}`);
            act(() => { vi.advanceTimersByTime(2400); });
            expect(ta().getAttribute('placeholder')).toBe(BASE);
        }
    });

    it('a second flash replaces the first and restarts the single timer', () => {
        act(() => flash('first', 1000));
        act(() => { vi.advanceTimersByTime(900); });
        act(() => flash('second', 1000));
        act(() => { vi.advanceTimersByTime(500); });
        expect(ta().getAttribute('placeholder')).toBe('second');   // first's timer did not cut it short
        act(() => { vi.advanceTimersByTime(500); });
        expect(ta().getAttribute('placeholder')).toBe(BASE);
    });

    it('a base placeholder that changes mid-flash is what returns after it', () => {
        act(() => flash('shrug'));
        act(() => setBase('Add a caption…'));
        expect(ta().getAttribute('placeholder')).toBe('shrug');
        act(() => { vi.advanceTimersByTime(2400); });
        expect(ta().getAttribute('placeholder')).toBe('Add a caption…');
    });

    it('send -> empty -> placeholder visible, while the box keeps focus', () => {
        ta().focus();
        act(() => type('hello'));
        expect(ta().value).toBe('hello');
        act(() => send());
        expect(ta().value).toBe('');
        expect(document.activeElement).toBe(ta());
        act(() => { vi.advanceTimersByTime(2400); });
        expect(ta().value).toBe('');
        expect(ta().getAttribute('placeholder')).toBe(BASE);
        expect(document.activeElement).toBe(ta());
    });

    it('deleting all text leaves the placeholder showing (empty value + attribute)', () => {
        act(() => type('abc'));
        act(() => type(''));
        expect(ta().value).toBe('');
        expect(ta().getAttribute('placeholder')).toBe(BASE);
    });

    it('unmounting mid-flash cancels the timer (no late state update)', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => flash('bye'));
        act(() => root.unmount());
        act(() => { vi.advanceTimersByTime(5000); });
        expect(err).not.toHaveBeenCalled();
        err.mockRestore();
        root = createRoot(host);   // afterEach unmounts again
    });
});

describe('ChatPane wiring', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/ChatPane.tsx'), 'utf8');

    it('never mutates the textarea placeholder attribute by hand', () => {
        expect(src).not.toMatch(/setAttribute\(\s*['"]placeholder['"]/);
        expect(src).not.toMatch(/removeAttribute\(\s*['"]placeholder['"]/);
    });

    it('renders the flash through the placeholder prop, falling back to the normal lines', () => {
        expect(src).toMatch(/placeholder=\{\s*flashedPlaceholder \?\? \(keyMissing/);
        expect(src).toContain("(lateNightPlaceholder ?? 'Message…')");
    });

    it('is the only composer textarea (DMs, groups, channels, threads, edit all share it)', () => {
        expect((src.match(/<textarea/g) ?? []).length).toBe(1);
    });
});
