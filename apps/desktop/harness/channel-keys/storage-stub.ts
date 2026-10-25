// In-memory stand-in for electron/storage's SecureStore (one per harness device
// process). Everything else in the electron crypto modules runs as shipped.
const store = new Map<string, string>();
export const secureStore = {
    initialize: async () => undefined,
    isReady: () => true,
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => { store.set(k, v); },
    setDeferred: (k: string, v: string) => { store.set(k, v); },
    setMany: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
    delete: (k: string) => { store.delete(k); },
    deleteDeferred: (k: string) => { store.delete(k); },
    keys: () => [...store.keys()],
    keysWithPrefix: (p: string) => [...store.keys()].filter(k => k.startsWith(p)),
    batch: <T>(fn: () => T): T => fn(),
    whenDurable: async () => undefined,
    flush: async () => undefined,
};
