import { describe, it, expect } from 'vitest';
import {
    Permissions,
    DEFAULT_EVERYONE_PERMISSIONS,
    ALL_PERMISSIONS,
    type PermissionKey,
} from '@cipherline/shared';
import {
    PERMISSION_GROUPS,
    SERVER_PERMISSIONS,
    TEXT_CHANNEL_PERMS,
    VOICE_CHANNEL_PERMS,
    countGroup,
    parsePermissions,
    permissionChipState,
    togglePermissionBit,
    channelPermissionRows,
    channelPermissionSections,
    channelPermissionMask,
} from './permissions';

/**
 * Regression cover for the role permissions editor.
 *
 * The bug these exist for: the editor refused to toggle any bit that @everyone
 * already granted, and rendered the role's own grant and @everyone's grant as
 * the same visual state. That killed every `DEFAULT_EVERYONE_PERMISSIONS` bit
 * (13 of the 28 chips) and made the remaining display unreadable.
 */

describe('togglePermissionBit', () => {
    it('sets a clear bit and clears a set bit', () => {
        expect(togglePermissionBit(0n, Permissions.KICK_MEMBERS)).toBe(Permissions.KICK_MEMBERS);
        expect(togglePermissionBit(Permissions.KICK_MEMBERS, Permissions.KICK_MEMBERS)).toBe(0n);
    });

    it('leaves every other bit untouched', () => {
        const before = Permissions.BAN_MEMBERS | Permissions.CONNECT | Permissions.ANNOTATE;
        const after = togglePermissionBit(before, Permissions.CONNECT);
        expect(after).toBe(Permissions.BAN_MEMBERS | Permissions.ANNOTATE);
        expect(togglePermissionBit(after, Permissions.CONNECT)).toBe(before);
    });

    // The precision guard. JS `|`, `&`, `~` and `<<` coerce to SIGNED 32-bit, so
    // a `number` implementation corrupts bit 31 and loses everything above it.
    // These must stay bigint forever; the assertions below fail loudly if the
    // signatures are ever widened.
    it.each([24, 25, 26, 27, 28, 29, 30, 31, 32, 40, 62])(
        'round-trips high bit %i without 32-bit truncation',
        (n) => {
            const bit = 1n << BigInt(n);
            const set = togglePermissionBit(0n, bit);
            expect(set).toBe(bit);
            expect(set > 0n).toBe(true);           // never negative — a signed-32 wrap would flip bit 31
            expect(togglePermissionBit(set, bit)).toBe(0n);
        },
    );

    it('positive control: the same arithmetic on `number` really does break at bit 31', () => {
        // Documents *why* the helpers are bigint. If this ever stops failing,
        // the language changed, not our code.
        const naive = (bits: number, bit: number) => (bits & bit) === bit ? bits & ~bit : bits | bit;
        expect(naive(0, 2 ** 31)).not.toBe(2 ** 31);   // becomes -2147483648
        expect(Number(togglePermissionBit(0n, 1n << 31n))).toBe(2 ** 31);
    });

    it('preserves the full ALL_PERMISSIONS mask through a toggle pair', () => {
        const off = togglePermissionBit(ALL_PERMISSIONS, Permissions.ANNOTATE);
        expect(off).toBe(ALL_PERMISSIONS & ~Permissions.ANNOTATE);
        expect(togglePermissionBit(off, Permissions.ANNOTATE)).toBe(ALL_PERMISSIONS);
    });
});

describe('permissionChipState', () => {
    const everyone = DEFAULT_EVERYONE_PERMISSIONS;

    it('reports a bit the role holds itself as own + effective', () => {
        const s = permissionChipState(Permissions.KICK_MEMBERS, everyone, Permissions.KICK_MEMBERS, false);
        expect(s).toEqual({ own: true, viaEveryone: false, effective: true });
    });

    it('reports a bit only @everyone holds as inherited, NOT as the role\'s own', () => {
        const s = permissionChipState(0n, everyone, Permissions.CONNECT, false);
        expect(s).toEqual({ own: false, viaEveryone: true, effective: true });
    });

    it('distinguishes "role grants it too" from "only @everyone grants it"', () => {
        // The exact conflation that made the editor unreadable: SEND_MESSAGES
        // held by the role AND by @everyone used to render identically to
        // CONNECT, which the role did not hold.
        const roleBits = Permissions.SEND_MESSAGES;
        const held = permissionChipState(roleBits, everyone, Permissions.SEND_MESSAGES, false);
        const notHeld = permissionChipState(roleBits, everyone, Permissions.CONNECT, false);
        expect(held.own).toBe(true);
        expect(notHeld.own).toBe(false);
        expect(held.viaEveryone).toBe(true);
        expect(notHeld.viaEveryone).toBe(true);
        expect(held).not.toEqual(notHeld);
    });

    it('reports nothing as inherited when editing @everyone itself', () => {
        const s = permissionChipState(everyone, everyone, Permissions.CONNECT, true);
        expect(s).toEqual({ own: true, viaEveryone: false, effective: true });
    });

    it('reports a bit nobody holds as fully off', () => {
        const s = permissionChipState(0n, everyone, Permissions.BAN_MEMBERS, false);
        expect(s).toEqual({ own: false, viaEveryone: false, effective: false });
    });
});

