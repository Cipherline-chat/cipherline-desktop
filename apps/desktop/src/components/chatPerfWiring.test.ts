import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level guards for the chat/navigation performance fixes (2026-10-03).
 * ChatPane/Dashboard have no render harness (see feedScrollWiring.test.ts for
 * the same approach); the helpers themselves are unit-tested next to them.
 * Each assertion pins a regression that was measured, not hypothetical.
 */
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const chat = read('ChatPane.tsx');

describe('ChatPane render path', () => {
    it('formats row timestamps with cached formatters, not toLocale* (≈1 s of a 49-keystroke profile)', () => {
        expect(chat).not.toMatch(/\.toLocaleTimeString\(/);
        expect(chat).not.toMatch(/\.toLocaleDateString\(/);
        expect(chat).toMatch(/from '\.\.\/utils\/messageTimeFormat'/);
    });

    it('wraps every message row in MemoRow keyed by the message and the pane-wide inputs', () => {
        // Keyed by the message's stable identity, not msg.id: an instant send's
        // client id → server id swap must not remount the row (and replay its
        // entrance). See utils/messageEntrance.ts / messageRowIdentityWiring.test.ts.
        expect(chat).toMatch(/<MemoRow key=\{rowKey\} deps=\{rowDeps\} render=\{\(\) => \{/);
        expect(chat).toMatch(/const rowKey = rowKeys\[index\];/);
        const deps = chat.slice(chat.indexOf('const rowDeps = ['), chat.indexOf('];', chat.indexOf('const rowDeps = [')));
        for (const d of ['...rowGlobals', 'msg', 'hoveredMsgId === msg.id', 'objectUrls[msg.id]', 'replyTarget']) expect(deps).toContain(d);
        // What render-time helpers read must be in the globals, or a skipped row would show stale state.
        const globals = chat.slice(chat.indexOf('const rowGlobals = ['), chat.indexOf('];', chat.indexOf('const rowGlobals = [')));
        for (const g of ['stRetentionPolicy', 'stablePinnedMsgIds', 'stServerSavedIds', 'canSaveMessages', 'hasServerSave',
            'channelMessageRetention', 'channelAttachmentRetention', 'convType', 'userIdToUsername', 'deviceToUsername', 'nowTick']) {
            expect(globals).toContain(g);
        }
    });

    it('rows reach handlers that touch non-row state only through useLiveCallbacks', () => {
        const body = chat.slice(chat.indexOf('<MemoRow key='), chat.indexOf('}} />', chat.indexOf('<MemoRow key=')));
        expect(body).toMatch(/\} = rowLive;/);
        for (const fn of ['handleContextMenu', 'startEdit', 'requestDelete', 'handleAddReaction', 'jumpToMessage', 'decryptManual']) {
            expect(body.slice(0, body.indexOf('} = rowLive;'))).toContain(fn);
        }
        expect(body).toMatch(/const retention = \{\s*saveMessage: rowLive\.saveMessage/);
        // The reply quote no longer scans the whole conversation per row.
        expect(body).not.toMatch(/messages\.find\(/);
    });

    it('auto-decrypts the on-screen window (+ a page ahead, + pinned), not the whole history', () => {
        // Newest first: the bottom of the feed is what's on screen, so it takes the decrypt slots first.
        expect(chat).toMatch(/\[\.\.\.decryptScope\.inScope\]\.reverse\(\)\.forEach\(async \(msg\) =>/);
        expect(chat).not.toMatch(/\n\s+messages\.forEach\(async \(msg\) => \{\n\s+const content = msg\.content as any;/);
        expect(chat).toMatch(/backgroundCacheEncryptedAttachment\(/);
    });

    it('auto-decrypt runs four at a time and a row queued for a pane that was left does no work', () => {
        expect(chat).toMatch(/const attachmentDecryptSlots = new PrioritySemaphore\(4\);/);
        const body = chat.slice(chat.indexOf('await attachmentDecryptSlots.run(false'), chat.indexOf("console.error('Failed to decrypt and render attachment'"));
        expect(body).toContain('trackActivity(\'attachment:decrypt\'');
        // The mounted check is the first thing inside the slot, before any read/download/decrypt.
        expect(body.indexOf('if (!paneMountedRef.current)')).toBeGreaterThan(-1);
        expect(body.indexOf('if (!paneMountedRef.current)')).toBeLessThan(body.indexOf('getEncryptedAttachment('));
        expect(body.indexOf('getEncryptedAttachment(')).toBeLessThan(body.indexOf('decryptBlob('));
    });

    it('every decrypted attachment URL is minted by the ONE media cache (no raw createObjectURL, no second cache)', () => {
        expect(chat).not.toMatch(/decryptedAttachmentCache/);
        // ChatPane's only direct createObjectURL is the staged-file preview, which is not a decrypted attachment.
        expect([...chat.matchAll(/URL\.createObjectURL\(/g)].length).toBe(1);
        expect(chat).toMatch(/stagedFileUrlCacheRef\.current\.set\(f, URL\.createObjectURL\(f\)\)/);
        // auto-decrypt, manual decrypt and both own-upload paths register through putDecryptedMediaBlob.
        expect([...chat.matchAll(/putDecryptedMediaBlob\(/g)].length).toBe(4);
    });

    it('the sender shows their own upload straight from the local File (both the DM and the channel path)', () => {
        expect(chat).toMatch(/adoptAttachmentUrl\(content\.client_msg_id!, initRes\.data\.attachment_id, putDecryptedMediaBlob\(initRes\.data\.attachment_id, file\)\)/);
        expect(chat).toMatch(/adoptAttachmentUrl\(serverMsgId, initRes\.data\.attachment_id, putDecryptedMediaBlob\(initRes\.data\.attachment_id, file\)\)/);
    });

    it('linked images decode base64 natively and are cached per URL', () => {
        expect(chat).not.toContain('Uint8Array.from(atob(');
        expect(chat).toMatch(/loadRemoteImage\(url,/);
    });
});

describe('member list', () => {
    it('member rows are rendered by a function, never a component type re-declared every render', () => {
        const panel = read('server/ServerContextPanel.tsx');
        expect(panel).not.toMatch(/<MemberTile\b/);
        expect(panel).toMatch(/const renderMemberTile = \(/);
    });
});

describe('always-on animations stay off the main thread', () => {
    it('the online status pulse animates transform/opacity, not box-shadow', () => {
        const css = read('../index.css');
        const kf = css.slice(css.indexOf('@keyframes status-online-pulse'), css.indexOf('}', css.indexOf('@keyframes status-online-pulse') + 40) + 60);
        expect(kf).not.toContain('box-shadow');
        expect(kf).toContain('transform');
        expect(css).toMatch(/\.status-online::after \{[^}]*animation: status-online-pulse/);
    });
});

describe('conversation storage panel', () => {
    it('sizes the conversation only when its messages change, not on every Dashboard render', () => {
        const src = read('ConvRetentionSection.tsx');
        expect(src).toMatch(/useMemo\(\(\) => calcConversationStorage\(convId, msgs\), \[convId, msgs\]\)/);
    });
});

describe('emoji picker', () => {
    it('keeps the <Picker> element stable so emoji-mart is not reset on every popover render', () => {
        const src = read('EmojiPicker.tsx');
        // @emoji-mart/react forwards every wrapper render as picker.update(props),
        // which emoji-mart treats as a full grid reset whenever `custom` is passed.
        expect(src).toMatch(/const pickerEl = useMemo\(\(\) => \(\s*<Picker/);
        expect(src).toMatch(/\), \[customCategories, stableOnSelect\]\);/);
        expect(src).toContain('{pickerEl}');
        expect(src).toMatch(/onEmojiSelect=\{stableOnSelect\}/);
    });
});

describe('channel history refresh', () => {
    it('does not re-decrypt rows already cached as real content', () => {
        const dash = read('Dashboard.tsx');
        // Every history read (the newest page on open, older/newer gap fills,
        // the page around a jumped-to message, rows by id) folds through
        // ingestChannelRows — so the reuse rule lives there, once.
        const fn = dash.slice(dash.indexOf('const ingestChannelRows = useCallback'), dash.indexOf('const loadChannelMessagesById = useCallback'));
        expect(fn).toMatch(/splitReusableChannelRows\(raw, channelMessagesRef\.current\[channelId\]\)/);
        expect(fn).toMatch(/decryptChannelRows\(channelId, toDecrypt\)/);
        const refresh = dash.slice(dash.indexOf('const refreshChannelHistory = useCallback'), dash.indexOf('const channelKeyEnsureInFlightRef'));
        expect(refresh).toContain('await ingestChannelRows(serverId, channelId, raw,');
    });
});
