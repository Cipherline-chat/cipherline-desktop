// In-memory stand-in for src/utils/secureLocalStore (the renderer's encrypted
// IndexedDB facade). The TOFU pin store (keyVerification.ts) reads and writes
// through it; here it is per-process memory, so pinning runs for real.
const m = new Map<string, string>();
class Store {
    getItem(k: string): string | null { return m.get(k) ?? null; }
    setItem(k: string, v: string): void { m.set(k, String(v)); }
    removeItem(k: string): void { m.delete(k); }
    keysWithPrefix(p: string): string[] { return [...m.keys()].filter(k => k.startsWith(p)); }
    keys(): string[] { return [...m.keys()]; }
    isHydrated(): boolean { return true; }
    async hydrate(): Promise<void> { /* nothing to load */ }
    async whenAccountReady(): Promise<void> { /* always ready */ }
    subscribe(): () => void { return () => undefined; }
}
export const REBIND_DELAY_MS = 2_000;
export const secureLocalStore = new Store();
export default secureLocalStore;
