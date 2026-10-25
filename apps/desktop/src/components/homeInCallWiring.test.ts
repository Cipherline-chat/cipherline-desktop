import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');

// Keys sat in his call pose (and the Keys game never opened) for everyone:
// HomePanel derived "in a call" from `!!localCallSession`, an object that
// always exists. It must come from the real connection state instead.
describe('Home "in a call" wiring', () => {
    it('HomePanel never derives inCall from the always-present localCallSession object', () => {
        const src = read('HomePanel.tsx');
        expect(src).not.toMatch(/const inCall = !!localCallSession/);
        expect(src).toMatch(/const inCall = !!inAnyCall/);
    });
    it('Dashboard passes every kind of call (DM/group, voice channel, huddle)', () => {
        const src = read('Dashboard.tsx');
        expect(src).toMatch(/inAnyCall=\{!!activeCall \|\| !!activeVoiceChannelId \|\| !!activeHuddleCallId\}/);
    });
});
