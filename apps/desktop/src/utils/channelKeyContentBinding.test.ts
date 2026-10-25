import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChannelKeyContent, channelKeyContentMatchesEnvelope } from './channelKeyDistribution';

const env = { channel_id: 'chan-A', epoch: 3 };

describe('channelKeyContentMatchesEnvelope', () => {
    it('accepts what buildChannelKeyContent produces for the same channel/epoch (positive control)', () => {
        const c = buildChannelKeyContent({ channelId: 'chan-A', epoch: 3, keyB64: 'k', deviceId: 'd', rotationReason: 'initial' });
        expect(channelKeyContentMatchesEnvelope(c, env)).toBe(true);
    });
    it('rejects a key wrapped for another channel', () => {
        const c = buildChannelKeyContent({ channelId: 'chan-B', epoch: 3, keyB64: 'k', deviceId: 'd', rotationReason: 'initial' });
        expect(channelKeyContentMatchesEnvelope(c, env)).toBe(false);
    });
    it('rejects a key wrapped for another epoch', () => {
        const c = buildChannelKeyContent({ channelId: 'chan-A', epoch: 2, keyB64: 'k', deviceId: 'd', rotationReason: 'initial' });
        expect(channelKeyContentMatchesEnvelope(c, env)).toBe(false);
    });
    it('tolerates absent fields, rejects present-but-different values', () => {
        expect(channelKeyContentMatchesEnvelope({}, env)).toBe(true);
        expect(channelKeyContentMatchesEnvelope({ channel_id: 'chan-A', epoch: '3' }, env)).toBe(true);
        expect(channelKeyContentMatchesEnvelope({ channel_id: null }, env)).toBe(false);
        expect(channelKeyContentMatchesEnvelope({ channel_id: 'chan-A', epoch: 'x' }, env)).toBe(false);
    });
});

describe('wiring', () => {
    it('pullChannelKeysOnce checks the binding before installing, via the bounded-failure path', () => {
        const src = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        const start = src.indexOf('const pullChannelKeysOnce = useCallback(');
        const body = src.slice(start, src.indexOf('const [keyPullFlight]', start));
        const check = body.indexOf('channelKeyContentMatchesEnvelope(content, env)');
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(body.indexOf('setChannelKey('));
        expect(body.slice(check, check + 300)).toMatch(/throw new Error\(/);
    });
});
