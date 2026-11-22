import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    consoleGeometry, consoleWidthForPanel, LEAVE_LABEL_FROM_PX, MIN_CONTROL_PX, NARROW_TIER_BELOW_PX,
} from './callConsoleFit';

const SRC = resolve(__dirname, '..');
const css = readFileSync(resolve(SRC, 'index.css'), 'utf8');
const dashboard = readFileSync(resolve(SRC, 'components/Dashboard.tsx'), 'utf8');
const rightPanelMin = Number(/const RIGHT_PANEL_MIN_PX = (\d+);/.exec(dashboard)?.[1]);

/** The pre-fix console: the base formula at every width (no narrow tier). */
function baseOnlyRowWidth(w: number, live: boolean) {
    const cqi = w / 100;
    const cs = Math.min(46, Math.max(31, (84 * cqi - 8) / (live ? 6.56 : 6)));
    const cg = Math.min(7, Math.max(3, 1.2 * cqi));
    const cp = Math.min(8, Math.max(4, 1.4 * cqi));
    const seps = (1 + 1.5 * cg) + (1 + 2.8 * cg);
    return 2 * cp + 7 * cg + seps + 5 * cs + (live ? 2.56 * cs + 1 : cs);
}

describe('call console fits the docked panel at every width', () => {
    it('reads the right panel floor from Dashboard', () => {
        expect(rightPanelMin).toBeGreaterThan(0);
    });

    for (const live of [false, true]) {
        it(`every control fits, >= ${MIN_CONTROL_PX}px, from the panel floor up (${live ? 'share live' : 'no share'})`, () => {
            const bad: string[] = [];
            for (let w = consoleWidthForPanel(rightPanelMin); w < LEAVE_LABEL_FROM_PX; w += 0.25) {
                const g = consoleGeometry(w, live);
                if (g.rowWidth > w + 0.01) bad.push(`${w}: row ${g.rowWidth.toFixed(2)} > ${w}`);
                if (g.cs < MIN_CONTROL_PX) bad.push(`${w}: control ${g.cs.toFixed(2)} < ${MIN_CONTROL_PX}`);
            }
            expect(bad).toEqual([]);
        });

        it(`controls never grow as the console narrows across the tier switch (${live ? 'share live' : 'no share'})`, () => {
            const justBelow = consoleGeometry(NARROW_TIER_BELOW_PX - 0.02, live);
            const at = consoleGeometry(NARROW_TIER_BELOW_PX, live);
            expect(justBelow.tier).toBe('narrow');
            expect(at.tier).toBe('base');
            expect(justBelow.cs).toBeLessThanOrEqual(at.cs + 0.01);
        });
    }

    it('positive control: the pre-fix base-only formula overflows at the 240px panel floor', () => {
        const w = consoleWidthForPanel(rightPanelMin);
        expect(baseOnlyRowWidth(w, false)).toBeGreaterThan(w);
        expect(baseOnlyRowWidth(w, true)).toBeGreaterThan(w);
    });

    it('index.css carries the narrow tier this model mirrors', () => {
        const tier = css.slice(css.indexOf('@container (max-width: 251.98px)'));
        expect(tier.length).toBeGreaterThan(0);
        const block = tier.slice(0, tier.indexOf('\n}\n'));
        expect(block).toContain('--cg: 3px;');
        expect(block).toContain('--cp: 3px;');
        expect(block).toContain(`clamp(${MIN_CONTROL_PX}px, min(calc((100cqi - 29px) / 6), max(31px, calc((84cqi - 8px) / 6))), 46px)`);
        expect(block).toContain(`clamp(${MIN_CONTROL_PX}px, min(calc((100cqi - 30px) / 6.56), max(31px, calc((84cqi - 8px) / 6.56))), 46px)`);
        expect(block).toMatch(/\.cl-console-sep--leave \{ margin: 0; \}/);
        expect(NARROW_TIER_BELOW_PX - 0.02).toBe(251.98);
    });
});
