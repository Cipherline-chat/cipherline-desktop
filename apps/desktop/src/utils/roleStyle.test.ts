import { describe, expect, it } from 'vitest';
import {
    buildMemberRoleDecor,
    buildMemberRoleSecondary,
    getTopIconRole,
    roleIconOf,
    roleNameStyle,
    roleSecondaryHex,
    roleSwatchBackground,
    type RoleDecorFields,
} from './roleStyle';
import { DARK_THEME, THEMES } from '../theme/themes';
import { contrastRatio } from './roleColor';
import { describeAuditEntry } from '../components/server/auditLog';
import { roleIconErrorMessage, roleIconFileError } from '../components/server/roles/roleIconPickerModel';

const role = (over: Partial<RoleDecorFields> & { role_id: string }): RoleDecorFields => ({
    name: over.role_id, color: -1, position: 1000, is_everyone: false, ...over,
});

const themeById = (id: string) => {
    const t = Object.values(THEMES).find(x => x.id === id);
    if (!t) throw new Error(`no theme ${id}`);
    return t;
};

describe('roleSecondaryHex — when a role is a gradient', () => {
    it('needs both colours, a valid packed RGB, and two DIFFERENT colours', () => {
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: 0x445566 })).toBe('#445566');
        expect(roleSecondaryHex({ color: -1, secondary_color: 0x445566 })).toBeNull();      // no primary
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: -1 })).toBeNull();      // explicit none
        expect(roleSecondaryHex({ color: 0x112233 })).toBeNull();                           // old API: absent
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: null })).toBeNull();
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: 0x112233 })).toBeNull(); // same colour
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: 0x1000000 })).toBeNull(); // out of range
        expect(roleSecondaryHex({ color: 0x112233, secondary_color: 1.5 })).toBeNull();
        expect(roleSecondaryHex(null)).toBeNull();
    });
});

describe('roleIconOf / getTopIconRole', () => {
    it('emoji icon, image icon (all three fields needed), none', () => {
        expect(roleIconOf(role({ role_id: 'a', icon_emoji: '🔥' }), 's1')).toEqual({ kind: 'emoji', emoji: '🔥', roleName: 'a', roleId: 'a' });
        expect(roleIconOf(role({ role_id: 'b', icon_attachment_id: 'att', icon_key_b64: 'k', icon_nonce_b64: 'n' }), 's1')).toEqual({
            kind: 'image', roleName: 'b', roleId: 'b', ref: { serverId: 's1', attachmentId: 'att', keyB64: 'k', nonceB64: 'n' },
        });
        expect(roleIconOf(role({ role_id: 'c', icon_attachment_id: 'att', icon_key_b64: 'k' }), 's1')).toBeNull();
        expect(roleIconOf(role({ role_id: 'd', icon_emoji: '' }), 's1')).toBeNull();
        expect(roleIconOf(role({ role_id: 'e', icon_emoji: 'x'.repeat(33) }), 's1')).toBeNull();
        expect(roleIconOf(role({ role_id: 'f' }), 's1')).toBeNull(); // old API: no fields
    });

    it('@everyone never carries an icon, even if the row says so', () => {
        expect(roleIconOf(role({ role_id: 'ev', is_everyone: true, icon_emoji: '🔥' }), 's1')).toBeNull();
    });

    it("the member's HIGHEST role that has an icon wins; icon-less higher roles are skipped", () => {
        const roles = [
            role({ role_id: 'admin', position: 5000 }),                       // highest, no icon
            role({ role_id: 'mod', position: 3000, icon_emoji: '🛡️' }),
            role({ role_id: 'vip', position: 2000, icon_emoji: '💎' }),
            role({ role_id: 'ev', position: 0, is_everyone: true, icon_emoji: '🌍' }),
        ];
        expect(getTopIconRole(['admin', 'mod', 'vip', 'ev'], roles)?.role_id).toBe('mod');
        expect(getTopIconRole(['vip'], roles)?.role_id).toBe('vip');
        expect(getTopIconRole(['admin'], roles)).toBeNull();
        expect(getTopIconRole([], roles)).toBeNull();
    });
});

