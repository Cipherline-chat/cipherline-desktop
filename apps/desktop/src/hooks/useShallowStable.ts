import { useState } from 'react';
import { shallowValueEqual } from '../utils/renderMemo';

/**
 * Returns the previously returned reference for as long as `value` stays
 * shallow-equal to it (arrays, Sets, plain objects; `depth` 2 also compares
 * one level further down).
 *
 * Dashboard passes several ChatPane props as `x[id] || []` / `?? {}` — a brand
 * new empty array/object on every Dashboard render — and anything keyed on
 * their identity (a memo, a message row's dependency list) was invalidated on
 * every presence or typing event. Uses the documented "adjust state while
 * rendering" pattern: when the contents really change, the new value is kept
 * and returned at once.
 */
export function useShallowStable<T>(value: T, depth = 1): T {
    const [kept, setKept] = useState(value);
    if (!Object.is(kept, value) && !shallowValueEqual(kept, value, depth)) {
        setKept(value);
        return value;
    }
    return kept;
}
