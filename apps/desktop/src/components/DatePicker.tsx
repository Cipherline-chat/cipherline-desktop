import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClSelect } from './cl';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import {
    MONTH_LABELS, daysInMonth, parseIsoDate, formatIsoDate, formatMdyDate,
    applyDobEdit, checkTypedDob, resolveTypedDate, type IsoDateParts,
} from '../utils/isoDate';

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * Where the calendar POPUP opens when there is no value yet — deliberately
 * NOT derived from `Date.now()`, `new Date()`, or any age arithmetic. A
 * picker that opened on "13 years ago today" would visually hand the user
 * the exact COPPA cutoff the moment they open it, which defeats the point of
 * a neutral date-of-birth gate (CLAUDE.md's "neutral entry" requirement, and
 * the actual age check happens server-side on submit — apps/api/src/auth/
 * auth.service.ts:399 — never here). A fixed, hardcoded anchor is the only
 * shape that can NEVER leak the threshold: it doesn't move as "today" moves,
 * so it can't be read as "N years back from now" by construction. January
 * 1990 is chosen only because it's a round, memorable spot that keeps the
 * common case (most registering adults) a short scroll away — it carries no
 * other significance and must never be replaced with a `currentYear - k`
 * computation of any kind.
 */
const NEUTRAL_YEAR = 1990;
const NEUTRAL_MONTH = 0; // January

const DOB_FORMAT_HINT = 'MM/DD/YYYY';
const ERROR_INVALID = 'Enter your date of birth as MM/DD/YYYY (e.g. 01/31/1990), or pick it from the calendar.';
const ERROR_FUTURE = 'That date is in the future.';

/** Local "today" for the not-in-the-future check. Read at event time, never at module load. */
const todayParts = (): IsoDateParts => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
};

const isoToDisplay = (iso: string): string => {
    const p = parseIsoDate(iso);
    return p ? formatMdyDate(p.y, p.m, p.d) : '';
};

export interface DatePickerProps {
    /** Rendered as a left-inset icon, matching AuthScreen's `Field` treatment. */
    icon?: React.ReactNode;
    placeholder?: string;
    /** `'YYYY-MM-DD'` or `''` — same wire format the native `<input type="date">`
     *  this replaces already produced, so no downstream consumer needs to change.
     *  (The field DISPLAYS and accepts `MM/DD/YYYY`; that is purely a view.) */
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    /** Accessible name for the trigger button (falls back to `placeholder`). */
    ariaLabel?: string;
    /** Oldest selectable/typeable year. No age-based floor here on purpose —
     *  the server is the sole authority on what's acceptable (see the module
     *  doc above); this only bounds how far back the year list scrolls and
     *  rejects typed years before it. */
    minYear?: number;
    /** Newest selectable year. Defaults to the current year — deliberately
     *  NOT offset to exclude "too-young" years, and nothing about a year
     *  near the boundary is styled, disabled, or flagged any differently
     *  from any other year: no inline hint about which dates are acceptable. */
    maxYear?: number;
}

/**
 * A calendar date-of-birth picker matching the "glow in the deep" design
 * system (reuses `ClButton`/`ClSelect` from `cl/` and the shared `.inp`
 * trigger surface — no bespoke control styling invented). Lives OUTSIDE
 * `cl/` deliberately: it's the only date picker in the app today (checked —
 * no other consumer exists), and `cl/` primitives are also consumed by
 * `apps/website` via the `@app-cl` alias, so adding to that folder widens
 * the website's build surface for a feature that currently has exactly one
 * caller. If a second consumer shows up later, promoting it into `cl/` is a
 * pure move with no behavior change. This mirrors how `StatusPicker.tsx` /
 * `EmojiPicker.tsx` / `GifPicker.tsx` already sit as top-level composed
 * popovers built FROM `cl/` primitives rather than living inside `cl/`
 * themselves.
 *
 * The trigger is a real `<input>`, not a button: clicking it still opens the
 * calendar exactly as before (same toggle-on-click), but it also accepts
 * keystrokes so the date can be TYPED instead of picked. The field shows and
 * accepts month/day/year (`MM/DD/YYYY`) with an auto-mask (digits only; the
 * slashes are inserted for you), while `value`/`onChange` stay ISO
 * `YYYY-MM-DD`. Both directions stay in sync through that single contract:
 * picking a day calls `onChange`, which is what makes the typed text follow it
 * (see the "external value changed" effect below); typing a complete, valid,
 * non-future date calls the SAME `onChange` (via `resolveTypedDate`, whose
 * real-calendar check is the one a picked day is built from — see
 * isoDate.ts), which is what makes the calendar's month/year follow the typed
 * text. Anything short of that (still mid-typing, impossible like 02/30, or in
 * the future) commits `''` so a stale earlier date can never ride along
 * unseen; the inline error appears only when the field is left (blur) or Enter
 * is pressed — never while the user is still typing.
 */
