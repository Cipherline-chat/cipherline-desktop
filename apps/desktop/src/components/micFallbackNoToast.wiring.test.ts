import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Owner, 2026-11-11: the "Microphone disconnected" pop-up should never appear. A picked mic that is not
// connected silently falls back to the system default (utils/micDeviceSync.ts); nothing is shown.
describe('mic fallback to the system default is silent', () => {
    const sc = readFileSync(join(__dirname, 'SidebarConference.tsx'), 'utf8');
    it('the fallback callback pushes no toast', () => {
        const at = sc.indexOf('onFellBackToDefault:');
        expect(at).toBeGreaterThan(0);
        const body = sc.slice(at, sc.indexOf('},', at));
        expect(body).not.toMatch(/toast/i);
    });
    it('the old pop-up text is gone from the call UI', () => {
        expect(sc).not.toContain('Microphone disconnected');
        expect(sc).not.toContain('is no longer available — using your system default');
    });
});
