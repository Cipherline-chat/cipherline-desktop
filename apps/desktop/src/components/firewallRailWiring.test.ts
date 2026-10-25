import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-level wiring for the Firewall game's two ways in (Home's Keys spam,
 * the rail Keys' right-click spam). The behaviour is covered in
 * rail/RailKeys.game.test.ts against the same hook; this pins that the real
 * Dashboard / HomePanel / RailKeys are wired the way that test assumes (the
 * class of bug where a module is tested in isolation but never connected).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('Firewall game wiring', () => {
    const dash = read('components/Dashboard.tsx');
    const home = read('components/HomePanel.tsx');
    const rail = read('components/rail/RailKeys.tsx');

    it('exactly ONE FirewallOverlay is mounted in the app, in Dashboard, with the userId key and the hook\'s close', () => {
        expect(count(dash, /<FirewallOverlay\b/g)).toBe(1);
        expect(dash).toMatch(/<FirewallOverlay key=\{userId\} userId=\{userId \|\| ''\} placement="shell" onClose=\{firewall\.closeGame\} \/>/);
        expect(count(home, /<FirewallOverlay\b/g)).toBe(0);
        expect(home).not.toMatch(/gameOpen|setGameOpen/);
    });

    it('Dashboard feeds the hook the SAME inCall expression it gives HomePanel (a call starting closes it)', () => {
        const expr = '!!activeCall || !!activeVoiceChannelId || !!activeHuddleCallId';
        expect(dash).toContain(`useFirewallGame(${expr})`);
        expect(dash).toContain(`inAnyCall={${expr}}`);
    });

    it('both paths go through the one hook: Home gets canPlay/openGame, the rail gets tryOpen via the refusal helper', () => {
        expect(dash).toMatch(/canPlayGame=\{firewall\.canPlay\}/);
        expect(dash).toMatch(/onPlayGame=\{firewall\.openGame\}/);
        expect(dash).toMatch(/railGameRefusal\(tryOpenFirewall\(\)\)/);
        expect(dash).toMatch(/<Mascot [^\n]*onGameSpam=\{handleRailGameSpam\} \/>/);
        expect(home).toMatch(/canPlay=\{canPlayGame\}/);
        expect(home).toMatch(/onPlay=\{onPlayGame\}/);
    });

    it('RailKeys swallows contextmenu and feeds the shared rule with the input timestamp; left click is still just onClick-first', () => {
        expect(rail).toMatch(/onContextMenu=\{handleContextMenu\}/);
        expect(rail).toMatch(/e\.preventDefault\(\)/);
        expect(rail).toMatch(/railGameClick\(gameStreakRef\.current, inputTime\(e\.timeStamp, performance\.now\(\)\)\)/);
        expect(rail).toMatch(/const handleClick = \(\) => \{\s*onClick\(\); \/\/ Home first, always\./);
    });

    it('the hook reuses keysBurst\'s verdict (no second set of rules)', () => {
        const hook = read('hooks/useFirewallGame.ts');
        expect(hook).toMatch(/homeGameVerdict\(inCall/);
        expect(hook).toMatch(/if \(inCall && open\) setOpen\(false\)/);
    });

    it('no easter-egg id is recorded on this path (the game-open path has none today: the egg ids belong to HomeKeys\' shows)', () => {
        for (const rel of ['utils/railKeysGame.ts', 'hooks/useFirewallGame.ts', 'components/FirewallOverlay.tsx']) {
            expect(read(rel)).not.toMatch(/recordEggFound\(/);
        }
    });
});
