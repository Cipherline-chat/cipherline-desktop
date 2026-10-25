import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentProblem } from '../utils/contentValidation';
import { SETTINGS_INDEX } from './settings/settingsSearchIndex';

/**
 * My Emojis is many modules that only work if they are CONNECTED: the send
 * paths must attach the bytes, the receive paths must file them, the renderers
 * must branch on the id, the sync hook must be mounted, the settings pane must
 * be reachable. Each piece has its own unit tests; these pin the wiring (the
 * failure class where a module is tested in isolation and never registered).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('My Emojis wiring', () => {
    const chat = read('ChatPane.tsx');
    const dash = read('Dashboard.tsx');

    it('every ChatPane send path serializes through serializeForSend (no raw JSON.stringify of message content left)', () => {
        // sendClientContent (channel + DM), enqueueDelivery, and the two non-text-only sends.
        expect(count(chat, 'serializeForSend(')).toBeGreaterThanOrEqual(5);
        expect(chat).not.toMatch(/JSON\.stringify\(job\.content\)/);
        // (Attachment / call / key messages carry no text, so they stay plain JSON.stringify.)
        expect(chat).not.toMatch(/const contentJson = JSON\.stringify\(content\);/);
        expect(chat).not.toMatch(/JSON\.stringify\(msgContent\)/);
    });

    it('every place that decrypts a message body files personal emojis before use (DM pull, live channel, channel history)', () => {
        expect(count(dash, 'ingestInboundContent(JSON.parse(contentJson))')).toBe(3);
        expect(dash).not.toMatch(/(?<!ingestInboundContent\()JSON\.parse\(contentJson\)/);
    });

    it('the three emoji renderers (inline, jumbo, reaction) branch on a personal id before the server-emoji lookup', () => {
        expect(count(chat, 'isPersonalEmojiId(parsed')).toBeGreaterThanOrEqual(3);
        expect(count(chat, '<PersonalEmojiImage')).toBeGreaterThanOrEqual(4); // + the autocomplete row
    });

    it('server emojis in messages and reactions offer Save to My Emojis', () => {
        expect(count(chat, 'saveable')).toBeGreaterThanOrEqual(3);
    });

    it('the library sync is mounted once, in the Dashboard', () => {
        expect(dash).toContain('usePersonalEmojiSync({ userId, deviceId, token })');
    });

    it('the emoji picker has a My Emojis category and the :name autocomplete searches the library', () => {
        const picker = read('EmojiPicker.tsx');
        expect(read('emojiPickerTabs.ts')).toContain("categoryId: 'my_emojis'");
        expect(picker).toContain('buildEmojiTabCategories(');
        expect(chat).toContain('searchEmojiWithCustom(query, serverEmojis, myEmojiEntries)');
    });

    it('Settings has a Personalize pane in the left nav, rendered, with search entries', () => {
        // DepthGauge pulls in the whole settings UI, so read the nav as text:
        // 'personalize' must sit inside the first (Surface) zone, before Twilight.
        const nav = read('settings/DepthGauge.tsx');
        const surface = nav.slice(nav.indexOf("name: 'Surface'"), nav.indexOf("name: 'Twilight'"));
        expect(surface).toContain("{ id: 'personalize', label: 'Personalize'");
        expect(read('settings/SettingsScreen.tsx')).toContain("pane === 'personalize' && <PersonalizePane />");
        expect(SETTINGS_INDEX.personalize.some(e => e.label === 'My Emojis')).toBe(true);
    });

    it('the content boundary does not reject the new optional field on text, edit or reaction', () => {
        const pe = [{ id: 'p_' + 'a'.repeat(32), name: 'pepe', mime: 'image/webp', animated: false, bytes_b64: 'AAAA' }];
        const tok = `<:pepe:p_${'a'.repeat(32)}>`;
        expect(contentProblem({ type: 'text', text: `hi ${tok}`, personal_emojis: pe })).toBeNull();
        expect(contentProblem({ type: 'edit', target_id: 'm1', text: `hi ${tok}`, personal_emojis: pe })).toBeNull();
        expect(contentProblem({ type: 'reaction', target_id: 'm1', emoji: tok, action: 'add', personal_emojis: pe })).toBeNull();
    });
});
