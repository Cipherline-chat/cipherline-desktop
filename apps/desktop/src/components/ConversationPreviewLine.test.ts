import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The module-level `composerDrafts` singleton is built over secureLocalStore;
// give it an in-memory stand-in (one "disk", per-account readiness).
const h = vi.hoisted(() => {
    const disk = new Map<string, string>();
    const ready = new Set<string>();
    return {
        disk, ready,
        store: {
            getItem: (k: string) => disk.get(k) ?? null,
            setItem: (k: string, v: string) => { disk.set(k, v); },
            removeItem: (k: string) => { disk.delete(k); },
            isAccountReady: (u: string) => ready.has(u),
            whenAccountReady: () => Promise.resolve(),
        },
    };
});
vi.mock('../utils/secureLocalStore', () => ({ default: h.store }));

import { composerDrafts } from '../utils/composerDraftStore';
import { createDraftStore, draftStorageKey } from '../utils/composerDrafts';
import { dmDraftKey, draftPreviewText, listDraftFor, DRAFT_PREVIEW_LABEL } from '../utils/draftPreview';
import { classifyKvKey } from '../services/backupRegistry';
import { ConversationPreviewLine } from './ConversationPreviewLine';

const A = 'user-a';
const B = 'user-b';
const DM = 'conv-dm-1';
const GROUP = 'conv-group-1';

const render = (userId: string, conversationId: string, isActive: boolean) =>
    renderToStaticMarkup(React.createElement(ConversationPreviewLine, {
        userId, conversationId, isActive, fallback: 'Last real message',
    }));

beforeEach(() => {
    vi.useFakeTimers();
    h.disk.clear();
    h.ready.clear();
    h.ready.add(A);
    h.ready.add(B);
    composerDrafts.reset();
});
afterEach(() => { composerDrafts.reset(); vi.useRealTimers(); });

describe('DM and group drafts persist like server drafts', () => {
    it('a DM draft survives a conversation switch (set, read back, other conversation empty)', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'hey are you free tonight');
        expect(composerDrafts.get(A, dmDraftKey(DM))).toBe('hey are you free tonight');
        expect(composerDrafts.get(A, dmDraftKey('some-other-dm'))).toBe('');   // control
    });

    it('a DM draft survives a reload (fresh store over the same encrypted disk)', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'typed before restart');
        composerDrafts.flush();
        // "reload": a brand new store instance, nothing cached
        const reloaded = createDraftStore({ secureLocalStore: h.store });
        expect(reloaded.get(A, dmDraftKey(DM))).toBe('typed before restart');
    });

    it('a group draft survives a reload too', () => {
        composerDrafts.set(A, dmDraftKey(GROUP), 'group draft');
        composerDrafts.flush();
        const reloaded = createDraftStore({ secureLocalStore: h.store });
        expect(reloaded.get(A, dmDraftKey(GROUP))).toBe('group draft');
        expect(reloaded.get(A, dmDraftKey(DM))).toBe('');                        // control
    });

    it('is written only to the encrypted store record, debounced', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'x');
        expect(h.disk.has(draftStorageKey(A))).toBe(false);                      // not before the debounce
        vi.advanceTimersByTime(500);
        expect(h.disk.has(draftStorageKey(A))).toBe(true);
    });

    it('clears when the message is sent (clear) and when the composer is emptied', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'about to send');
        composerDrafts.clear(A, dmDraftKey(DM));
        expect(composerDrafts.get(A, dmDraftKey(DM))).toBe('');
        composerDrafts.set(A, dmDraftKey(GROUP), 'then deleted');
        composerDrafts.set(A, dmDraftKey(GROUP), '');
        expect(composerDrafts.get(A, dmDraftKey(GROUP))).toBe('');
        composerDrafts.flush();
        expect(h.disk.has(draftStorageKey(A))).toBe(false);                      // record removed entirely
    });

    it('is isolated per account', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'for account A');
        expect(composerDrafts.get(B, dmDraftKey(DM))).toBe('');
        composerDrafts.set(B, dmDraftKey(DM), 'for account B');
        expect(composerDrafts.get(A, dmDraftKey(DM))).toBe('for account A');
        composerDrafts.flush();
        expect(h.disk.get(draftStorageKey(A))).not.toBe(h.disk.get(draftStorageKey(B)));
    });

    it('a cold account neither reads nor writes (rebind rule)', () => {
        h.ready.delete(B);
        composerDrafts.set(B, dmDraftKey(DM), 'lost while cold');
        composerDrafts.flush();
        expect(composerDrafts.get(B, dmDraftKey(DM))).toBe('');
        expect(h.disk.has(draftStorageKey(B))).toBe(false);
    });
});

