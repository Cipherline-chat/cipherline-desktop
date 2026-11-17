import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// "Modules tested alone, never registered" guard: the sync must actually be
// started by the signed-in app, and the rail hook must be what feeds it.
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('server_rail sync is wired in', () => {
    it('Dashboard mounts useServerRailSync with the account credentials', () => {
        const d = read('../components/Dashboard.tsx');
        expect(d).toMatch(/import \{ useServerRailSync \} from '\.\.\/hooks\/useServerRailSync'/);
        expect(d).toMatch(/useServerRailSync\(\{ userId, deviceId, token \}\)/);
    });
    it('the hook pulls on ready, focus, online and a poll; publishes on the rail-changed event; ignores its own restore event', () => {
        const h = read('./useServerRailSync.ts');
        expect(h).toMatch(/pullServerRail\(/);
        expect(h).toMatch(/publishServerRail\(/);
        expect(h).toMatch(/addEventListener\('focus'/);
        expect(h).toMatch(/addEventListener\('online'/);
        expect(h).toMatch(/setInterval\(/);
        expect(h).toMatch(/addEventListener\(RAIL_LAYOUT_CHANGED_EVENT/);
        expect(h).toMatch(/d\.source === RAIL_SYNC_EVENT_SOURCE/);
    });
    it('the rail layout hook announces user changes with the event the sync listens to', () => {
        const l = read('../components/rail/useServerRailLayout.ts');
        expect(l).toMatch(/new CustomEvent\(RAIL_LAYOUT_CHANGED_EVENT/);
        const s = read('../services/serverRailSyncService.ts');
        expect(s).toMatch(/RAIL_LAYOUT_CHANGED_EVENT = 'cipherline:server-rail-changed'/);
    });
});
