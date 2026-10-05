/**
 * escapeStack — one owner for the Escape key.
 *
 * "Esc backs out of whatever you are doing" only works if exactly ONE thing
 * backs out per press. Before this, every surface that cared (confirm dialogs,
 * context menus, the message editor, pickers, panels) attached its own
 * window/document keydown listener, so a single Escape could close a dialog
 * AND cancel the edit underneath it AND fire the global close-panel keybind.
 *
 * The model is a LIFO stack of "layers". A surface registers while it is open;
 * the most recently registered layer is the one the user is looking at, and it
 * alone receives the press. Close it and the next Escape reaches the layer
 * below — so repeated presses walk back out one step at a time.
 *
 * One capture-phase window listener serves the whole app. Capture phase is
 * deliberate: it runs before React's root handlers and before any remaining
 * ad-hoc listener, and when a layer handles the key the event is stopped
 * outright, so nothing underneath also reacts. When the stack is EMPTY the
 * event is left untouched and flows to the rebindable `close-panel` keybind
 * and any native behaviour exactly as before.
 *
 * A layer handler may return `false` to decline a press (e.g. "nothing to do
 * right now"); the press then falls through to the layer beneath it.
 */

export type EscapeHandler = (event: KeyboardEvent) => void | boolean;

interface Layer {
    id: number;
    handler: EscapeHandler;
}

const layers: Layer[] = [];
let nextId = 1;
let installed = false;

function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // An IME composition uses Escape to dismiss its candidate window; that press
    // belongs to the text input, not to us.
    if (event.isComposing) return;

    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const result = layer.handler(event);
        if (result === false) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
}

function ensureInstalled(): void {
    if (installed || typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeyDown, { capture: true });
    installed = true;
}

/**
 * Register a layer. Returns an unregister function; call it when the surface
 * closes. Unregistering a layer that is not on top is fine — it is simply
 * removed, and the stack order of the others is unchanged.
 */
export function pushEscapeLayer(handler: EscapeHandler): () => void {
    ensureInstalled();
    const id = nextId++;
    layers.push({ id, handler });
    return () => {
        const idx = layers.findIndex(l => l.id === id);
        if (idx !== -1) layers.splice(idx, 1);
    };
}

/** Test-only: how many layers are registered. */
export function escapeLayerCount(): number {
    return layers.length;
}

/** Test-only: drop every layer and the listener so each test starts clean. */
export function __resetEscapeStackForTests(): void {
    layers.length = 0;
    if (installed && typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown, { capture: true });
    }
    installed = false;
}
