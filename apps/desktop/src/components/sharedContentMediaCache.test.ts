import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared-content view (a chat's media / files list) used to decrypt every
 * item into its own object URL on each open and revoke it on close, so
 * opening it again - or opening media already showing in the chat - decrypted
 * everything again. It now shares the chat pane's session cache.
 */
const src = readFileSync(join(__dirname, 'SharedContentModal.tsx'), 'utf8');

describe('SharedContentModal uses the decrypted media cache', () => {
    it('checks the cache first and stores what it decrypts there', () => {
        expect(src).toMatch(/const cached = acquireDecryptedMedia\(item\.attachmentId\);\s*if \(cached\) return cached;/);
        expect(src).toMatch(/return putDecryptedMediaBlob\(item\.attachmentId, blob\);/);
    });

    it('releases (never revokes) the URLs it shows or saves', () => {
        expect(src).not.toMatch(/createObjectURL|revokeObjectURL/);
        expect((src.match(/releaseDecryptedMedia\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });
});
