/**
 * Source scan for audit-fixes item 5b: the Calls-channel right-click menu's
 * "Start a new call" item used to gate only on `hCanJoin && !hAtCallLimit`,
 * skipping the `callCooldownSecs === 0` check the "+" button applies via its
 * `canConnect` prop — so right-clicking during an active cooldown could
 * still offer (and spawn) a new call the "+" button was disabled for.
 *
 * Source-scanned rather than mounted for the same reason as the ChatPane
 * scans (dmInbound.test.ts, channelHistoryMerge.test.ts,
 * ChatPane.saveButtonWording.test.ts): no component-test harness for this
 * file, and the fix is a pure "which boolean gates this menu item" question
 * that a real render wouldn't answer any more reliably than the source does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ServerContextPanel.tsx'), 'utf8');

describe('renderHuddle — "Start a new call" respects the call cooldown', () => {
    const start = src.indexOf('const renderHuddle = (h: ChannelInfo) => {');
    const end = src.indexOf("icon: <LinkIcon />, label: 'Copy Channel ID',", start);
    const block = src.slice(start, end);

    it('meta: found renderHuddle', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('derives one canStartNewCall that folds in the cooldown, same as the "+" button\'s canConnect prop', () => {
        expect(block).toMatch(/const canStartNewCall = callCooldownSecs === 0 && hCanJoin && !hAtCallLimit;/);
    });

    it('the "+" button (onSpawn) and the context-menu item both gate on canStartNewCall', () => {
        expect(block).toContain('onSpawn={() => { if (canStartNewCall) onSpawnHuddleCall?.(h); }}');
        expect(block).toContain('...(canStartNewCall ? [{');
        expect(block).toContain("icon: <Radio />, label: 'Start a new call',");
        // Neither the button nor the menu item may go back to gating on the
        // old, cooldown-blind expression.
        expect(block).not.toContain('hCanJoin && !hAtCallLimit ?');
        expect(block).not.toMatch(/onSpawn=\{\(\) => \{ if \(hCanJoin && !hAtCallLimit\)/);
    });
});
