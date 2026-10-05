import { describe, it, expect } from 'vitest';
import {
    roleColorHexFromInt,
    getTopColoredRole,
    getHighestRoleColor,
    getTopRole,
    getTopHoistedRole,
    getHighestRolePosition,
    relativeLuminance,
    contrastRatio,
    readableRoleColorHex,
    CL_KIT_DEEP_BG_HEX,
    type RoleLite,
} from './roleColor';

describe('roleColorHexFromInt', () => {
    it('returns null for the -1 sentinel', () => {
        expect(roleColorHexFromInt(-1)).toBeNull();
    });

    it('converts a packed int to lowercase #rrggbb', () => {
        expect(roleColorHexFromInt(0x23cf65)).toBe('#23cf65');
    });

    it('masks off a leaked alpha byte and never emits a negative prefix', () => {
        expect(roleColorHexFromInt(0xff000000)).toBe('#000000');
        expect(roleColorHexFromInt(0)).toBe('#000000');
    });

    it('pads short hex values to 6 digits', () => {
        expect(roleColorHexFromInt(0x0f)).toBe('#00000f');
    });
});

const role = (over: Partial<RoleLite> & { role_id: string }): RoleLite => ({
    name: over.role_id,
    color: -1,
    position: 0,
    is_everyone: false,
    hoisted: false,
    ...over,
});

describe('role hierarchy lookups', () => {
    const roles: RoleLite[] = [
        role({ role_id: 'everyone', is_everyone: true, position: 0, color: 0x111111 }),
        role({ role_id: 'mod', position: 10, color: 0x00ff00, hoisted: true }),
        role({ role_id: 'vip', position: 20, color: -1, hoisted: false }),
        role({ role_id: 'admin', position: 30, color: 0xff0000, hoisted: true }),
    ];

    it('getTopColoredRole ignores @everyone and colourless roles, picks the highest position', () => {
        expect(getTopColoredRole(['everyone', 'mod', 'vip', 'admin'], roles)?.role_id).toBe('admin');
        expect(getTopColoredRole(['mod', 'vip'], roles)?.role_id).toBe('mod');
        expect(getTopColoredRole(['vip'], roles)).toBeNull();
    });

    it('getHighestRoleColor returns the hex of the top coloured role', () => {
        expect(getHighestRoleColor(['mod', 'admin'], roles)).toBe('#ff0000');
        expect(getHighestRoleColor(['vip'], roles)).toBeNull();
    });

    it('getTopRole ignores colour/hoisting, just picks highest position held', () => {
        expect(getTopRole(['mod', 'vip'], roles)?.role_id).toBe('vip');
    });

    it('getTopHoistedRole skips a non-hoisted top role in favour of a lower hoisted one', () => {
        expect(getTopHoistedRole(['mod', 'vip'], roles)?.role_id).toBe('mod');
        expect(getTopHoistedRole(['vip'], roles)).toBeNull();
    });

    it('getHighestRolePosition is -Infinity with no matching role', () => {
        expect(getHighestRolePosition([], roles)).toBe(-Infinity);
        expect(getHighestRolePosition(['admin'], roles)).toBe(30);
    });
});

describe('relativeLuminance / contrastRatio', () => {
    it('black is 0, white is 1', () => {
        expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    });

    it('contrast of a colour against itself is 1', () => {
        expect(contrastRatio('#23cf65', '#23cf65')).toBeCloseTo(1, 5);
    });

    it('black vs white is the maximum 21:1', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    });

    it('is symmetric in argument order', () => {
        expect(contrastRatio('#131a30', '#ff8800')).toBeCloseTo(contrastRatio('#ff8800', '#131a30'), 10);
    });
});

describe('readableRoleColorHex', () => {
    it('passes null through unchanged (no colour -> caller uses normal text colour)', () => {
        expect(readableRoleColorHex(null)).toBeNull();
    });

    it('leaves an already-readable colour byte-for-byte unchanged', () => {
        // #23cf65 (the app owner's screenshot colour) comfortably clears 4.5:1
        // against the dropdown background.
        expect(contrastRatio('#23cf65', CL_KIT_DEEP_BG_HEX)).toBeGreaterThanOrEqual(4.5);
        expect(readableRoleColorHex('#23cf65')).toBe('#23cf65');
    });

    it('lightens a near-black role colour until it clears the contrast floor', () => {
        const almostBlack = '#0a0a12';
        expect(contrastRatio(almostBlack, CL_KIT_DEEP_BG_HEX)).toBeLessThan(4.5);
        const fixed = readableRoleColorHex(almostBlack);
        expect(fixed).not.toBeNull();
        expect(contrastRatio(fixed as string, CL_KIT_DEEP_BG_HEX)).toBeGreaterThanOrEqual(4.5 - 0.01);
    });

    it('lightens pure black (0 saturation) without throwing and without changing hue oddly', () => {
        const fixed = readableRoleColorHex('#000000');
        expect(fixed).not.toBeNull();
        expect(contrastRatio(fixed as string, CL_KIT_DEEP_BG_HEX)).toBeGreaterThanOrEqual(4.5 - 0.01);
        // Pure black/grey stays grey (r === g === b) rather than acquiring a hue.
        const n = parseInt((fixed as string).slice(1), 16);
        const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
        expect(r).toBe(g);
        expect(g).toBe(b);
    });

    it('preserves hue/saturation while lightening a dark saturated colour', () => {
        const darkRed = '#3a0000'; // low luminance, fully saturated red
        const fixed = readableRoleColorHex(darkRed) as string;
        const n = parseInt(fixed.slice(1), 16);
        const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
        // Still reads as "red": R channel clearly dominant over G/B.
        expect(r).toBeGreaterThan(g);
        expect(r).toBeGreaterThan(b);
        expect(g).toBe(b);
    });

    it('respects a custom minRatio / background', () => {
        // A weak floor against a light background should leave more colours untouched.
        expect(readableRoleColorHex('#444444', 1, '#131a30')).toBe('#444444');
    });
});
