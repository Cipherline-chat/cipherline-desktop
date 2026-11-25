import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stickerSectionServer, UNKNOWN_SERVER_NAME, type StickerServerLite } from './sectionServer';

const ALPHA: StickerServerLite = { server_id: 'a', name: 'Alpha Squad', icon_attachment: 'att-a', icon_key_b64: 'k', icon_nonce_b64: 'n' };
const BRAVO: StickerServerLite = { server_id: 'b', name: 'Bravo Lounge', icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null };
const SERVERS = [ALPHA, BRAVO];

describe('stickerSectionServer', () => {
    it('maps a server with an icon to the ServerIcon props', () => {
        expect(stickerSectionServer('a', SERVERS)).toEqual({
            serverId: 'a', name: 'Alpha Squad', attachmentId: 'att-a', keyB64: 'k', nonceB64: 'n',
        });
    });

    it('a server with no icon gets nulls, so ServerIcon draws its abbreviation tile', () => {
        expect(stickerSectionServer('b', SERVERS)).toEqual({
            serverId: 'b', name: 'Bravo Lounge', attachmentId: null, keyB64: null, nonceB64: null,
        });
    });

    it('uses the server NAME, never a section title like "(this server)"', () => {
        expect(stickerSectionServer('a', SERVERS).name).toBe('Alpha Squad');
    });

    it.each([
        ['no key', { icon_key_b64: null }],
        ['no nonce', { icon_nonce_b64: '' }],
        ['no attachment', { icon_attachment: null }],
    ])('a partial icon (%s) is treated as no icon', (_label, patch) => {
        const got = stickerSectionServer('a', [{ ...ALPHA, ...patch }]);
        expect(got).toMatchObject({ attachmentId: null, keyB64: null, nonceB64: null, name: 'Alpha Squad' });
    });

    it('a server missing from the list (still loading, or just left) still gets a fallback tile', () => {
        expect(stickerSectionServer('zzz', SERVERS)).toEqual({
            serverId: 'zzz', name: UNKNOWN_SERVER_NAME, attachmentId: null, keyB64: null, nonceB64: null,
        });
    });

    it('a caller without icon fields at all type-checks and falls back', () => {
        expect(stickerSectionServer('x', [{ server_id: 'x', name: 'Plain' }])).toMatchObject({ name: 'Plain', attachmentId: null });
    });

    it('a blank name falls back to the neutral name', () => {
        expect(stickerSectionServer('x', [{ server_id: 'x', name: '   ' }]).name).toBe(UNKNOWN_SERVER_NAME);
    });
});

describe('StickerPicker wiring (source scan)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', 'components', 'stickers', 'StickerPicker.tsx'), 'utf8');

    it('draws server sections with the shared ServerIcon, not a hand-rolled initials span', () => {
        expect(src).toContain("import { ServerIcon } from '../server/ServerIcon'");
        expect(src).toContain('<ServerIcon');
        expect(src).not.toMatch(/initials\(/);
    });

    it('both server section shapes (with stickers, and the empty current server) carry the server', () => {
        expect(src.match(/server: stickerSectionServer\(/g)?.length).toBe(2);
    });

    it('the icon is decorative: nav buttons keep their aria-label/title and the glyph is aria-hidden', () => {
        expect(src).toMatch(/title=\{s\.title\}\s+aria-label=\{s\.title\}/);
        expect(src).toContain('<span aria-hidden="true" className="inline-flex shrink-0">');
    });

    it('section headers show the icon next to the title', () => {
        expect(src).toMatch(/\{sec\.server && <SectionGlyph section=\{sec\}/);
    });
});