describe('draft store change notifications', () => {
    it('notifies on set / clear, not on a no-op write, and stops after unsubscribe', () => {
        const fn = vi.fn();
        const off = composerDrafts.subscribe(fn);
        composerDrafts.set(A, dmDraftKey(DM), 'one');
        expect(fn).toHaveBeenCalledTimes(1);
        composerDrafts.set(A, dmDraftKey(DM), 'one');                            // identical: no-op
        expect(fn).toHaveBeenCalledTimes(1);
        composerDrafts.clear(A, dmDraftKey(DM));
        expect(fn).toHaveBeenCalledTimes(2);
        off();
        composerDrafts.set(A, dmDraftKey(DM), 'two');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('a throwing listener cannot break a draft write', () => {
        composerDrafts.subscribe(() => { throw new Error('boom'); });
        expect(() => composerDrafts.set(A, dmDraftKey(DM), 'still saved')).not.toThrow();
        expect(composerDrafts.get(A, dmDraftKey(DM))).toBe('still saved');
    });
});

describe('draft preview text', () => {
    it('collapses newlines and runs of whitespace to one line', () => {
        expect(draftPreviewText('  hello\n\nworld \t again ')).toBe('hello world again');
    });
    it('keeps display-form mentions and emoji as plain text', () => {
        expect(draftPreviewText('hi @alex :party:')).toBe('hi @alex :party:');
    });
    it('is empty for blank / missing drafts', () => {
        expect(draftPreviewText('  \n ')).toBe('');
        expect(draftPreviewText(null)).toBe('');
        expect(draftPreviewText(undefined)).toBe('');
    });
    it('is suppressed for the open conversation (negative control: shown when not open)', () => {
        expect(listDraftFor('typing', true)).toBe('');
        expect(listDraftFor('typing', false)).toBe('typing');
    });
});

describe('conversation list preview line', () => {
    it('shows an italic "Draft:" preview for a non-open conversation with a draft', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'hey are you free tonight');
        const html = render(A, DM, false);
        expect(html).toContain('data-testid="conversation-draft-preview"');
        expect(html).toContain('class="italic"');
        expect(html).toContain(DRAFT_PREVIEW_LABEL);
        expect(html).toContain('hey are you free tonight');
        expect(html).not.toContain('Last real message');
    });

    it('works for a group conversation', () => {
        composerDrafts.set(A, dmDraftKey(GROUP), 'group hello');
        const html = render(A, GROUP, false);
        expect(html).toContain('Draft:');
        expect(html).toContain('group hello');
    });

    it('shows the normal last-message preview when there is no draft', () => {
        const html = render(A, DM, false);
        expect(html).toContain('Last real message');
        expect(html).not.toContain('Draft:');
        expect(html).not.toContain('italic');
    });

    it('shows NO draft preview for the open conversation, even with a draft', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'in the composer right now');
        const html = render(A, DM, true);
        expect(html).toContain('Last real message');
        expect(html).not.toContain('in the composer right now');
        expect(html).not.toContain('Draft:');
    });

    it('does not show another account\'s draft', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'account A secret');
        const html = render(B, DM, false);
        expect(html).toContain('Last real message');
        expect(html).not.toContain('account A secret');
    });

    it('goes back to the normal preview once the draft is sent / cleared', () => {
        composerDrafts.set(A, dmDraftKey(DM), 'draft text');
        expect(render(A, DM, false)).toContain('Draft:');
        composerDrafts.clear(A, dmDraftKey(DM));
        const html = render(A, DM, false);
        expect(html).toContain('Last real message');
        expect(html).not.toContain('Draft:');
    });

    it('a whitespace-only draft is not a draft', () => {
        composerDrafts.set(A, dmDraftKey(DM), '   \n  ');
        expect(render(A, DM, false)).toContain('Last real message');
    });

    it('escapes draft text (no markup injection into the list)', () => {
        composerDrafts.set(A, dmDraftKey(DM), '<img src=x onerror=alert(1)>');
        const html = render(A, DM, false);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
});

describe('the draft preview stays local', () => {
    it('draft keys are classified EXCLUDED from backups', () => {
        expect(classifyKvKey(draftStorageKey(A), A)).toBe('exclude');
        // positive control: the registry does include ordinary account settings
        expect(classifyKvKey('cipherline_unclassified_probe_key', A)).not.toBe('exclude');
    });

    const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

    it('Dashboard renders the draft only through ConversationPreviewLine, inside the list preview <p>', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toContain('<ConversationPreviewLine');
        // last-message text (prevText) is still computed independently of the draft
        expect(dash).not.toMatch(/prevText\s*=\s*[^;]*composerDrafts/);
    });

    it('no notification, title or network code reads the draft store for previews', () => {
        for (const f of ['contexts/NotificationContext.tsx', 'hooks/useRealtime.ts']) {
            let src = '';
            try { src = read(f); } catch { continue; }
            expect(src).not.toContain('composerDrafts');
            expect(src).not.toContain('draftPreview');
            expect(src).not.toContain('useConversationDraft');
        }
    });

    it('only the list preview component consumes useConversationDraft', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).not.toContain('useConversationDraft');
        expect(read('components/ConversationPreviewLine.tsx')).toContain('useConversationDraft');
    });
});
