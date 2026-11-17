// @vitest-environment jsdom
/**
 * The approved icon set has ONE definition the API enforces
 * (@cipherline/shared CHANNEL_ICON_NAMES). This pins it to what the desktop
 * picker really offers, and the Discord importer's icon names to it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHANNEL_ICON_NAMES, isChannelIconName } from '@cipherline/shared';

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
const { CHANNEL_ICON_STORED_NAMES, lookupChannelIcon } = await import('../components/server/ChannelIconPicker');

// The API source only exists in the private monorepo; the public export skips the cross-repo case below.
const IMPORT_ICONS_PATH = resolve(__dirname, '../../../api/src/servers/discord-template/discord-template.icons.ts');

describe('approved icon allowlist', () => {
    it('shared allowlist === the icons the picker can store (no drift either way)', () => {
        expect([...CHANNEL_ICON_NAMES].sort()).toEqual([...CHANNEL_ICON_STORED_NAMES].sort());
    });

    it('every allowed name renders as a real icon', () => {
        expect(CHANNEL_ICON_NAMES.filter(n => lookupChannelIcon(n) === undefined)).toEqual([]);
    });

    it('rejects emoji, free text and the picker alias', () => {
        for (const v of ['\u{1F4C4}', '\u{1FAB5}', 'wood', '', 'ImageIcon', 'Hash ', null, 5]) expect(isChannelIconName(v)).toBe(false);
        expect(isChannelIconName('Hammer')).toBe(true);
    });

    it.skipIf(!existsSync(IMPORT_ICONS_PATH))('every icon the Discord import can emit is an approved icon (never a raw emoji)', () => {
        const src = readFileSync(IMPORT_ICONS_PATH, 'utf8');
        const m = /export const IMPORT_ICON_NAMES = \[([\s\S]*?)\] as const;/.exec(src)!;
        const names = Array.from(m[1].matchAll(/'([A-Za-z0-9]+)'/g), x => x[1]);
        expect(names.length).toBeGreaterThan(50);
        expect(names.filter(n => !isChannelIconName(n))).toEqual([]);
    });
});