describe('every permission the editor shows is toggleable', () => {
    // THE regression. `toggle()` used to `return` early for any bit @everyone
    // granted, so all 13 DEFAULT_EVERYONE_PERMISSIONS chips were inert.
    const inheritedKeys = SERVER_PERMISSIONS.filter(
        p => (DEFAULT_EVERYONE_PERMISSIONS & p.bit) === p.bit,
    );

    it('covers a meaningful slice of the grid (guards against a vacuous pass)', () => {
        expect(inheritedKeys.length).toBeGreaterThanOrEqual(13);
    });

    it.each(SERVER_PERMISSIONS.map(p => [p.key, p.bit] as const))(
        '%s can be turned on and off on a role whose @everyone already grants the default set',
        (_key, bit) => {
            const start = 0n;
            const on = togglePermissionBit(start, bit);
            expect(permissionChipState(on, DEFAULT_EVERYONE_PERMISSIONS, bit, false).own).toBe(true);
            const off = togglePermissionBit(on, bit);
            expect(permissionChipState(off, DEFAULT_EVERYONE_PERMISSIONS, bit, false).own).toBe(false);
            expect(off).toBe(start);
        },
    );
});

describe('countGroup', () => {
    const everyone = DEFAULT_EVERYONE_PERMISSIONS;
    const text = PERMISSION_GROUPS.find(g => g.title === 'Text Channels')!;

    it('counts the role\'s own grants separately from @everyone-only ones', () => {
        const roleBits = Permissions.MANAGE_MESSAGES | Permissions.SEND_MESSAGES;
        const t = countGroup(text, roleBits, everyone, false);
        expect(t.total).toBe(text.permissions.length);
        expect(t.own).toBe(2);
        // Inherited-only = @everyone's text bits minus SEND_MESSAGES (counted as own).
        const inheritedInGroup = text.permissions.filter(p => (everyone & p.bit) === p.bit).length;
        expect(t.viaEveryoneOnly).toBe(inheritedInGroup - 1);
    });

    it('never reports inheritance for the @everyone role itself', () => {
        const t = countGroup(text, everyone, everyone, true);
        expect(t.viaEveryoneOnly).toBe(0);
    });
});

describe('parsePermissions', () => {
    it('round-trips a decimal wire string, including bits above 2^31', () => {
        const v = ALL_PERMISSIONS | (1n << 40n);
        expect(parsePermissions(v.toString(10))).toBe(v);
    });

    it.each([null, undefined, '', 'not-a-number', '12.5'])('falls back to 0n for %p', (s) => {
        expect(parsePermissions(s as string | null | undefined)).toBe(0n);
    });
});

describe('descriptor tables track the shared contract', () => {
    const all = [
        ...SERVER_PERMISSIONS,
        ...TEXT_CHANNEL_PERMS,
        ...VOICE_CHANNEL_PERMS,
    ];

    it.each(all.map(p => [p.key, p.bit] as const))(
        '%s uses the bit from @cipherline/shared',
        (key, bit) => {
            expect(bit).toBe(Permissions[key]);
        },
    );

    it('shows every shared permission exactly once in the role editor grid', () => {
        const shown = SERVER_PERMISSIONS.map(p => p.key).sort();
        const expected = (Object.keys(Permissions) as PermissionKey[]).sort();
        expect(shown).toEqual(expected);
    });

    it('has no duplicate bits within the role editor grid', () => {
        const bits = SERVER_PERMISSIONS.map(p => p.bit.toString());
        expect(new Set(bits).size).toBe(bits.length);
    });
});

describe('channel override editor tables are derived from PERMISSION_GROUPS', () => {
    it('shows every descriptor of a channel-tagged group in that kind’s editor (unless serverOnly)', () => {
        for (const kind of ['text', 'huddle'] as const) {
            const shown = new Set(channelPermissionRows(kind).map(r => r.key));
            for (const g of PERMISSION_GROUPS) {
                if (!g.channelKinds?.includes(kind)) continue;
                for (const p of g.permissions) expect(shown.has(p.key)).toBe(!p.serverOnly);
            }
        }
    });

    it('text: the nine per-channel text bits', () => {
        expect(channelPermissionRows('text').map(r => r.key).sort()).toEqual([
            'ADD_REACTIONS', 'ATTACH_FILES', 'EMBED_LINKS', 'MANAGE_MESSAGES',
            'MENTION_EVERYONE', 'READ_MESSAGE_HISTORY', 'SAVE_MESSAGES', 'SEND_MESSAGES', 'VIEW_CHANNEL',
        ]);
    });

    it('Calls: view + call bits + Manage Calls, including ANNOTATE; never the server-only DEAFEN/MOVE', () => {
        const rows = channelPermissionRows('huddle');
        const keys = rows.map(r => r.key);
        expect(keys).toEqual(expect.arrayContaining([
            'VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'VIDEO', 'SCREEN_SHARE', 'ANNOTATE', 'PRIORITY_SPEAKER', 'MANAGE_CHANNELS',
        ]));
        expect(keys).not.toContain('DEAFEN_MEMBERS');
        expect(keys).not.toContain('MOVE_MEMBERS');
        expect(keys).not.toContain('SEND_MESSAGES');
        expect(rows.find(r => r.key === 'MANAGE_CHANNELS')!.label).toBe('Manage Calls');
    });

    it('buckets rows into ordered sections and the mask covers exactly the rows', () => {
        const secs = channelPermissionSections('text');
        expect(secs.map(s => s.title)).toEqual(['Access', 'Messaging', 'Moderation']);
        expect(secs[0].permissions.map(p => p.key)).toEqual(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY']);
        const mask = channelPermissionMask('huddle');
        expect(mask).toBe(channelPermissionRows('huddle').reduce((m, r) => m | r.bit, 0n));
        expect(mask & Permissions.SEND_MESSAGES).toBe(0n);
    });
});
