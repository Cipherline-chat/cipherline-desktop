import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Home card for the call you're in offers no button; others offer Join (owner 2026-10-31). */
const src = readFileSync(join(__dirname, 'HomePanel.tsx'), 'utf8');

describe('Home "Happening now" card', () => {
    it('Join only on a call you are not in', () => {
        expect(src).toContain('{!mine && <button className="hd-btn" onClick={call.onJoin}>Join</button>}');
    });

    it('no Return button on your own call', () => {
        expect(src).not.toMatch(/>\s*Return\s*</);
        expect(src).not.toContain('Return to ${call.channel.name}');
    });

    it('still says you are in it', () => {
        expect(src).toContain('{mine && <span className="hd-live">In call</span>}');
    });
});
