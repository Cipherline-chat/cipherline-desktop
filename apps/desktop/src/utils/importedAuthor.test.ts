import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportedFrom } from '@cipherline/shared';
import { authorGroupKey, displayTimeMs, importedAuthorView, importedHue, importedInitials, importedNameOf } from './importedAuthor';
import { senderDisplayName } from './senderDisplayName';
import { isEditableOwnMessage } from './editLastMessage';
import { applyChannelEditDelete } from './channelHistoryMerge';

const IID = '33333333-3333-4333-8333-333333333333';
const REF = '44444444-4444-4444-8444-444444444444';
const IMPORTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const block: ImportedFrom = { v: 1, source: 'discord', author_ref: REF, kind: 'user', name: 'Sam', username: 'samwise.k', original_ts: '2026-10-01T09:30:00.000Z' };
const row = (o: Record<string, unknown> = {}) => ({
    id: 'r1', sender_user_id: IMPORTER, sender_device_id: 'dev-importer', timestamp: '2026-11-21T12:00:00.000Z',
    content: { type: 'text', text: 'hi', imported_from: block }, import_mark: { import_id: IID, import_author_id: REF, claimed_user_id: null }, ...o,
});
const nameCtx = {
    inServerChannel: true, nicknames: {}, userIdToUsername: { [IMPORTER]: 'dawson' }, deviceToUsername: {},
    myUserId: IMPORTER, myUsername: 'dawson', myDeviceIds: new Set(['dev-importer']),
};

describe('importedAuthorView: who a row is SHOWN as', () => {
    it('a marked row: the imported author, original time, never the importer', () => {
        const v = importedAuthorView(row());
        expect(v).toMatchObject({ kind: 'unclaimed', name: 'Sam', suffix: null, originalTs: block.original_ts });
        expect(senderDisplayName(row(), nameCtx)).toBe('Sam');
    });
    it('POSITIVE CONTROL: the same content WITHOUT the server mark renders as its real sender', () => {
        const forged = row({ import_mark: undefined });
        expect(importedAuthorView(forged)).toBeNull();
        expect(senderDisplayName(forged, nameCtx)).toBe('dawson');
        expect(importedNameOf(forged)).toBeNull();
        expect(displayTimeMs(forged)).toBe(Date.parse('2026-11-21T12:00:00.000Z'));
    });
    it('a mark for another author: real sender', () => {
        const r = row({ import_mark: { import_id: IID, import_author_id: '55555555-5555-4555-8555-555555555555' } });
        expect(importedAuthorView(r)).toBeNull();
        expect(senderDisplayName(r, nameCtx)).toBe('dawson');
    });
    it('collision (D18): "Sam · @samwise.k" when a current member is called Sam', () => {
        expect(importedAuthorView(row(), ['Mira', 'sam'])).toMatchObject({ name: 'Sam', suffix: '@samwise.k' });
    });
    it('a claim (phase 3 seam) shows the claimant, never the imported name', () => {
        const v = importedAuthorView(row({ import_mark: { import_id: IID, import_author_id: REF, claimed_user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }));
        expect(v).toMatchObject({ kind: 'claimed', userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    });
    it('display time = the original time (D17); grouping key = the imported author, never the importer device', () => {
        expect(displayTimeMs(row())).toBe(Date.parse(block.original_ts));
        expect(authorGroupKey(row())).toBe(`import:${REF}`);
        expect(authorGroupKey(row({ import_mark: undefined }))).toBe('device:dev-importer');
    });
    it('fallback avatar: an initial and a hue from the opaque ref (not the name)', () => {
        expect(importedInitials('  sam')).toBe('S');
        expect(importedInitials('🙂')).toBe('?');
        expect(importedHue(REF)).toBe(importedHue(REF));
    });
});

describe('imported rows are never edited (plan B4.1)', () => {
    it('the Up-arrow / menu edit never targets an imported row, even the importer\'s', () => {
        expect(isEditableOwnMessage(row(), { myUserId: IMPORTER, myDeviceIds: new Set(['dev-importer']) })).toBe(false);
        expect(isEditableOwnMessage(row({ import_mark: undefined }), { myUserId: IMPORTER, myDeviceIds: new Set(['dev-importer']) })).toBe(true);
    });
    it('an edit marker from the importer never applies to an imported row; a delete still does', () => {
        const thread = [row()];
        const edit = { id: 'e1', sender_user_id: IMPORTER, sender_device_id: 'dev-importer', timestamp: 'x', content: { type: 'edit', target_id: 'r1', text: 'rewritten' } };
        expect(applyChannelEditDelete(thread as never, edit as never)).toBe(thread);
        const del = { ...edit, content: { type: 'delete', target_id: 'r1' } };
        expect(applyChannelEditDelete(thread as never, del as never)).toHaveLength(0);
        // Control: the same edit on a normal row applies.
        const normal = [row({ import_mark: undefined })];
        expect((applyChannelEditDelete(normal as never, edit as never)[0] as { content: { text: string } }).content.text).toBe('rewritten');
    });
});

describe('wiring (source level: ChatPane and Dashboard have no render harness)', () => {
    const chat = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
    const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    it('the row derives the imported author ONLY through importedAuthorView (mark-verified)', () => {
        expect(chat).toContain('const imported = importedAuthorView(msg, importCollisionNames);');
        expect(chat.match(/imported_from/g) ?? []).toHaveLength(0);
    });
    it('an unclaimed imported author is never a profile link and never pings', () => {
        expect(chat).toContain('const nameClickable = !openUnclaimed && ');
        expect(chat).toContain('const mentionsMe = !imported && ');
    });
    it('history rows take the mark from the ROW (importMarkOf(m)); live rows always drop imported_from', () => {
        expect(dash).toContain('const importMark = importMarkOf(m);');
        expect(dash).toContain('gateImportedFrom(gateCardStyleByFlag(parsedContent, { isServerChannel: true, styledFlag: m.styled }), importMark)');
        expect(dash).toContain('gateImportedFrom(gateCardStyleByFlag(parsedContent, { isServerChannel: true, styledFlag: evt.styled }), null)');
    });
});
