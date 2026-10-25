/**
 * Source scan: every way the Calls-channel panel can START a call is gated on
 * START_CALLS (`canStartCalls` / `hCanStart`), and joining a running call is
 * NOT. Source-scanned for the same reason as ServerContextPanel.callCooldown
 * .test.ts — there is no mount harness for this 2k-line panel, and each check
 * is a "which boolean gates this" question. The gate's own semantics are
 * unit-tested in utils/startCallsGate.test.ts and the button's rendering in
 * HuddleButton.startCalls.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ServerContextPanel.tsx'), 'utf8');
const dashboard = readFileSync(join(here, '..', 'Dashboard.tsx'), 'utf8');

const between = (text: string, from: string, to: string) => {
    const a = text.indexOf(from);
    const b = text.indexOf(to, a + 1);
    return { a, b, block: a >= 0 && b > a ? text.slice(a, b) : '' };
};

describe('ServerContextPanel — START_CALLS gates', () => {
    it('canStartCalls reads the live channel row (can_start_call), not a stale copy', () => {
        expect(src).toMatch(/const canStartCalls = useCallback\(\s*\(channelId: string\): boolean => canStartCallsIn\(allChannels\.find\(c => c\.channel_id === channelId\)\)/);
    });

    const huddle = between(src, 'const renderHuddle = (h: ChannelInfo) => {', "icon: <LinkIcon />, label: 'Copy Channel ID',");

    it('meta: found renderHuddle', () => {
        expect(huddle.a).toBeGreaterThan(0);
        expect(huddle.b).toBeGreaterThan(huddle.a);
    });

    it('the "+", the row and the "Start a new call" menu item all need hCanStart', () => {
        expect(huddle.block).toContain('const hCanStart = canStartCalls(h.channel_id);');
        expect(huddle.block).toMatch(/const canStartNewCall = callCooldownSecs === 0 && hCanJoin && hCanStart && !hAtCallLimit;/);
        expect(huddle.block).toContain('canStart={hCanStart}');
        expect(huddle.block).toContain('onSpawn={() => { if (canStartNewCall) onSpawnHuddleCall?.(h); }}');
    });

    it('join-only members see the menu item DISABLED rather than missing', () => {
        expect(huddle.block).toMatch(/\.\.\.\(!canStartNewCall && hJoinOnly \? \[\{[\s\S]*?disabled: true/);
    });

    it('joining stays on CONNECT alone: canConnect is not narrowed by START_CALLS', () => {
        expect(huddle.block).toContain('canConnect={callCooldownSecs === 0 && hCanJoin}');
        expect(huddle.block).not.toMatch(/canConnect=\{[^}]*hCanStart/);
    });

    it('drop target for "move onto an empty Calls channel" (which spawns) needs hCanStart', () => {
        expect(huddle.block).toContain('eligible={!!movingParticipant && calls.length === 0 && hCanStart}');
    });

    it('drag-end: self-drag onto an empty channel and a moderator move onto one both check canStartCalls', () => {
        const drag = between(src, 'function onHuddleDragEnd(', 'setHuddleActiveId(null);').block;
        expect(drag).toContain('if (hd && canStartCalls(hd.channel_id)) onSpawnHuddleCall?.(hd);');
        expect(drag).toContain("if (dest.kind === 'huddle' && !canStartCalls(dest.huddleId)) return;");
    });

    it('the "Move to ▸ New call in …" submenu entries need canStartCalls; existing-call entries do not', () => {
        // The destination rule lives in utils/callMoveDestinations.ts (behaviour
        // covered by its own test); the menu must hand it BOTH viewer gates.
        const menu = between(src, 'const buildMoveToSubmenu = React.useCallback(', 'const buildCallParticipantMenu').block;
        expect(menu).toContain('listMoveDestinations({');
        expect(menu).toMatch(/canConnect,\s*canStartCalls,/);
        const dests = readFileSync(join(here, '..', '..', 'utils', 'callMoveDestinations.ts'), 'utf8');
        expect(dests).toContain('if (!input.canConnect(h.channel_id) || !input.canStartCalls(h.channel_id)) continue;');
        // The existing-call loop: CONNECT only.
        expect(dests).toMatch(/if \(!input\.canConnect\(c\.huddle_id\)\) continue;/);
    });
});

describe('Dashboard.handleSpawnHuddleCall — refuses locally BEFORE tearing down the current call', () => {
    const fn = between(dashboard, 'const handleSpawnHuddleCall = useCallback(', '/** Join an *existing* call under a Huddle');

    it('meta: found the handler', () => {
        expect(fn.a).toBeGreaterThan(0);
        expect(fn.b).toBeGreaterThan(fn.a);
    });

    it('checks canStartCallsIn(huddle) ahead of doSpawn (which leaves the old voice channel / call first)', () => {
        const check = fn.block.indexOf('if (!canStartCallsIn(huddle)) {');
        const spawn = fn.block.indexOf('const doSpawn = async () => {');
        const leave = fn.block.indexOf('leave_voice');
        expect(check).toBeGreaterThan(0);
        expect(check).toBeLessThan(spawn);
        expect(spawn).toBeLessThan(leave);
    });
});
