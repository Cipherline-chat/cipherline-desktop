import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'CreateGroupModal.tsx'), 'utf8');

describe('a group created with an icon', () => {
    it('opens with that icon: the broadcast for it landed before the chat was open', () => {
        const opened = src.slice(src.indexOf('onGroupCreated({'));
        expect(opened.slice(0, opened.indexOf('});'))).toContain('avatar_url: groupAvatar');
    });
    it('only claims an icon that actually saved', () => {
        const patch = src.indexOf('avatar_attachment: attachmentId');
        const set = src.indexOf('groupAvatar = attachmentId');
        const failed = src.indexOf("title: 'Photo not set'");
        expect(patch).toBeGreaterThan(-1);
        expect(set).toBeGreaterThan(patch);
        expect(failed).toBeGreaterThan(set);
    });
});
