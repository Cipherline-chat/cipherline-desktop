import { describe, it, expect } from 'vitest';
import {
    MESSAGE_DELETE_ENTRY_POINTS,
    shouldConfirmMessageDelete,
    buildDeleteConfirmCopy,
    type MessageDeleteEntryPoint,
    type MessageDeleteEntryPointSpec,
} from './messageDeleteConfirm';

const ALL_ENTRY_POINTS: MessageDeleteEntryPoint[] = ['msgbar-mouse', 'msgbar-keyboard', 'contextmenu'];

describe('MESSAGE_DELETE_ENTRY_POINTS', () => {
    it('lists every known delete affordance exactly once', () => {
        const ids = MESSAGE_DELETE_ENTRY_POINTS.map(s => s.id).sort();
        expect(ids).toEqual([...ALL_ENTRY_POINTS].sort());
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('requires confirmation on every one of them', () => {
        for (const spec of MESSAGE_DELETE_ENTRY_POINTS) {
            expect(spec.requiresConfirmation, `${spec.id} must confirm`).toBe(true);
        }
    });
});

describe('shouldConfirmMessageDelete', () => {
    it('confirms on every registered entry point when Shift is not held', () => {
        for (const entryPoint of ALL_ENTRY_POINTS) {
            expect(shouldConfirmMessageDelete({ entryPoint, shiftKey: false }), entryPoint).toBe(true);
        }
    });

    it('is bypassed by Shift on every registered entry point', () => {
        for (const entryPoint of ALL_ENTRY_POINTS) {
            expect(shouldConfirmMessageDelete({ entryPoint, shiftKey: true }), entryPoint).toBe(false);
        }
    });

    it('bypasses identically for the keyboard activation path as for the mouse one', () => {
        // The bypass must not be mouse-only: Shift+Enter on the focused trash
        // button arrives here as entryPoint 'msgbar-keyboard' with shiftKey true.
        expect(shouldConfirmMessageDelete({ entryPoint: 'msgbar-keyboard', shiftKey: true })).toBe(false);
        expect(shouldConfirmMessageDelete({ entryPoint: 'msgbar-mouse', shiftKey: true })).toBe(false);
    });

    it('confirms for an entry point that is not in the table (fails safe)', () => {
        expect(shouldConfirmMessageDelete({
            entryPoint: 'some-future-path' as MessageDeleteEntryPoint,
            shiftKey: false,
        })).toBe(true);
    });

    it('still confirms for an unregistered entry point even with Shift held', () => {
        // An unlisted path has no vetted bypass; Shift must not smuggle one in.
        expect(shouldConfirmMessageDelete({
            entryPoint: 'some-future-path' as MessageDeleteEntryPoint,
            shiftKey: true,
        })).toBe(true);
    });

    // ── Positive control ────────────────────────────────────────────────────
    // Every assertion above would also pass if the function ignored
    // `requiresConfirmation` entirely and just returned `!shiftKey` for known
    // ids. Inject a table whose flag is false and prove the flag is read.
    it('POSITIVE CONTROL: honours requiresConfirmation=false (flag is actually read)', () => {
        const optedOut: MessageDeleteEntryPointSpec[] = [
            { id: 'msgbar-mouse', description: 'test double', requiresConfirmation: false },
        ];
        expect(shouldConfirmMessageDelete({ entryPoint: 'msgbar-mouse', shiftKey: false }, optedOut)).toBe(false);

        const optedIn: MessageDeleteEntryPointSpec[] = [
            { id: 'msgbar-mouse', description: 'test double', requiresConfirmation: true },
        ];
        expect(shouldConfirmMessageDelete({ entryPoint: 'msgbar-mouse', shiftKey: false }, optedIn)).toBe(true);
    });
});

describe('buildDeleteConfirmCopy', () => {
    it('is a bare yes/no — a title and a Delete label, no body text or hint', () => {
        // Owner request (2026-09-16): "just delete, yes or no". If a paragraph
        // or the Shift hint creeps back into the dialog, this fails.
        const copy = buildDeleteConfirmCopy({ isOwnMessage: true });
        expect(Object.keys(copy).sort()).toEqual(['confirmLabel', 'title']);
        expect(copy.title).toBe('Delete this message?');
        expect(copy.confirmLabel).toBe('Delete');
    });

    it('labels a moderator deletion as one', () => {
        const mine = buildDeleteConfirmCopy({ isOwnMessage: true });
        const theirs = buildDeleteConfirmCopy({ isOwnMessage: false });
        expect(mine.title).not.toBe(theirs.title);
        expect(theirs.title.toLowerCase()).toMatch(/moderator/);
    });

    it('always confirms with the word Delete', () => {
        expect(buildDeleteConfirmCopy({ isOwnMessage: false }).confirmLabel).toBe('Delete');
    });
});
