import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source scan: the key_request_unanswered inputs in Dashboard.tsx. The pure
 * decisions (keyAskShape / keyAskWasFiled / the tracker) are tested in
 * detectors.test.ts; this pins that the three key-ask paths actually feed them,
 * so a refactor of finishKeyAsk cannot silently go back to counting asks the
 * API dropped or answers that arrived as copies.
 */
const dash = readFileSync(join(__dirname, '../../components/Dashboard.tsx'), 'utf8');

describe('Dashboard feeds the key-wait tracker honestly', () => {
    it('both POST paths (single + batch) pass the API answer through keyAskWasFiled', () => {
        expect(dash).toContain('filed: keyAskWasFiled(res.data)');
        expect(dash).toContain('filed: keyAskWasFiled(r)');
    });
    it('a wait is only started for an ask the API filed, tagged with its shape and size', () => {
        const m = /if \(answer\.filed !== false\) \{\s*noteBetaKeyAsked\(channelId, \{([^}]*)\}\);/.exec(dash);
        expect(m, 'noteBetaKeyAsked must sit inside the `filed` guard').not.toBeNull();
        expect(m![1]).toContain('shape: ask.shape');
        expect(m![1]).toContain('epochsAsked: ask.askEpochs?.length');
    });
    it('prepareKeyAsk computes the shape from what the device holds', () => {
        expect(dash).toContain('shape: keyAskShape({ keyless, askEpochs, heldEpochs })');
    });
    it('a duplicate envelope, a bootstrap mint and a won fallback rotation end the wait', () => {
        const calls = dash.match(/noteBetaKeyReceived\(/g) ?? [];
        expect(calls.length).toBe(3);
        expect(dash).toMatch(/\} else \{[^}]*noteBetaKeyReceived\(env\.channel_id\);/);
    });
});
