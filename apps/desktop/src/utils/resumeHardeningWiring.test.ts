import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guards for the resume-from-sleep hardening. Dashboard and the
 * contexts are far too large to mount in a unit test; the behaviour lives in
 * the tested utils (networkReady, resumeSequencing, prekeyTopup, sweepCommit)
 * and these pin that the call sites actually USE them - the regression that
 * bites is "someone re-introduced a bare fire-and-forget at one call site".
 */
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const dashboard = read('components', 'Dashboard.tsx');
const subscription = read('contexts', 'SubscriptionContext.tsx');
const keyRotation = read('hooks', 'useKeyRotation.ts');

describe('Dashboard resume wiring', () => {
    it('the OS wake resync goes through the connectivity gate, not straight into rehydrateAll', () => {
        const m = /onAppResumed\?\.\(\(\) => \{([^}]*)\}\)/.exec(dashboard);
        expect(m, 'onAppResumed handler not found').not.toBeNull();
        expect(m![1]).toContain('wakeResync(');
        expect(m![1]).not.toContain('rehydrateAll');
        expect(dashboard).toMatch(/createWakeResync\(\{[\s\S]{0,200}ready: \(\) => ensureNetworkReady\(\)/);
    });

    it('the rehydrate loads are paced (runPaced), not started together', () => {
        const body = dashboard.slice(dashboard.indexOf("const rehydrateOnce = useCallback"), dashboard.indexOf('const rehydrateOnceRef'));
        expect(body).toContain('runPaced(');
        expect(body).not.toMatch(/Promise\.allSettled\(\[\s*fetchConversationsRef/);
        // all four loads are still there
        for (const call of ['fetchConversationsRef.current', 'fetchFriendsRef.current', 'refreshProfile()', 'loadServers()']) {
            expect(body, call).toContain(call);
        }
    });

    it('the DM pull entry point is the offline gate, and `online` catches up the skipped pull', () => {
        expect(dashboard).toContain('createPullGate({ isOnline: isLikelyOnline');
        expect(dashboard).toMatch(/const pullMessages = React\.useCallback\(\(\) => pullGateRef\.current!\.request\(\)/);
        expect(dashboard).toMatch(/addEventListener\('online', onOnline\)/);
        expect(dashboard).toContain('pullGateRef.current?.onOnline()');
    });

    it('msg_fetch_gap carries the failure cause and is not reported for a network failure while offline', () => {
        expect(dashboard).toMatch(/reportBeta\('msg_fetch_gap', \{ stage: 'pull', online, cause/);
        expect(dashboard).toMatch(/if \(online \|\| cause !== 'network'\)/);
    });

    it('the retention sweep commit is time-sliced and attachment deletes are chunked', () => {
        const sweep = dashboard.slice(dashboard.indexOf("trackActivity('retention:sweep'"), dashboard.indexOf('sweepRunRef.current = run;'));
        expect(sweep.length).toBeGreaterThan(1000);
        expect(sweep).not.toMatch(/messageStore\.saveAll\(/);
        expect(sweep).toMatch(/saveThreadsSliced\(\s*'dm', userId,/);
        expect(sweep).toMatch(/saveThreadsSliced\(\s*'channel', userId,/);
        expect(sweep).toContain('removeInChunks(allAttachmentsToDelete, deleteEncryptedAttachment)');
        expect(sweep).not.toMatch(/Promise\.allSettled\(allAttachmentsToDelete\.map/);
    });
});

describe('SubscriptionContext: no bare fire-and-forget of the rethrowing refresh()', () => {
    it('every unawaited call goes through refreshQuietly', () => {
        // refresh() rethrows by design (awaiting callers react to it). A bare
        // `refresh();` / `void refresh();` statement is an unhandled rejection
        // on any network failure - the wake-time AxiosError from beta diagnostics.
        const stray = subscription.split('\n')
            .map((l, i) => ({ l: l.trim(), n: i + 1 }))
            .filter(({ l }) => /^(void\s+)?refresh\(\);?$/.test(l) || /\{\s*(void\s+)?refresh\(\);?\s*\}/.test(l));
        expect(stray).toEqual([]);
        expect(subscription.match(/refreshQuietly\(\)/g)!.length).toBeGreaterThanOrEqual(4);
    });

    it('negative control: the scan really does catch a bare call', () => {
        const bad = "useEffect(() => { refresh(); }, [refresh]);";
        expect(/\{\s*(void\s+)?refresh\(\);?\s*\}/.test(bad)).toBe(true);
    });
});

describe('useKeyRotation: top-up runs through the retrying, never-throwing runner', () => {
    it('uses runTopupWithRetry + ensureNetworkReady and no longer swallows into a single try/catch', () => {
        expect(keyRotation).toContain('runTopupWithRetry(');
        expect(keyRotation).toContain('waitForNetwork: () => ensureNetworkReady()');
        expect(keyRotation).toContain("window.addEventListener('online', onOnline)");
        // the minted-but-unposted bundle is held across runs
        expect(keyRotation).toContain('held: held.current');
    });
    it('reports prekeys_low {topup_failed} only for a run that actually tried (isReportableTopupFailure)', () => {
        expect(keyRotation).toMatch(/if \(isReportableTopupFailure\(result\)\) reportBeta\('prekeys_low', \{\s*topup_failed: true/);
    });
});