describe('buildMemberRoleDecor / buildMemberRoleSecondary', () => {
    const roles = [
        role({ role_id: 'gold', position: 4000, color: 0xf5a623, secondary_color: 0xec4899 }),
        role({ role_id: 'mod', position: 3000, color: 0x25e0c8, icon_emoji: '🛡️' }),
        role({ role_id: 'plain', position: 2000, color: 0x5865f2 }),
    ];
    const members = [
        { user_id: 'u-both', role_ids: ['gold', 'mod'] },
        { user_id: 'u-mod', role_ids: ['mod'] },
        { user_id: 'u-plain', role_ids: ['plain'] },
        { user_id: 'u-none', role_ids: [] },
        { user_id: 'u-null', role_ids: null },
    ];

    it("gradient follows the member's COLOUR role; icon follows the highest icon role", () => {
        const decor = buildMemberRoleDecor(members, roles, 's1');
        expect(decor['u-both'].secondary).toBe('#ec4899');
        expect(decor['u-both'].icon).toMatchObject({ kind: 'emoji', emoji: '🛡️' });
        expect(decor['u-mod']).toEqual({ secondary: null, icon: expect.objectContaining({ emoji: '🛡️' }) });
        expect(decor['u-plain']).toBeUndefined();
        expect(decor['u-none']).toBeUndefined();
        expect(decor['u-null']).toBeUndefined();
    });

    it('a higher SOLID colour role hides a lower gradient (Discord: the top colour role decides)', () => {
        const r = [
            role({ role_id: 'top', position: 9000, color: 0x23cf65 }),
            role({ role_id: 'grad', position: 1000, color: 0x112233, secondary_color: 0x445566 }),
        ];
        expect(buildMemberRoleSecondary([{ user_id: 'u', role_ids: ['top', 'grad'] }], r)).toEqual({});
        expect(buildMemberRoleSecondary([{ user_id: 'u', role_ids: ['grad'] }], r)).toEqual({ u: '#445566' });
    });

    it('an old API (no new fields on any role) yields nothing, cheaply', () => {
        const old = [role({ role_id: 'r', color: 0x123456 })];
        expect(buildMemberRoleDecor([{ user_id: 'u', role_ids: ['r'] }], old, 's1')).toEqual({});
        expect(buildMemberRoleSecondary([{ user_id: 'u', role_ids: ['r'] }], old)).toEqual({});
    });
});

describe('roleNameStyle — gradient text with an accessible fallback', () => {
    it('solid colour exactly as before when there is no gradient; fallback when no colour', () => {
        expect(roleNameStyle('#25e0c8', null, 'var(--cl-bright)', DARK_THEME)).toEqual({ style: { color: '#25e0c8' } });
        expect(roleNameStyle(null, '#ec4899', 'var(--cl-bright)', DARK_THEME)).toEqual({ style: { color: 'var(--cl-bright)' } });
    });

    it('gradient = class + both stops, and `color` stays the primary (forced-colours / selection fallback)', () => {
        const s = roleNameStyle('#f5a623', '#ec4899', 'var(--cl-bright)', DARK_THEME);
        expect(s.className).toBe('cl-role-gradient');
        expect(s.style).toMatchObject({ color: '#f5a623', '--cl-role-a': '#f5a623', '--cl-role-b': '#ec4899' });
    });

    it('high-contrast themes get the solid primary instead of a gradient', () => {
        for (const id of ['hc-dark', 'hc-light']) {
            const s = roleNameStyle('#f5a623', '#ec4899', 'var(--cl-bright)', themeById(id));
            expect(s.className).toBeUndefined();
            expect(typeof s.style.color).toBe('string');
        }
    });

    it('on Light, BOTH stops are darkened to clear the theme name contrast against its page', () => {
        const light = themeById('light');
        // Pale yellow -> pale cyan: unreadable on a cream page as picked.
        const s = roleNameStyle('#fff176', '#b2ebf2', 'var(--cl-bright)', light);
        const style = s.style as Record<string, string>;
        expect(s.className).toBe('cl-role-gradient');
        for (const stop of [style['--cl-role-a'], style['--cl-role-b']]) {
            expect(contrastRatio(stop, light.palette.deep)).toBeGreaterThanOrEqual(light.nameMinContrast - 0.05);
        }
    });

    it('two stops that collapse to the same readable colour render solid', () => {
        expect(roleNameStyle('#123456', '#123456', 'x', DARK_THEME).className).toBeUndefined();
    });
});