export const DatePicker: React.FC<DatePickerProps> = ({
    icon, placeholder = DOB_FORMAT_HINT, value, onChange, disabled, ariaLabel,
    minYear = 1900, maxYear = new Date().getFullYear(),
}) => {
    const parsed = useMemo(() => parseIsoDate(value), [value]);
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(() => parsed?.y ?? NEUTRAL_YEAR);
    const [viewMonth, setViewMonth] = useState(() => parsed?.m ?? NEUTRAL_MONTH);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const uid = useId();
    const hintId = `${uid}-hint`;
    const errorId = `${uid}-error`;

    // Typing support. `draft` is the masked text of the field (always
    // `MM/DD/YYYY`-shaped, possibly partial) — kept separate from `value` so a
    // partial keystroke never has to become a fake committed value.
    // `typedError` is set only by blur/Enter, and cleared by the next edit.
    const [draft, setDraft] = useState(() => isoToDisplay(value));
    const [typedError, setTypedError] = useState<'invalid' | 'future' | null>(null);
    // Caret to restore after the masked text re-renders (re-masking would
    // otherwise throw the caret to the end). The tick state forces a render
    // even when the masked text is unchanged (e.g. a 9th digit being ignored).
    const pendingCaret = useRef<number | null>(null);
    const [, setCaretTick] = useState(0);
    // The last value THIS component emitted, so the external-value effect can
    // tell its own commits from outside changes and not overwrite the draft.
    const selfEmitted = useRef<string | null>(null);

    // The year dropdown (ClSelect) portals its open menu to `document.body`
    // (`.selm.cl-portal`, see ClSelect.tsx) so it can escape this popover's
    // own stacking context — which means a click inside IT is not a DOM
    // descendant of `containerRef`. Without the `.cl-portal` escape hatch
    // here, picking a year would register as an "outside" click on THIS
    // popover: it would close the whole date picker and swallow the click
    // before ClSelect's own handler ever saw it, so the year would silently
    // fail to apply.
    const isInsideDatePicker = (target: Node) =>
        !!containerRef.current?.contains(target) || !!(target as Element).closest?.('.cl-portal');
    useDismissOnOutsideClick(isInsideDatePicker, open, () => setOpen(false));

    // Follow a value that changes from OUTSIDE this component (e.g. a form
    // reset, OR a day just picked in the calendar) so re-opening shows the
    // right month — but don't re-run this on every render, or it would fight
    // the user's own in-popover navigation (e.g. paging to a different month
    // without having picked a day yet). This is also the ONE place `draft`
    // is pulled back into sync with a pick: `pick()` below only calls
    // `onChange`. A value this component emitted itself (a typed commit or
    // clear) leaves the draft alone — the user is mid-edit.
    const lastValueRef = useRef(value);
    useEffect(() => {
        if (value !== lastValueRef.current) {
            lastValueRef.current = value;
            const own = selfEmitted.current === value;
            selfEmitted.current = null;
            if (!own) {
                setDraft(isoToDisplay(value));
                setTypedError(null);
            }
            const p = parseIsoDate(value);
            if (p) { setViewYear(p.y); setViewMonth(p.m); }
        }
    }, [value]);

    useLayoutEffect(() => {
        if (pendingCaret.current !== null && inputRef.current) {
            inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
            pendingCaret.current = null;
        }
    });

    useEscape(() => setOpen(false), open);

    const emit = (next: string) => {
        if (next === value) return;
        selfEmitted.current = next;
        onChange(next);
    };

    // Runs on every edit (keystroke, paste, autofill, delete). Re-masks the
    // text, and commits ONLY a complete valid non-future date (as ISO) or an
    // explicit clear — see resolveTypedDate's contract in isoDate.ts. Never
    // shows an error: that waits for blur/Enter.
    const handleTypedInput = (el: HTMLInputElement) => {
        const { text, caret } = applyDobEdit(draft, el.value, el.selectionStart ?? el.value.length);
        pendingCaret.current = caret;
        setCaretTick(t => t + 1);
        setDraft(text);
        setTypedError(null);
        const resolved = resolveTypedDate(text, todayParts(), minYear);
        if (resolved === null) {
            emit('');
            return;
        }
        emit(resolved);
        const p = parseIsoDate(resolved);
        if (p) { setViewYear(p.y); setViewMonth(p.m); }
    };

    // Flag anything left over that never resolved to a valid date — visibly,
    // rather than silently discarding what was typed.
    const validate = () => {
        const r = checkTypedDob(draft, todayParts(), minYear);
        if (r.status === 'future') setTypedError('future');
        else if (r.status === 'incomplete' || r.status === 'invalid') setTypedError('invalid');
        else setTypedError(null);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        // Focus moving into the calendar popover (a day button) is part of
        // picking, not "leaving the field": showing the error here would shift
        // the popover down under the cursor mid-click.
        const next = e.relatedTarget as Node | null;
        if (next && isInsideDatePicker(next)) return;
        validate();
    };

    // A real scrollable list (via ClSelect) rather than a plain input — so
    // jumping from, say, 2026 to 1975 is one click, not 51 clicks back
    // through individual months.
    const years = useMemo(() => {
        const arr: { value: string; label: string }[] = [];
        for (let y = maxYear; y >= minYear; y--) arr.push({ value: String(y), label: String(y) });
        return arr;
    }, [minYear, maxYear]);

    const goMonth = (delta: number) => {
        let m = viewMonth + delta;
        let y = viewYear;
        if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
        if (y < minYear || y > maxYear) return;
        setViewMonth(m);
        setViewYear(y);
    };

    const pick = (d: number) => {
        onChange(formatIsoDate(viewYear, viewMonth, d));
        setOpen(false);
    };

    const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
    const numDays = daysInMonth(viewYear, viewMonth);
    const cells: (number | null)[] = [
        ...Array.from({ length: firstWeekday }, () => null),
        ...Array.from({ length: numDays }, (_, i) => i + 1),
    ];

    const errorText = typedError === 'future' ? ERROR_FUTURE : typedError === 'invalid' ? ERROR_INVALID : null;

    return (
        <div ref={containerRef} className="relative">
            {/* The icon is positioned against THIS wrapper (input + icon only),
                not the outer container — the outer one also holds the error
                text and the calendar popover, and when it grew the icon
                (top-1/2) drifted down off the input. */}
            <div className="relative" data-testid="date-input-wrap">
                {icon && (
                    <span
                        className="absolute left-3.5 top-1/2 -translate-y-1/2 flex pointer-events-none"
                        style={{ color: 'var(--cl-faint)' }}
                    >
                        {icon}
                    </span>
                )}
                <input
                    ref={inputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="bday"
                    spellCheck={false}
                    className="inp"
                    style={{
                        textAlign: 'left',
                        paddingLeft: icon ? 44 : undefined,
                        cursor: disabled ? 'default' : 'text',
                        opacity: disabled ? 0.6 : 1,
                        ...(errorText ? { borderColor: 'var(--cl-flash)' } : {}),
                    }}
                    value={draft}
                    placeholder={placeholder}
                    // Preserves the original click-to-toggle exactly: a click both
                    // focuses the input (native) and toggles the popup (this
                    // handler), same as the old button did.
                    onClick={() => !disabled && setOpen(o => !o)}
                    onBlur={handleBlur}
                    onChange={e => handleTypedInput(e.target)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            validate();
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    disabled={disabled}
                    role="combobox"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-invalid={errorText ? true : undefined}
                    aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
                    aria-label={ariaLabel ?? placeholder}
                />
            </div>
            <span id={hintId} className="sr-only">Month, day, year, as {DOB_FORMAT_HINT}. Or pick it from the calendar.</span>
            {errorText && (
                <p id={errorId} role="alert" className="text-xs mt-1" style={{ color: 'var(--cl-flash)' }}>
                    {errorText}
                </p>
            )}

            {open && (
                <div
                    role="dialog"
                    aria-label="Choose a date"
                    className="absolute mt-2 p-3 rounded-2xl shadow-2xl bg-cl-deep border border-cl-border"
                    style={{ zIndex: 100, width: 300 }}
                >
                    <div className="flex items-center justify-between gap-1 mb-2.5">
                        {/* ClButton has no `aria-label` prop (`tooltip` only wires
                            `aria-describedby`, not an accessible NAME), so an
                            icon-only button needs its own sr-only text — the
                            standard pattern, and it costs nothing in `cl/`. */}
                        <ClButton icon variant="ghost" size="sm" onClick={() => goMonth(-1)} tooltip="Previous month">
                            <ChevronLeft size={15} />
                            <span className="sr-only">Previous month</span>
                        </ClButton>
                        <div className="flex items-center gap-1.5 flex-1 justify-center min-w-0">
                            <span
                                className="text-sm font-bold truncate"
                                style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)' }}
                            >
                                {MONTH_LABELS[viewMonth]}
                            </span>
                            <div style={{ width: 96 }}>
                                <ClSelect
                                    options={years}
                                    value={String(viewYear)}
                                    onChange={v => setViewYear(Number(v))}
                                    ariaLabel="Year"
                                />
                            </div>
                        </div>
                        <ClButton icon variant="ghost" size="sm" onClick={() => goMonth(1)} tooltip="Next month">
                            <ChevronRight size={15} />
                            <span className="sr-only">Next month</span>
                        </ClButton>
                    </div>

                    <div className="grid grid-cols-7 gap-1 mb-1">
                        {WEEKDAY_LABELS.map(w => (
                            <div
                                key={w}
                                className="text-center text-[10px] font-bold uppercase"
                                style={{ color: 'var(--cl-faint)' }}
                            >
                                {w}
                            </div>
                        ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                        {cells.map((d, i) => {
                            if (d === null) return <div key={`blank-${i}`} />;
                            const isSelected = !!parsed && parsed.y === viewYear && parsed.m === viewMonth && parsed.d === d;
                            return (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => pick(d)}
                                    className="text-xs font-semibold rounded-lg transition-colors"
                                    style={{
                                        height: 30,
                                        color: isSelected ? 'var(--cl-abyss)' : 'var(--cl-text)',
                                        background: isSelected ? 'var(--cl-lume)' : 'transparent',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontWeight: isSelected ? 800 : 600,
                                    }}
                                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                >
                                    {d}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default DatePicker;
