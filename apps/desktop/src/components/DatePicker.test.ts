// @vitest-environment jsdom
/**
 * DatePicker as the signup form uses it: the field is typed or picked as
 * MM/DD/YYYY, while `value`/`onChange` stay ISO YYYY-MM-DD (what AuthScreen
 * sends). Pinned here:
 *   - the auto-mask while typing, backspace across a slash, paste variants;
 *   - invalid dates (02/30, 13/01, future, year < 1900) never commit;
 *   - the inline error appears on blur/Enter only, never while typing;
 *   - a calendar pick fills the field as MM/DD/YYYY and onChange gets ISO;
 *   - the calendar icon lives in the input's own wrapper, so a growing error
 *     or popover cannot drag it off the input.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DatePicker } from './DatePicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ClSelect's import graph reaches utils/clPhysics.ts, which calls
// window.matchMedia at module load (throws under jsdom otherwise). Hoisted so
// it runs before the static imports above are evaluated.
vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

const h = React.createElement;

const ERROR_INVALID = 'Enter your date of birth as MM/DD/YYYY (e.g. 01/31/1990), or pick it from the calendar.';
const ERROR_FUTURE = 'That date is in the future.';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

interface Mounted {
    input: HTMLInputElement;
    onChange: ReturnType<typeof vi.fn>;
    setExternal: (v: string) => void;
}

/** Real parent state (like AuthScreen's `dob`), so controlled-value round trips are exercised. */
function mount(initial = ''): Mounted {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onChange = vi.fn();
    let external: (v: string) => void = () => {};
    const Parent: React.FC = () => {
        const [v, setV] = useState(initial);
        external = setV;
        return h(DatePicker, {
            icon: h('i', { 'data-testid': 'icon' }),
            placeholder: 'Date of birth (MM/DD/YYYY)',
            ariaLabel: 'Date of birth',
            value: v,
            onChange: (next: string) => { onChange(next); setV(next); },
        });
    };
    act(() => root!.render(h(Parent)));
    return {
        input: host.querySelector('input') as HTMLInputElement,
        onChange,
        setExternal: v => act(() => external(v)),
    };
}

const setNativeValue = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
};

