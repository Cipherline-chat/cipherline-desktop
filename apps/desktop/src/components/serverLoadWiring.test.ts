/**
 * Source-level wiring guards for the server-load fixes (Dashboard.tsx is too large to mount in a unit
 * test; the repo's other *Wiring.test.ts files do the same). Each assertion pins one request-count
 * property so a refactor cannot quietly bring the burst / duplicate back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dash = readFileSync(resolve(__dirname, 'Dashboard.tsx'), 'utf8');
const servers = readFileSync(resolve(__dirname, '../hooks/useServers.ts'), 'utf8');
const http = readFileSync(resolve(__dirname, '../utils/httpBootstrap.ts'), 'utf8');

describe('server-load wiring', () => {
    it('boot roster prefetch and unread reconcile go through paced queues, not an N-wide forEach', () => {
        expect(dash).toMatch(/bootRosterQueueRef\.current = createTaskQueue\(\{ concurrency: BOOT_ROSTER_CONCURRENCY/);
        expect(dash).toMatch(/bootUnreadQueueRef\.current = createTaskQueue\(\{ concurrency: BOOT_UNREAD_CONCURRENCY/);
        // The old shapes, which started every server at once.
        expect(dash).not.toMatch(/servers\.forEach\(async \(srv\) => \{\s*\/\/ Skip if already fetched/);
        expect(dash).not.toMatch(/void reconcileServerUnreadRef\.current\(fresh\);/);
    });

    it('the channel list GET is shared between loadChannels and the key sweep, and started before the pull', () => {
        expect(servers).toMatch(/shareInflight\(`ch:\$\{token\}:\$\{serverId\}`/);
        expect(dash).toMatch(/const listP = shareInflight\(`ch:\$\{token\}:\$\{serverId\}`/);
        expect(dash.indexOf('const listP = shareInflight')).toBeLessThan(dash.indexOf('await pullChannelKeys(serverId);\n            const res = await listP;'));
    });

    it('a first channel visit does not repeat the saves GET that refreshChannelHistory already made', () => {
        expect(dash).toMatch(/!isFirstMessagesFetch \|\| channelServerSavesRef\.current\[channel\.channel_id\] === undefined/);
    });

    it('every API request is timed, with the stopwatch registered before the attestation interceptor', () => {
        expect(http.indexOf('initNetTiming(API_BASE)')).toBeGreaterThan(-1);
        expect(http.indexOf('netTimer.begin')).toBeLessThan(http.indexOf('attestSign'));
        expect(http).toMatch(/settleTimer\(response\.config, response\.status\)/);
        expect(http).toMatch(/settleTimer\(error\?\.config, status \?\? null\)/);
    });
});
