import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// Node's global crypto already implements subtle on 20+, but guard for older.
if (!(globalThis as any).crypto?.subtle) {
    (globalThis as any).crypto = webcrypto;
}

// Minimal window/document so modules that reference them at runtime don't throw.
// Tests set window.electronAPI per scenario.
const g = globalThis as any;
g.window = g.window || {};
g.window.addEventListener = g.window.addEventListener || (() => {});
g.document = g.document || { addEventListener: () => {}, visibilityState: 'visible' };
