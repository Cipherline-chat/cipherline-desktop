import { describe, it, expect } from 'vitest';
import {
    isOwnMessage,
    isEditableOwnMessage,
    findLastEditableOwnMessage,
    shouldOpenEditorOnArrowUp,
    type ArrowUpContext,
    type EditableMessageLike,
    type OwnershipContext,
} from './editLastMessage';

const ME = 'user-me';
const THEM = 'user-them';
const MY_DEVICE = 'dev-mine';
const ctx: OwnershipContext = { myUserId: ME, myDeviceIds: new Set([MY_DEVICE]) };

const text = (id: string, sender: string): EditableMessageLike =>
    ({ id, content: { type: 'text', text: 'hi' }, sender_user_id: sender, sender_device_id: 'dev-x' });

describe('isOwnMessage', () => {
    it('matches on user id when the envelope carries one', () => {
        expect(isOwnMessage(text('m1', ME), ctx)).toBe(true);
        expect(isOwnMessage(text('m1', THEM), ctx)).toBe(false);
    });

    it('falls back to device id when there is no sender user id', () => {
        expect(isOwnMessage({ id: 'm', content: { type: 'text' }, sender_device_id: MY_DEVICE }, ctx)).toBe(true);
        expect(isOwnMessage({ id: 'm', content: { type: 'text' }, sender_device_id: 'dev-other' }, ctx)).toBe(false);
    });

    it('is false for an anonymous envelope rather than defaulting to mine', () => {
        expect(isOwnMessage({ id: 'm', content: { type: 'text' } }, ctx)).toBe(false);
    });
});

describe('isEditableOwnMessage', () => {
    it('accepts my own plain text message', () => {
        expect(isEditableOwnMessage(text('m1', ME), ctx)).toBe(true);
    });

    it('rejects someone else\'s text message', () => {
        expect(isEditableOwnMessage(text('m1', THEM), ctx)).toBe(false);
    });

    it('rejects every non-text content type the edit path refuses', () => {
        for (const type of ['attachment', 'system', 'call', 'call_key', 'server_invite', 'safety_number', 'reaction', 'edit', 'delete', 'pin', 'gif']) {
            expect(
                isEditableOwnMessage({ id: 'm', content: { type }, sender_user_id: ME }, ctx),
                `content.type=${type} must not be editable`,
            ).toBe(false);
        }
    });

    it('rejects a message with no id (nothing to target an edit at)', () => {
        expect(isEditableOwnMessage({ content: { type: 'text' }, sender_user_id: ME }, ctx)).toBe(false);
    });

    it('rejects null/undefined and a missing content object', () => {
        expect(isEditableOwnMessage(null, ctx)).toBe(false);
        expect(isEditableOwnMessage(undefined, ctx)).toBe(false);
        expect(isEditableOwnMessage({ id: 'm', sender_user_id: ME }, ctx)).toBe(false);
    });
});

describe('findLastEditableOwnMessage', () => {
    it('returns the newest of my text messages', () => {
        const list = [text('a', ME), text('b', THEM), text('c', ME), text('d', THEM)];
        expect(findLastEditableOwnMessage(list, ctx)?.id).toBe('c');
    });

    it('skips past my own non-editable trailing messages', () => {
        const list = [
            text('a', ME),
            { id: 'b', content: { type: 'attachment' }, sender_user_id: ME },
            { id: 'c', content: { type: 'call' }, sender_user_id: ME },
        ];
        expect(findLastEditableOwnMessage(list, ctx)?.id).toBe('a');
    });

    it('returns null when the conversation has nothing of mine', () => {
        expect(findLastEditableOwnMessage([text('a', THEM), text('b', THEM)], ctx)).toBeNull();
    });

    it('returns null for an empty or absent list', () => {
        expect(findLastEditableOwnMessage([], ctx)).toBeNull();
        expect(findLastEditableOwnMessage(null, ctx)).toBeNull();
        expect(findLastEditableOwnMessage(undefined, ctx)).toBeNull();
    });

    it('works off device ownership in a channel where user ids are absent', () => {
        const list: EditableMessageLike[] = [
            { id: 'a', content: { type: 'text' }, sender_device_id: 'dev-other' },
            { id: 'b', content: { type: 'text' }, sender_device_id: MY_DEVICE },
            { id: 'c', content: { type: 'text' }, sender_device_id: 'dev-other' },
        ];
        expect(findLastEditableOwnMessage(list, ctx)?.id).toBe('b');
    });
});

// ── shouldOpenEditorOnArrowUp ───────────────────────────────────────────────

const base: ArrowUpContext = {
    composerText: '',
    selectionStart: 0,
    selectionEnd: 0,
    isEditing: false,
    isReplying: false,
    hasOpenSuggestions: false,
    stagedFileCount: 0,
    modifiers: { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false },
    hasEditableCandidate: true,
};
const at = (over: Partial<ArrowUpContext>): ArrowUpContext => ({ ...base, ...over });

