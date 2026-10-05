import { useEffect, useRef, useState, type RefObject } from 'react';

/** What `QrSignInController` and `TransferQrController` have in common. */
export interface LinkPanelController<S> {
    getSnapshot(): S;
    subscribe(listener: (s: S) => void): () => void;
    dispose(): void;
}

/**
 * Owns a QR panel controller's whole lifetime: CREATED in the mount effect,
 * DISPOSED in that effect's cleanup — never built during render.
 *
 * Both QR panels used to do `if (!ref.current) ref.current = new Controller()`
 * during render and `controller.dispose()` in the effect cleanup. That pairing
 * is broken under React's development StrictMode, which mounts, unmounts and
 * re-mounts every component once: the ref (and so the one controller) survives
 * the simulated unmount, the dispose does not undo itself, and the re-mount
 * subscribes to a controller that is already dead. Every later state change
 * was a silent no-op — "Show a code" did nothing — in every dev build, while
 * production (no double mount) worked. Creating the controller inside the
 * effect makes each mount own exactly one live controller and each unmount
 * dispose exactly that one, which holds under StrictMode, Fast Refresh and a
 * real unmount alike.
 *
 * `create` is read through a ref, so it may close over values that change
 * between renders; it is called once per mount, not once per render.
 * `controllerRef.current` is null until the mount effect has run (the panels
 * render their idle state until then, which calls nothing) and after unmount.
 */
export function useLinkController<S, C extends LinkPanelController<S>>(
    create: () => C,
    initial: S,
): { snapshot: S; controllerRef: RefObject<C | null> } {
    const controllerRef = useRef<C | null>(null);
    const createRef = useRef(create);
    useEffect(() => { createRef.current = create; });

    const [snapshot, setSnapshot] = useState<S>(initial);

    useEffect(() => {
        const controller = createRef.current();
        controllerRef.current = controller;
        setSnapshot(controller.getSnapshot());
        const unsubscribe = controller.subscribe(setSnapshot);
        return () => {
            unsubscribe();
            // Never leave the main process holding an ephemeral key (sign-in)
            // or a countdown running (transfer) for a panel nothing shows.
            controller.dispose();
            if (controllerRef.current === controller) controllerRef.current = null;
        };
    }, []);

    return { snapshot, controllerRef };
}
