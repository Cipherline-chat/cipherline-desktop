import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Home row for the call you're in offers no button; others offer Join (owner 2026-10-31).
 *  Since 2026-11-16 the rows live in HomeCallsTile (one tile, a line per call);
 *  HomeCallsTile.render.test.ts proves the behaviour, this pins the source. */
const src = readFileSync(join(__dirname, 'HomeCallsTile.tsx'), 'utf8');

describe('Home "Happening now" card', () => {
    it('Join only on a call you are not in (and may CONNECT to)', () => {
        expect(src).toMatch(/mine[\s\S]{0,200}?\?\s*<span className="hd-call-here hd-call-act"><i aria-hidden="true" \/>In call<\/span>\s*:\s*canJoinVoice\(call\.channel\) && \(/);
        expect(src).toContain('onClick={call.onJoin}');
    });

    it('no Return button on your own call', () => {
        expect(src).not.toMatch(/>\s*Return\s*</);
        expect(src).not.toContain('Return to ${call.channel.name}');
    });

    it('still says you are in it', () => {
        expect(src).toContain('<span className="hd-call-here hd-call-act"><i aria-hidden="true" />In call</span>');
    });
});
