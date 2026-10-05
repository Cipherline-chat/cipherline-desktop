import { describe, it, expect, vi } from 'vitest';
import { withPersonalChannelSaves, attachmentIdsOf } from './personalChannelSaves';
import type { RetentionHook } from '../hooks/useRetentionPolicy';

function fakeRetention(over: Partial<RetentionHook['policy']> = {}) {
    const policy = {
        messageRetention: '30d', attachmentRetention: '30d',
        savedMessageIds: [] as string[], unsavedMessageIds: [] as string[],
        savedAttachmentIds: [] as string[], unsavedAttachmentIds: [] as string[],
        unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
        ...over,
    } as unknown as RetentionHook['policy'];
    const r = {
        policy,
        saveMessage: vi.fn(), unsaveMessage: vi.fn(),
        saveAttachment: vi.fn(), unsaveAttachment: vi.fn(),
        isMessageSaved: vi.fn((id: string) => policy.savedMessageIds.includes(id)),
        isAttachmentSaved: vi.fn((id: string) => policy.savedAttachmentIds.includes(id)),
        getMessageExpiryAt: vi.fn(() => 1000),
        getAttachmentExpiryAt: vi.fn(() => 2000),
    };
    return r as unknown as RetentionHook & typeof r;
}

const msgs = [
    { id: 'm1', content: { type: 'text' } },
    { id: 'm2', content: { type: 'attachment', attachment_id: 'att2' } },
];

describe('withPersonalChannelSaves', () => {
    it('Save still makes the retention save, AND records a personal save', () => {
        const r = fakeRetention();
        const onToggle = vi.fn();
        const w = withPersonalChannelSaves(r, { savedMessageIds: [], savedAttachmentIds: [], messageIdForAttachment: () => undefined, onToggle });
        w.saveMessage('m1');
        w.unsaveMessage('m1');
        expect(r.saveMessage).toHaveBeenCalledWith('m1');
        expect(r.unsaveMessage).toHaveBeenCalledWith('m1');
        expect(onToggle.mock.calls).toEqual([['m1', 'add'], ['m1', 'remove']]);
    });

    it('an attachment save is recorded against its MESSAGE id (what mobile keys by)', () => {
        const r = fakeRetention();
        const onToggle = vi.fn();
        const w = withPersonalChannelSaves(r, {
            savedMessageIds: [], savedAttachmentIds: [],
            messageIdForAttachment: (a) => msgs.find(m => m.content.attachment_id === a)?.id, onToggle,
        });
        w.saveAttachment('att2');
        w.unsaveAttachment('att-unknown');
        expect(r.saveAttachment).toHaveBeenCalledWith('att2');
        expect(onToggle.mock.calls).toEqual([['m2', 'add']]);
    });

    it('a message saved on another device reads as saved here, never expires, and is not copied into retention', () => {
        const r = fakeRetention({ unsavedMessageIds: ['m1'] });
        const w = withPersonalChannelSaves(r, {
            savedMessageIds: ['m1', 'm2'], savedAttachmentIds: attachmentIdsOf(msgs, ['m1', 'm2']),
            messageIdForAttachment: () => undefined, onToggle: vi.fn(),
        });
        expect(w.isMessageSaved('m1')).toBe(true);
        expect(w.isAttachmentSaved('att2')).toBe(true);
        expect(w.getMessageExpiryAt('m1', 0)).toBeNull();
        expect(w.getAttachmentExpiryAt('att2', 0)).toBeNull();
        expect(w.getMessageExpiryAt('other', 0)).toBe(1000);
        // ChatPane reads the policy arrays directly — the overlay must show there too.
        expect(w.policy.savedMessageIds).toEqual(['m1', 'm2']);
        expect(w.policy.unsavedMessageIds).toEqual([]);
        expect(w.policy.savedAttachmentIds).toEqual(['att2']);
        // ...without touching the real retention state.
        expect(r.policy.savedMessageIds).toEqual([]);
        expect(r.saveMessage).not.toHaveBeenCalled();
    });
});

describe('attachmentIdsOf', () => {
    it('returns attachment ids of the saved attachment messages only', () => {
        expect(attachmentIdsOf(msgs, ['m1', 'm2'])).toEqual(['att2']);
        expect(attachmentIdsOf(msgs, [])).toEqual([]);
    });
});
