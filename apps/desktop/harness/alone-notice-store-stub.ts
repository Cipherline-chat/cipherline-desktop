// In-memory stand-in for secureLocalStore (harness only).
const m = new Map<string, string>();
export default { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
