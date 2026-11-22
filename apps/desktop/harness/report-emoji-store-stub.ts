// In-memory stand-in for secureLocalStore (harness only), default and named export.
const m = new Map<string, string>();
export const secureLocalStore = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    whenAccountReady: () => Promise.resolve(),
};
export default secureLocalStore;
