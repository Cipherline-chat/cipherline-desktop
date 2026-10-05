import { describe, it, expect } from 'vitest';
import { attachmentToDeleteWithMessage } from './attachmentOnDelete';

describe('attachmentToDeleteWithMessage', () => {
    it('returns the attachment id of an attachment message', () => {
        expect(attachmentToDeleteWithMessage({ id: 'm1', content: { type: 'attachment', attachment_id: 'a1' } })).toBe('a1');
    });

    it('returns null for text and other message types', () => {
        expect(attachmentToDeleteWithMessage({ content: { type: 'text', text: 'hi' } })).toBeNull();
        expect(attachmentToDeleteWithMessage({ content: { type: 'call_key' } })).toBeNull();
    });

    it('returns null for a missing message, missing content, or a bad id', () => {
        expect(attachmentToDeleteWithMessage(undefined)).toBeNull();
        expect(attachmentToDeleteWithMessage({})).toBeNull();
        expect(attachmentToDeleteWithMessage({ content: { type: 'attachment' } })).toBeNull();
        expect(attachmentToDeleteWithMessage({ content: { type: 'attachment', attachment_id: '' } })).toBeNull();
        expect(attachmentToDeleteWithMessage({ content: { type: 'attachment', attachment_id: 42 } })).toBeNull();
    });
});

/**
 * Source pin: automatic retention sweeps must never delete the server copy.
 * Before per-device storage they did, which let one device's short window
 * remove a file for every other device and recipient.
 */
describe('retention sweeps are local-only', () => {
    it('Dashboard issues no DELETE /attachments/:id at all', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(__dirname, '../components/Dashboard.tsx'), 'utf8');
        expect(src).not.toMatch(/axios\.delete\(`\$\{API_BASE\}\/attachments\//);
    });

    it('ChatPane deletes the server copy only from the explicit delete path', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(__dirname, '../components/ChatPane.tsx'), 'utf8');
        const hits = src.match(/axios\.delete\(`\$\{API_BASE\}\/attachments\//g) ?? [];
        expect(hits.length).toBe(1);
        const at = src.indexOf('const performDelete');
        expect(at).toBeGreaterThan(-1);
        expect(src.indexOf('axios.delete(`${API_BASE}/attachments/', at)).toBeLessThan(src.indexOf('const requestDelete', at));
    });
});
