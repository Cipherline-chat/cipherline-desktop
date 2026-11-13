/* eslint-disable -- harness stub, not shipped */
// In-memory stand-in for utils/secureLocalStore: the tile only keeps volumes in it.
const data = new Map<string, string>();
const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    whenAccountReady: () => Promise.resolve(),
    isHydrated: () => true,
};
export default store;
export { store as secureLocalStore };
