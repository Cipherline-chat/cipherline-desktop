/**
 * keyClaims: lets a full-focus surface take a key combo away from the app's
 * global hotkeys while it is open.
 *
 * The Home easter-egg game (FirewallOverlay) plays on Space. A user can bind
 * plain Space to a keybind (Settings → Keybinds accepts bare keys) or to
 * push-to-talk, and those listeners run in the capture phase on `window`,
 * registered long before the game opens, so the game's own listener cannot
 * get in front of them. Instead the game CLAIMS the combo, and the keybind
 * dispatcher (useGlobalKeybindListener) and push-to-talk (SidebarConference)
 * skip a claimed combo. Releasing the claim (the game closing) gives it back.
 *
 * Combos use useKeybinds' encoding (`eventToCombo`): lowercase, `space` for
 * the space bar, modifiers as `ctrl+alt+shift+` prefixes. Claims are counted,
 * so two claimants of the same combo each release only their own.
 */

const claims = new Map<string, number>();

/** Claim `combo` until the returned function is called (idempotent). */
export function claimKeyCombo(combo: string): () => void {
    const k = combo.toLowerCase();
    claims.set(k, (claims.get(k) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (claims.get(k) ?? 1) - 1;
        if (n <= 0) claims.delete(k);
        else claims.set(k, n);
    };
}

/** Is `combo` currently claimed by an open surface? */
export function isKeyComboClaimed(combo: string | null | undefined): boolean {
    return !!combo && claims.has(combo.toLowerCase());
}

/** Test-only. */
export function __resetKeyClaims(): void {
    claims.clear();
}