describe('roleSwatchBackground', () => {
    it('gradient, solid, or none', () => {
        expect(roleSwatchBackground({ color: 0x112233, secondary_color: 0x445566 })).toBe('linear-gradient(135deg, #112233, #445566)');
        expect(roleSwatchBackground({ color: 0x112233 })).toBe('#112233');
        expect(roleSwatchBackground({ color: -1, secondary_color: 0x445566 })).toBeNull();
    });
});

describe('role editor icon picker helpers', () => {
    it('file pre-check mirrors the API: image MIMEs only, <= 5 MB, not empty', () => {
        expect(roleIconFileError({ type: 'image/png', size: 1000 })).toBeNull();
        expect(roleIconFileError({ type: 'image/gif', size: 5 * 1024 * 1024 })).toBeNull();
        expect(roleIconFileError({ type: 'image/svg+xml', size: 1000 })).not.toBeNull();
        expect(roleIconFileError({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })).not.toBeNull();
        expect(roleIconFileError({ type: 'image/png', size: 0 })).not.toBeNull();
    });

    it('error messages: processor codes, throttle, hierarchy, server message, offline', () => {
        expect(roleIconErrorMessage({ response: { status: 400, data: { code: 'EMOJI_INVALID_IMAGE' } } })).toMatch(/isn't an image/);
        expect(roleIconErrorMessage({ response: { status: 400, data: { message: { code: 'EMOJI_TOO_LARGE' } } } })).toMatch(/too large/);
        expect(roleIconErrorMessage({ response: { status: 429 } })).toMatch(/Wait a few seconds/);
        expect(roleIconErrorMessage({ response: { status: 403 } })).toMatch(/below your highest role/);
        expect(roleIconErrorMessage({ response: { status: 400, data: { message: 'icon_emoji must be a single emoji' } } })).toBe('icon_emoji must be a single emoji');
        expect(roleIconErrorMessage(new Error('Network Error'))).toMatch(/connection/);
    });
});

describe('audit log: role icon + gradient edits read as sentences', () => {
    const entry = (before: object, after: object) => describeAuditEntry({
        id: 'e', action: 'role.update', actor_username: 'Alice', created_at: '2026-11-22T10:00:00.000Z',
        data_jsonb: { name: 'VIP', before, after },
    });
    it('icon set / image added / image changed / removed', () => {
        expect(entry({ icon: null }, { icon: '💎' }).details).toEqual(['Icon set to 💎']);
        expect(entry({ icon: null }, { icon: 'image:a1' }).details).toEqual(['Icon image added']);
        expect(entry({ icon: '💎' }, { icon: 'image:a1' }).details).toEqual(['Icon image changed']);
        expect(entry({ icon: 'image:a1' }, { icon: null }).details).toEqual(['Icon removed']);
    });
    it('gradient added / changed / removed', () => {
        expect(entry({ secondary_color: -1 }, { secondary_color: 255 }).details).toEqual(['Gradient added']);
        expect(entry({ secondary_color: 255 }, { secondary_color: 256 }).details).toEqual(['Gradient colour changed']);
        expect(entry({ secondary_color: 255 }, { secondary_color: -1 }).details).toEqual(['Gradient removed']);
    });
});
