import { useEffect, useState } from 'react';
import type zxcvbnType from 'zxcvbn';

/**
 * Lazy zxcvbn.
 *
 * zxcvbn builds its ranked frequency dictionaries when its module is first
 * evaluated. It used to be a static import of AuthScreen (which App imports),
 * so that dictionary build ran during the app's boot module evaluation on
 * EVERY launch — including every launch of an already-signed-in user who never
 * sees a password field. The freeze harness measured it as the largest single
 * item of boot-time script evaluation (`build_ranked_dict` + its CommonJS
 * wrapper). Now it is loaded the first time a password strength is actually
 * needed, in its own chunk.
 *
 * Policy is unchanged: the registration / reset / change-password gates still
 * require score >= 3 — they `await loadZxcvbn()` before deciding, so a check
 * can never pass because the library had not loaded yet.
 */
export type Zxcvbn = typeof zxcvbnType;

let impl: Zxcvbn | null = null;
let loading: Promise<Zxcvbn> | null = null;

export function loadZxcvbn(): Promise<Zxcvbn> {
    if (impl) return Promise.resolve(impl);
    if (!loading) {
        loading = import('zxcvbn').then(m => {
            const fn = ((m as unknown as { default?: Zxcvbn }).default ?? (m as unknown as Zxcvbn));
            impl = fn;
            return fn;
        }).catch(e => {
            loading = null; // allow a retry
            throw e;
        });
    }
    return loading;
}

/**
 * zxcvbn once it is loaded (null until then). Starts loading only when
 * `needed` is true, so a screen that merely COULD show a strength meter does
 * not pay for it.
 */
export function useZxcvbn(needed: boolean): Zxcvbn | null {
    const [z, setZ] = useState<Zxcvbn | null>(impl);
    useEffect(() => {
        if (z || !needed) return;
        let live = true;
        loadZxcvbn().then(fn => { if (live) setZ(() => fn); }).catch(() => { /* meter stays hidden; submit re-tries the load */ });
        return () => { live = false; };
    }, [needed, z]);
    return z;
}
