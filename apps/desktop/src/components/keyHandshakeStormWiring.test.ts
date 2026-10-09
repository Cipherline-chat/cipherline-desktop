import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard for the 2026-10-09 key-handshake storm fix.
 *
 * The flow control itself (back-off, pacing, ledger, single-flight, budget)
 * is unit-tested in utils/keyDistributionThrottle.test.ts. What only a source
 * check can pin is that Dashboard actually ROUTES every key-handshake POST
 * through it — the storm came from a Dashboard loop that swallowed 429s in a
 * `.catch` and slept a fixed 100 ms, and from serve passes running
 * concurrently per server. Each assertion below fails against that code.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function body(startMarker: string, endMarker: string): string {
    const a = src.indexOf(startMarker);
    expect(a, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
    const b = src.indexOf(endMarker, a + startMarker.length);
    expect(b, `end marker not found after ${startMarker}: ${endMarker}`).toBeGreaterThan(a);
    return src.slice(a, b);
}

const distribute = () => body('const distributeChannelKeys = useCallback', 'const mayMintChannelKey = useCallback');
const serve = () => body('const serveKeyRequests = useCallback', 'const channelKeyOpsRef = useRef(');

describe('every key-handshake POST goes through the flow-controlled loop', () => {
    it('distributeChannelKeys delegates to runKeyDistribution with the session-wide back-off, pacer, ledger and mutex', () => {
        const fn = distribute();
        expect(fn).toContain('runKeyDistribution({');
        for (const dep of ['backoff: handshakeBackoff', 'pacer: handshakePacer', 'ledger: deliveryLedger', 'mutex: distributionMutex']) {
            expect(fn).toContain(dep);
        }
    });

    it('no longer swallows a failed POST and carries on (the storm loop)', () => {
        const fn = distribute();
        const post = fn.slice(fn.indexOf('/key-handshake`'));
        // The POST promise is returned to the loop, which classifies the error;
        // it must not be `.catch`-ed into a silent success.
        expect(post.slice(0, post.indexOf('onPostError'))).not.toContain('.catch(');
        expect(fn).not.toMatch(/setTimeout\(r, 100\)/);
    });

    it('there is exactly ONE place in Dashboard that POSTs key-handshake', () => {
        expect(src.match(/\/key-handshake`/g)).toHaveLength(1);
    });

    it('a one-shot distribution that was deferred is resumed (bounded), not dropped', () => {
        const fn = distribute();
        expect(fn).toContain("outcome.status === 'deferred'");
        expect(fn).toContain('MAX_DISTRIBUTION_RESUMES');
        expect(fn).toContain('keyResumeTimers.schedule(');
    });

    it('the shared instances are created once per component (useState initialisers), not per render', () => {
        for (const ctor of ['new HandshakeBackoff()', 'new Pacer()', 'new DeliveryLedger()', 'new KeyedMutex()', 'new SingleFlight()', 'new ResumeTimers()']) {
            expect(src).toContain(`useState(() => ${ctor})`);
        }
    });
});

describe('serveKeyRequests: single-flight, budgeted, deduped, and it stops on a deferral', () => {
    it('runs inside the per-server single-flight', () => {
        expect(serve()).toContain('return keyServeFlight.run(serverId, async () => {');
    });

    it('does nothing but schedule a resume while a back-off is active', () => {
        const fn = serve();
        const guard = fn.slice(fn.indexOf('if (handshakeBackoff.isBlocked())'));
        expect(guard.slice(0, guard.indexOf('return;'))).toContain('scheduleResume(handshakeBackoff.remainingMs())');
    });

    it('caps each pass and passes the request version so delivered epochs are not re-sent', () => {
        const fn = serve();
        expect(fn).toContain('const budget = { remaining: SERVE_PASS_SUBMISSION_CAP };');
        expect(fn).toContain('{ requestVersion: version, budget }');
        expect(fn).toContain('deliveryLedger.allDelivered(req.channel_id, epochs, req.requester_device_id, version)');
    });

    it('a deferred distribution ends the pass (no further POSTs from it) and schedules one resume', () => {
        const fn = serve();
        const branch = fn.slice(fn.indexOf("if (outcome.status === 'deferred') {"));
        expect(branch.slice(0, 300)).toContain('scheduleResume(outcome.retryInMs);');
        expect(branch.slice(0, 300)).toContain('stop = true;');
        expect(fn).toContain('if (stop) break;');
    });

    it('the key_requested push and the connect sweep both go through serveKeyRequests (so through the single-flight)', () => {
        expect(src).toContain('void serveKeyRequests(serverId);');
        expect(src).toContain('await serveKeyRequests(srv.server_id);');
    });
});
