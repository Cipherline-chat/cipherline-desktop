import { useEffect, useState } from 'react';

/**
 * Returns `true` when the Cipherline window is focused (visible and in the
 * foreground), `false` when the user has clicked away or minimised.
 *
 * Listens to three complementary signals so the flag is accurate even in
 * edge-cases (e.g. alt-tabbing, system notifications stealing focus):
 *   • `window.focus` / `window.blur`        — standard focus events
 *   • `document.visibilitychange`            — tab / minimise / OS switch
 */
export function useWindowFocus(): boolean {
    const [focused, setFocused] = useState<boolean>(
        !document.hidden && document.hasFocus()
    );

    useEffect(() => {
        const onFocus   = () => setFocused(true);
        const onBlur    = () => setFocused(false);
        const onVisible = () => setFocused(!document.hidden && document.hasFocus());

        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    return focused;
}
