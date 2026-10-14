import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level guards for Settings -> Storage -> Server storage. Dashboard has
 * no render harness (same approach as chatPerfWiring.test.ts); the pure logic
 * is in utils/serverStorage.test.ts and the UI in ServerStorageSection.test.ts.
 * What can only be checked here is the glue: that the purge handler is wired,
 * stays local, and keeps its ordering invariants.
 */
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const dash = read('Dashboard.tsx');

function handlerBody(): string {
    const start = dash.indexOf('const handlePurgeServerChannels = useCallback(');
    expect(start, 'handlePurgeServerChannels exists').toBeGreaterThan(-1);
    const end = dash.indexOf('}, [userId, ensureChannelSaves, markAttachmentsRemovedSafe]);', start);
    expect(end, 'handler dependency list found').toBeGreaterThan(start);
    return dash.slice(start, end);
}

describe('server purge wiring', () => {
    it('is handed to Settings -> Storage', () => {
        expect(dash).toMatch(/serverStorage=\{serverStorageData\}/);
        expect(dash).toMatch(/onPurge: handlePurgeServerChannels/);
        expect(read('settings/SettingsScreen.tsx')).toMatch(/serverStorage=\{serverStorage\}/);
        expect(read('StorageSettings.tsx')).toMatch(/<ServerStorageSection data=\{serverStorage\} \/>/);
    });

    it('is LOCAL ONLY: no request of any kind in the handler itself', () => {
        const body = handlerBody();
        // The sole network call is ensureChannelSaves' read-only GET of the saved set.
        expect(body).not.toMatch(/axios|fetch\(|\.delete\(|\.post\(|\.put\(|\.patch\(|API_BASE/);
        expect(body).toMatch(/ensureChannelSaves/);
    });

    it('confirms the saved set first, skips a channel it cannot confirm, and keeps pins', () => {
        const body = handlerBody();
        expect(body.indexOf('ensureChannelSaves')).toBeLessThan(body.indexOf('planServerPurge('));
        expect(body).toMatch(/skipped\.add\(cid\)/);
        expect(body).toMatch(/pinnedIdsForChannel\(localChannelPinsRef\.current\[cid\], saves\[cid\]\)/);
        expect(body).toMatch(/skippedChannels: skipped\.size/);
    });

    it('does not try to fetch the saved set of a server we have left (it would 403 forever)', () => {
        const body = handlerBody();
        expect(body).toMatch(/opts\.member \? await ensureChannelSaves\(cid\)/);
        expect(body).toMatch(/channelServerSavesRef\.current\[cid\]/);
        expect(read('ServerStorageSection.tsx')).toMatch(/\{ member: row\.kind === 'joined' \}/);
    });

    it('tombstones BEFORE writing state, and persists the channel store', () => {
        const body = handlerBody();
        const tomb = body.indexOf('markMessagesPurged(');
        expect(tomb).toBeGreaterThan(-1);
        expect(tomb).toBeLessThan(body.indexOf('setChannelMessages(next)'));
        expect(body).toMatch(/messageStore\.saveAll\('channel', userId, next\)/);
    });

    it('removes only the LOCAL cached blobs of dropped attachments', () => {
        const body = handlerBody();
        expect(body).toMatch(/deleteEncryptedAttachment/);
        expect(body).toMatch(/markAttachmentsRemovedSafe\(plan\.attachmentIds\)/);
    });

    it('reads the left-server channel cache but never writes it', () => {
        const start = dash.indexOf('const leftServerChannels = useMemo');
        const memo = dash.slice(start, dash.indexOf('}, [settingsOpen, userId, servers]);', start));
        expect(memo).toMatch(/keysWithPrefix\(prefix\)/);
        expect(memo).not.toMatch(/setItem|removeItem/);
    });
});