describe('shouldOpenEditorOnArrowUp', () => {
    it('opens the editor on an empty composer with an editable message behind it', () => {
        expect(shouldOpenEditorOnArrowUp(base)).toBe(true);
    });

    it('does NOT fire with text in the composer — Up must move the caret', () => {
        expect(shouldOpenEditorOnArrowUp(at({ composerText: 'hello', selectionStart: 5, selectionEnd: 5 }))).toBe(false);
    });

    it('does NOT fire with the caret at the start of a non-empty single-line draft', () => {
        expect(shouldOpenEditorOnArrowUp(at({ composerText: 'hello' }))).toBe(false);
    });

    it('does NOT fire mid-draft', () => {
        expect(shouldOpenEditorOnArrowUp(at({ composerText: 'hello world', selectionStart: 5, selectionEnd: 5 }))).toBe(false);
    });

    it('does NOT fire anywhere inside a multi-line draft', () => {
        const draft = 'line one\nline two\nline three';
        for (const caret of [0, 4, 9, 14, 20, draft.length]) {
            expect(
                shouldOpenEditorOnArrowUp(at({ composerText: draft, selectionStart: caret, selectionEnd: caret })),
                `multi-line draft, caret ${caret}`,
            ).toBe(false);
        }
    });

    it('does NOT fire when text is selected', () => {
        expect(shouldOpenEditorOnArrowUp(at({ composerText: 'abc', selectionStart: 0, selectionEnd: 3 }))).toBe(false);
    });

    it('treats a whitespace-only draft as empty, but only with the caret parked at the start', () => {
        expect(shouldOpenEditorOnArrowUp(at({ composerText: '   ', selectionStart: 0, selectionEnd: 0 }))).toBe(true);
        expect(shouldOpenEditorOnArrowUp(at({ composerText: '   ', selectionStart: 3, selectionEnd: 3 }))).toBe(false);
    });

    it('does NOT fire when there is no editable message', () => {
        expect(shouldOpenEditorOnArrowUp(at({ hasEditableCandidate: false }))).toBe(false);
    });

    it('does NOT fire when an edit is already open', () => {
        expect(shouldOpenEditorOnArrowUp(at({ isEditing: true }))).toBe(false);
    });

    it('does NOT fire while composing a reply', () => {
        expect(shouldOpenEditorOnArrowUp(at({ isReplying: true }))).toBe(false);
    });

    it('does NOT fire while the mention/emoji suggestion menu owns Up', () => {
        expect(shouldOpenEditorOnArrowUp(at({ hasOpenSuggestions: true }))).toBe(false);
    });

    it('does NOT fire with files staged (the composer is a caption field)', () => {
        expect(shouldOpenEditorOnArrowUp(at({ stagedFileCount: 1 }))).toBe(false);
    });

    it('does NOT fire with any modifier held', () => {
        for (const key of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
            expect(
                shouldOpenEditorOnArrowUp(at({ modifiers: { ...base.modifiers, [key]: true } })),
                key,
            ).toBe(false);
        }
    });

    // ── Positive controls ───────────────────────────────────────────────────
    // Each guard above is asserted only in its false direction, which a
    // function that returned `false` unconditionally would also satisfy. Flip
    // exactly one field back at a time and require `true`, so every guard is
    // proven to be the thing doing the rejecting.
    it('POSITIVE CONTROL: flipping each rejecting condition back on its own yields true', () => {
        const rejecting: Array<[string, Partial<ArrowUpContext>]> = [
            ['text in composer', { composerText: 'hello', selectionStart: 5, selectionEnd: 5 }],
            ['multi-line draft', { composerText: 'a\nb', selectionStart: 3, selectionEnd: 3 }],
            ['selection', { composerText: 'abc', selectionStart: 0, selectionEnd: 3 }],
            ['no candidate', { hasEditableCandidate: false }],
            ['already editing', { isEditing: true }],
            ['replying', { isReplying: true }],
            ['suggestions open', { hasOpenSuggestions: true }],
            ['files staged', { stagedFileCount: 1 }],
            ['shift held', { modifiers: { ...base.modifiers, shiftKey: true } }],
        ];
        for (const [label, over] of rejecting) {
            expect(shouldOpenEditorOnArrowUp(at(over)), `${label} rejects`).toBe(false);
            // Removing that one condition restores the true outcome.
            expect(shouldOpenEditorOnArrowUp(base), `${label} — baseline still true`).toBe(true);
        }
    });

    it('POSITIVE CONTROL: the predicate can return true for each surface shape it will see', () => {
        // DM shape (user-id ownership) and channel shape (device-id ownership)
        // both reduce to hasEditableCandidate here; assert the wiring feeds it.
        expect(shouldOpenEditorOnArrowUp(at({ hasEditableCandidate: true }))).toBe(true);
        const dmList = [text('m', ME)];
        const chList: EditableMessageLike[] = [{ id: 'm', content: { type: 'text' }, sender_device_id: MY_DEVICE }];
        expect(shouldOpenEditorOnArrowUp(at({
            hasEditableCandidate: !!findLastEditableOwnMessage(dmList, ctx),
        }))).toBe(true);
        expect(shouldOpenEditorOnArrowUp(at({
            hasEditableCandidate: !!findLastEditableOwnMessage(chList, ctx),
        }))).toBe(true);
    });
});
