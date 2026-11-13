import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Dashboard needs a whole app to render, so this mount condition is pinned at the source level. */
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

describe('an incoming call on a screen with no right panel', () => {
    it('the panel mounts for the ringing call, whatever else is open', () => {
        const mount = dash.slice(dash.indexOf('{divider2El}') - 260, dash.indexOf('{divider2El}'));
        expect(mount).toContain('!!globalIncomingCall');
    });

    it('that panel is where the ringing screen lives', () => {
        const pane = dash.slice(dash.indexOf('const pane4El = ('));
        expect(pane.indexOf('{globalIncomingCall && (')).toBeGreaterThan(0);
        expect(pane.indexOf('{globalIncomingCall && (')).toBeLessThan(pane.indexOf('{divider2El}'));
    });
});