/** Simulates the browser changing the field to `raw` with the caret at `caret`. */
function edit(el: HTMLInputElement, raw: string, caret: number = raw.length) {
    act(() => {
        setNativeValue(el, raw);
        el.setSelectionRange(caret, caret);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Types characters one at a time at the end of the field, like a keyboard. */
function typeKeys(el: HTMLInputElement, keys: string) {
    for (const ch of keys) edit(el, el.value + ch);
}

const alertEl = () => host!.querySelector('[role="alert"]');
const focusAndBlur = (el: HTMLInputElement) => {
    act(() => el.focus());
    act(() => el.blur());
};

describe('DatePicker (MM/DD/YYYY entry)', () => {
    describe('the mask while typing', () => {
        it('shows the mask after each keystroke and inserts the slashes itself', () => {
            const { input } = mount();
            const seen: string[] = [];
            for (const ch of '09022003') {
                edit(input, input.value + ch);
                seen.push(input.value);
            }
            expect(seen).toEqual(['0', '09/', '09/0', '09/02/', '09/02/2', '09/02/20', '09/02/200', '09/02/2003']);
        });

        it('ignores digits past the 8th and non-digit characters', () => {
            const { input } = mount();
            edit(input, '09022003');
            expect(input.value).toBe('09/02/2003');
            edit(input, '09/02/20035');
            expect(input.value).toBe('09/02/2003');
            edit(input, 'ab');
            expect(input.value).toBe('');
        });

        it('pads a single digit when a slash is typed after it (9/ -> 09/)', () => {
            const { input } = mount();
            typeKeys(input, '9');
            expect(input.value).toBe('9');
            typeKeys(input, '/');
            expect(input.value).toBe('09/');
        });

        it('has the numeric keyboard, bday autofill, a MM/DD/YYYY placeholder and a description', () => {
            const { input } = mount();
            expect(input.getAttribute('inputmode')).toBe('numeric');
            expect(input.getAttribute('autocomplete')).toBe('bday');
            expect(input.getAttribute('placeholder')).toBe('Date of birth (MM/DD/YYYY)');
            const describedBy = input.getAttribute('aria-describedby');
            expect(describedBy).toBeTruthy();
            expect(document.getElementById(describedBy!.split(' ')[0])!.textContent).toContain('MM/DD/YYYY');
        });
    });

    describe('backspace across an auto slash', () => {
        it('removes the digit before the slash rather than leaving the caret stuck', () => {
            const { input } = mount();
            edit(input, '0902');
            expect(input.value).toBe('09/02/');
            // Backspace at the end: the browser deletes only the trailing "/".
            edit(input, '09/02');
            expect(input.value).toBe('09/0');
            edit(input, '09/');
            expect(input.value).toBe('09/');
            // Backspace over "09/" -> the "/" goes, the "9" must go with it.
            edit(input, '09');
            expect(input.value).toBe('0');
        });

        it('keeps the caret where the edit happened', () => {
            const { input } = mount();
            edit(input, '09022003');
            // Backspace right after the first slash (caret 3): browser yields "0902/2003", caret 2.
            edit(input, '0902/2003', 2);
            expect(input.selectionStart).toBe(1);
        });
    });

    describe('paste', () => {
        const cases: Array<[string, string]> = [
            ['09/02/2003', '09/02/2003'],
            ['9/2/2003', '09/02/2003'],
            ['09-02-2003', '09/02/2003'],
            ['09022003', '09/02/2003'],
            ['2003-09-02', '09/02/2003'],
        ];
        for (const [pasted, shown] of cases) {
            it(`accepts ${pasted}`, () => {
                const { input, onChange } = mount();
                edit(input, pasted);
                expect(input.value).toBe(shown);
                expect(onChange).toHaveBeenLastCalledWith('2003-09-02');
            });
        }
    });

    describe('committing', () => {
        it('commits ISO as soon as 8 valid digits are present, not before', () => {
            const { input, onChange } = mount();
            for (const ch of '0902200') edit(input, input.value + ch);
            expect(onChange).not.toHaveBeenCalled();
            edit(input, input.value + '3');
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith('2003-09-02');
        });

        it('editing a committed date into an incomplete one clears the committed value (no stale date rides along)', () => {
            const { input, onChange } = mount();
            edit(input, '09022003');
            edit(input, '09/02/200');
            expect(onChange).toHaveBeenLastCalledWith('');
            expect(input.value).toBe('09/02/200');
        });

        it('shows an externally set ISO value as MM/DD/YYYY', () => {
            const { input, setExternal } = mount();
            setExternal('2003-09-02');
            expect(input.value).toBe('09/02/2003');
            setExternal('');
            expect(input.value).toBe('');
        });

        it('starts from an existing ISO value as MM/DD/YYYY', () => {
            const { input } = mount('1990-01-31');
            expect(input.value).toBe('01/31/1990');
        });
    });

    describe('invalid dates never commit, and the error waits for blur/Enter', () => {
        const nextYear = new Date().getFullYear() + 1;
        const bad: Array<[string, string, string]> = [
            ['02/30/2000', '02302000', ERROR_INVALID],
            ['13/01/2000', '13012000', ERROR_INVALID],
            ['year < 1900', '01011899', ERROR_INVALID],
            ['a future date', `0101${nextYear}`, ERROR_FUTURE],
        ];
        for (const [label, digits, message] of bad) {
            it(`${label}: no ISO commit, no error while typing, error on blur`, () => {
                const { input, onChange } = mount();
                act(() => input.focus());
                for (const ch of digits) {
                    edit(input, input.value + ch);
                    expect(alertEl()).toBeNull();
                }
                expect(onChange.mock.calls.filter(([v]) => v !== '')).toEqual([]);
                act(() => input.blur());
                expect(alertEl()?.textContent).toBe(message);
                expect(input.getAttribute('aria-invalid')).toBe('true');
                expect(input.getAttribute('aria-describedby')).toContain(alertEl()!.id);
            });
        }

        it('an incomplete date errors on blur, and the next edit hides the error again', () => {
            const { input } = mount();
            act(() => input.focus());
            typeKeys(input, '0902');
            expect(alertEl()).toBeNull();
            act(() => input.blur());
            expect(alertEl()?.textContent).toBe(ERROR_INVALID);
            typeKeys(input, '2');
            expect(alertEl()).toBeNull();
        });

        it('Enter shows the error immediately without a blur having happened', () => {
            const { input } = mount();
            typeKeys(input, '0902');
            expect(alertEl()).toBeNull();
            act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
            expect(alertEl()?.textContent).toBe(ERROR_INVALID);
        });

        it('an empty field and a valid date show no error on blur', () => {
            const { input } = mount();
            focusAndBlur(input);
            expect(alertEl()).toBeNull();
            edit(input, '09022003');
            focusAndBlur(input);
            expect(alertEl()).toBeNull();
        });

        it('negative control: a valid date does commit ISO, so the assertions above can fail', () => {
            const { input, onChange } = mount();
            edit(input, '02292000'); // leap day, valid
            expect(onChange.mock.calls.filter(([v]) => v !== '')).toEqual([['2000-02-29']]);
        });
    });

    describe('the calendar', () => {
        const openCalendar = (input: HTMLInputElement) => act(() => input.click());
        const dayButton = (n: number) =>
            Array.from(host!.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === String(n)) as HTMLButtonElement;

        it('picking a day fills the field as MM/DD/YYYY and onChange receives ISO', () => {
            const { input, onChange } = mount();
            openCalendar(input);
            expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
            act(() => dayButton(15).click());
            expect(onChange).toHaveBeenLastCalledWith('1990-01-15'); // neutral January 1990 view
            expect(input.value).toBe('01/15/1990');
            expect(host!.querySelector('[role="dialog"]')).toBeNull();
        });

        it('picking after a half-typed entry replaces it and clears the error state', () => {
            const { input } = mount();
            act(() => input.focus());
            typeKeys(input, '09');
            openCalendar(input);
            act(() => dayButton(7).click());
            expect(input.value).toBe('01/07/1990');
            expect(alertEl()).toBeNull();
        });

        it('typing a valid date moves the calendar view to that month/year', () => {
            const { input } = mount();
            edit(input, '05101985');
            openCalendar(input);
            const dialog = host!.querySelector('[role="dialog"]')!;
            expect(dialog.textContent).toContain('May');
            expect(dialog.textContent).toContain('1985');
            // And the typed day is the highlighted one.
            expect(dayButton(10).style.fontWeight).toBe('800');
        });
    });

    describe('icon placement', () => {
        /** True when the icon shares its direct parent with the input and the error/popover sit outside it. */
        const iconStaysWithInput = (container: HTMLElement): boolean => {
            const icon = container.querySelector('[data-testid="icon"]')!;
            const input = container.querySelector('input')!;
            const wrap = input.parentElement!;
            const iconBox = icon.parentElement!; // the absolutely positioned span
            const extras = Array.from(container.querySelectorAll('[role="alert"], [role="dialog"]'));
            return iconBox.parentElement === wrap && extras.every(el => !wrap.contains(el));
        };

        it('the icon is a sibling of the input inside its own wrapper, error shown or not', () => {
            const { input } = mount();
            expect(iconStaysWithInput(host!)).toBe(true);
            act(() => input.focus());
            typeKeys(input, '0902');
            act(() => input.blur());
            expect(alertEl()).not.toBeNull();
            expect(iconStaysWithInput(host!)).toBe(true);
            // The wrapper holds only the icon and the input, so its height is the input's.
            expect(input.parentElement!.children).toHaveLength(2);
            // The error is not inside the icon's positioning context.
            expect(input.parentElement!.contains(alertEl())).toBe(false);
        });

        it('stays true with the calendar open as well', () => {
            const { input } = mount();
            act(() => input.click());
            expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
            expect(iconStaysWithInput(host!)).toBe(true);
        });

        it('negative control: the old layout (icon, input and error under one container) fails the same check', () => {
            const old = document.createElement('div');
            old.innerHTML =
                '<div class="relative"><span><i data-testid="icon"></i></span><input/><p role="alert">x</p></div>';
            // Same predicate, old structure: the error shares the icon's positioning parent.
            expect(iconStaysWithInput(old)).toBe(false);
        });
    });
});
