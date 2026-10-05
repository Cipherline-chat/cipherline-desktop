import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// useAnnouncements.ts imports axios at module scope for fetchAnnouncements
// (untouched by anything in this file). Real axios's platform-detection
// code reads `window.location` at IMPORT time, which throws under this
// file's minimal Node `window` stub — same reason useEncryptedAvatar.test.ts
// mocks it. Stubbed here purely so importing the module doesn't crash;
// nothing in this file calls it.
vi.mock('axios', () => ({ default: { get: vi.fn() } }));

import { ANNOUNCEMENTS_CHANGED_EVENT, subscribeToAnnouncementsChanged } from './useAnnouncements';

/**
 * Live-push wiring for admin-authored announcement banners.
 *
 * `useRealtime.ts` re-dispatches the WS `announcements:changed` push as a
 * `window` CustomEvent (see useAnnouncements.ts's docblock for why: this
 * hook is mounted separately inside `AnnouncementBanners`, not a consumer
 * of useRealtime's return value / Dashboard.tsx's props). This repo has no
 * jsdom / `@testing-library/react` (vitest.config.ts runs `environment:
 * 'node'`, and vitest's `include` only collects `.test.ts`, never `.tsx` —
 * see CLAUDE.md), so the hook itself cannot be rendered here. What CAN be
 * tested directly, without a renderer, is `subscribeToAnnouncementsChanged`
 * — the exact function the hook's live-push `useEffect` is now a one-line
 * call to (`useEffect(() => subscribeToAnnouncementsChanged(...), [...])`)
 * — using a real `EventTarget`-backed `window` built in this file only.
 *
 * `vitest.setup.ts`'s shared stub gives every test file a `window` object
 * with a NO-OP `addEventListener` (`() => {}`) and no `dispatchEvent` at
 * all — enough to keep unrelated modules from throwing at import time, not
 * enough to exercise a real event bus. This file replaces those three
 * methods with ones backed by a real Node `EventTarget` in `beforeEach`,
 * scoped to this file only (vitest isolates modules per test file by
 * default, and this doesn't touch the shared setup file), and restores the
 * stub afterward.
 */

let realTarget: EventTarget;
const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
    realTarget = new EventTarget();
    g.window = {
        addEventListener: realTarget.addEventListener.bind(realTarget),
        removeEventListener: realTarget.removeEventListener.bind(realTarget),
        dispatchEvent: realTarget.dispatchEvent.bind(realTarget),
    };
});

afterEach(() => {
    // Restore the vitest.setup.ts shape so this file's patch never leaks
    // into how the next test in this file (or, if isolation were ever
    // turned off, another file) sees `window`.
    g.window = { addEventListener: () => {} };
});

describe('subscribeToAnnouncementsChanged', () => {
    it('calls onChanged when ANNOUNCEMENTS_CHANGED_EVENT is dispatched on window — the live-push path', () => {
        const onChanged = vi.fn();
        subscribeToAnnouncementsChanged(onChanged);

        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));

        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('fires again on a second dispatch — not a one-shot subscription', () => {
        const onChanged = vi.fn();
        subscribeToAnnouncementsChanged(onChanged);

        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));
        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));

        expect(onChanged).toHaveBeenCalledTimes(2);
    });

    // POSITIVE CONTROL #1 — proves the assertion above can actually fail,
    // and that the listener is scoped to the right event name rather than
    // "any window event": dispatching something else must NOT fire it.
    // Confirmed by temporarily changing the dispatched name below from
    // `'some-unrelated-event'` to `ANNOUNCEMENTS_CHANGED_EVENT` — this test
    // then failed (onChanged WAS called) — and reverting.
    it('does NOT call onChanged for an unrelated window event', () => {
        const onChanged = vi.fn();
        subscribeToAnnouncementsChanged(onChanged);

        window.dispatchEvent(new CustomEvent('some-unrelated-event'));

        expect(onChanged).not.toHaveBeenCalled();
    });

    // POSITIVE CONTROL #2 — this is the one that would have caught the
    // ACTUAL bug this task fixes: before this change, nothing in
    // apps/desktop subscribed to `announcements:changed` at all
    // (`grep -rn "announcements:changed" apps/desktop/src` returned zero
    // matches), so the push reached the socket and fell on the floor.
    // Confirmed this test fails on that regression by temporarily
    // reverting `subscribeToAnnouncementsChanged` to a no-op (`() => () =>
    // {}`, i.e. never calling `window.addEventListener` at all) — the first
    // test above then failed with 0 calls instead of 1 — and restoring the
    // real implementation.
    it('the unsubscribe function stops further delivery (cleanup path)', () => {
        const onChanged = vi.fn();
        const unsubscribe = subscribeToAnnouncementsChanged(onChanged);

        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));
        expect(onChanged).toHaveBeenCalledTimes(1);

        unsubscribe();
        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));

        // Still 1 — the second dispatch, after unsubscribing, must not add another call.
        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('supports multiple independent subscribers (single component tree vs. a second mounted instance)', () => {
        const first = vi.fn();
        const second = vi.fn();
        subscribeToAnnouncementsChanged(first);
        subscribeToAnnouncementsChanged(second);

        window.dispatchEvent(new CustomEvent(ANNOUNCEMENTS_CHANGED_EVENT));

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });
});

/**
 * useRealtime.ts dispatches the live push with the event name HARDCODED as
 * a string literal (`'cipherline:announcements-changed'`), not by importing
 * `ANNOUNCEMENTS_CHANGED_EVENT` from this file — importing it would pull
 * `axios` (this module's dependency, used by `fetchAnnouncements`) in
 * transitively, and axios's platform-detection code throws at import time
 * under useRealtime.test.ts's minimal Node `window` stub. See the comment
 * at useRealtime.ts's `announcements:changed` handler for the full
 * explanation.
 *
 * That duplication recreates exactly the failure class this whole feature
 * exists to fix: two correct halves with an unasserted seam between them.
 * A rename or typo of the constant on either side would silently kill the
 * live push again — `window.addEventListener` and `window.dispatchEvent`
 * would each still "work", just never for the same event name — and the
 * rest of this file's tests would stay green throughout, because they only
 * ever exercise `ANNOUNCEMENTS_CHANGED_EVENT` against itself.
 *
 * This source-scan pins the two together directly, the same idiom
 * `backupRegistry.test.ts` already uses in this repo (it scans source for
 * every `secureLocalStore.setItem`/`secureStore.set` key and fails on an
 * unclassified one) rather than something novel here.
 */
describe('useRealtime.ts stays in sync with ANNOUNCEMENTS_CHANGED_EVENT', () => {
    it('contains the exact literal value of the exported constant', () => {
        const useRealtimePath = join(dirname(fileURLToPath(import.meta.url)), 'useRealtime.ts');
        const source = readFileSync(useRealtimePath, 'utf8');

        expect(
            source.includes(ANNOUNCEMENTS_CHANGED_EVENT),
            `useRealtime.ts must dispatch the exact string "${ANNOUNCEMENTS_CHANGED_EVENT}" — ` +
            `it cannot import the constant (axios-under-window-stub, see the docblock above), ` +
            `so this scan is what keeps the hardcoded literal there and the exported constant ` +
            `here from silently drifting apart.`,
        ).toBe(true);
    });
});
