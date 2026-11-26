import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteServerCaps, resetServerCaps, serverAcceptsReadIdleMs } from './serverCaps';

beforeEach(() => resetServerCaps());

describe('server capability gate for idle_ms on message:read', () => {
    it('is off until the server announces read_idle_ms; only a literal true counts; reset on reconnect', () => {
        expect(serverAcceptsReadIdleMs()).toBe(false);
        noteServerCaps(undefined); noteServerCaps({ mobile_attentive: false }); noteServerCaps({ read_idle_ms: 'yes' });
        expect(serverAcceptsReadIdleMs()).toBe(false);
        noteServerCaps({ read_idle_ms: true });
        expect(serverAcceptsReadIdleMs()).toBe(true);
        resetServerCaps();
        expect(serverAcceptsReadIdleMs()).toBe(false);
    });
    it('wiring: WS idle_ms is gated, REST idle goes in a header and never in the body', () => {
        const strip = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        const rt = strip('hooks/useRealtime.ts');
        expect(rt).toContain('resetServerCaps();');
        expect(rt).toContain("if (msg.event === 'presence:ack') noteServerCaps(msg.data);");
        const dash = strip('components/Dashboard.tsx');
        expect(dash).toContain("headers['X-Idle-Ms'] = String(idle_ms)");
        expect(dash).toContain('axios.post(apiUrl`/channels/${channelId}/read`, {}, { headers })');
    });
});
