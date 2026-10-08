import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard for the new-member / new-device channel-key path.
 *
 * Owner report (2026-10-07): a member joining a server sat on "Waiting for
 * channel keys" while key holders were online. Reproducing it with real
 * clients against a real API on this code did NOT fail — keys arrived in
 * 6–17 s for a new member (active or idle holder), a new device of an
 * existing member, and the joiner's other online device. What made the
 * owner's case undiagnosable is that every hop that CAN drop the key did so
 * silently: the holder skipped a requester it could not find, skipped a
 * new member with no listed device, swallowed handshake POST failures, and
 * the keyless side swallowed key-request and pull failures — none of it
 * reached Settings → Advanced → Delivery diagnostics, whose
 * `channel_key_distribute` kind was declared and never recorded.
 *
 * These assertions pin each of those hops to a recorded diagnostic, and pin
 * that one failing request no longer aborts the rest of a serve pass.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function body(startMarker: string, endMarker: string): string {
    const a = src.indexOf(startMarker);
    expect(a, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
    const b = src.indexOf(endMarker, a + startMarker.length);
    expect(b, `end marker not found after ${startMarker}: ${endMarker}`).toBeGreaterThan(a);
    return src.slice(a, b);
}

const serve = () => body('const serveKeyRequests = useCallback', 'const channelKeyOpsRef = useRef(');
const distribute = () => body('const distributeChannelKeys = useCallback', 'const mayMintChannelKey = useCallback');
const fileReq = () => body('const fileKeyRequest = useCallback', 'const maybeFileKeyRequest = useCallback');
const pull = () => body('const pullChannelKeys = useCallback', '// ── Channel key backfill protocol');
const memberJoined = () => body('if (!serverMemberJoinedEvent || !token || !userId || !deviceId) return;', '}, [serverMemberJoinedEvent]);');

describe('holder side: serving a key request', () => {
    it('records a requester device that is not listed with a key bundle instead of skipping it silently', () => {
        const fn = serve();
        const skip = fn.slice(fn.indexOf('if (!dev)'));
        expect(skip.slice(0, skip.indexOf('continue;'))).toContain("recordDelivery('channel_key_distribute'");
        expect(fn).toContain('[E2EE:NO_RECIPIENT_BUNDLE]');
    });

    it('isolates each request: a throw is caught and recorded INSIDE the loop, so later requests are still served', () => {
        const fn = serve();
        const loop = fn.slice(fn.indexOf('for (const req of pending)'));
        const perRequest = loop.slice(0, loop.indexOf('} finally {'));
        // The per-request try must have its own catch before its finally.
        expect(perRequest).toMatch(/\} catch \(e\) \{[\s\S]*recordDelivery\('channel_key_distribute', e/);
    });

    it('records a failure to list pending requests at all', () => {
        const fn = serve();
        const outer = fn.slice(fn.lastIndexOf("console.warn('[Channels] serveKeyRequests failed:'"));
        expect(outer).toContain("recordDelivery('channel_key_distribute', e");
    });
});

describe('holder side: wrapping and posting envelopes', () => {
    it('records a per-device wrap failure', () => {
        const fn = distribute();
        const wrap = fn.slice(fn.indexOf("Failed to wrap channel key for device"));
        expect(wrap.slice(0, 400)).toContain("recordDelivery('channel_key_distribute', e");
    });

    it('records a failed key-handshake POST (403/429/5xx) instead of only warning', () => {
        const fn = distribute();
        const post = fn.slice(fn.indexOf('/key-handshake`'));
        expect(post.slice(0, 800)).toContain("recordDelivery('channel_key_distribute', e");
    });
});

describe('holder side: server:member_joined distribution', () => {
    it('records a new member with no listed device instead of returning silently', () => {
        const fn = memberJoined();
        const noDev = fn.slice(fn.indexOf('if (!newMemberDevices.length)'));
        expect(noDev.slice(0, noDev.indexOf('return;'))).toContain('[E2EE:NO_RECIPIENT_BUNDLE]');
    });

    it('records a failed distribution', () => {
        const fn = memberJoined();
        expect(fn).toMatch(/Failed to distribute channel keys to new member[\s\S]*recordDelivery\('channel_key_distribute', e/);
    });
});

describe('keyless side: requesting and pulling', () => {
    it('records a failed key-request POST', () => {
        expect(fileReq()).toMatch(/key-request failed for[\s\S]*recordDelivery\('channel_key_request', e/);
    });

    it('records a failed pending-envelope pull', () => {
        expect(pull()).toMatch(/pullChannelKeys failed:[\s\S]*recordDelivery\('channel_key_pull', e/);
    });

    it('gives a distributor rejection and an unresolved epoch conflict their own codes', () => {
        const fn = pull();
        expect(fn).toContain('[E2EE:KEY_DISTRIBUTOR_REJECTED]');
        expect(fn).toContain('[E2EE:EPOCH_CONFLICT]');
    });
});
