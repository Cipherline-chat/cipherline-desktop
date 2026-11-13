import { describe, expect, it } from 'vitest';
import {
  CANVAS_POINT_LEVELS, QUALITY_MAX_COST_MS, QUALITY_MAX_LATENESS, QUALITY_STRIKES, QUALITY_WINDOW,
  createQualityTracker, judgeWindow, strideFor,
} from './canvasQuality';

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

describe('strideFor', () => {
  it('draws at most maxPoints', () => {
    for (const max of CANVAS_POINT_LEVELS) {
      const s = strideFor(7000, max);
      expect(Math.ceil(7000 / s)).toBeLessThanOrEqual(max);
      if (s > 1) expect(Math.ceil(7000 / (s - 1))).toBeGreaterThan(max);   /* and no coarser than needed */
    }
  });
  it('is 1 when everything fits, and never below 1', () => {
    expect(strideFor(800, 2400)).toBe(1);
    expect(strideFor(0, 2400)).toBe(1);
    expect(strideFor(7000, 0)).toBe(1);
  });
});

describe('judgeWindow', () => {
  it('never judges a partial window', () => {
    expect(judgeWindow(fill(QUALITY_WINDOW - 1, 99), fill(QUALITY_WINDOW - 1, 9))).toBe('keep');
  });
  it('cost: at the limit keeps, just over steps down', () => {
    expect(judgeWindow(fill(QUALITY_WINDOW, QUALITY_MAX_COST_MS), [])).toBe('keep');
    expect(judgeWindow(fill(QUALITY_WINDOW, QUALITY_MAX_COST_MS + 0.01), [])).toBe('down');
  });
  it('lateness: at the limit keeps, just over steps down', () => {
    expect(judgeWindow(fill(QUALITY_WINDOW, 2), fill(QUALITY_WINDOW, QUALITY_MAX_LATENESS))).toBe('keep');
    expect(judgeWindow(fill(QUALITY_WINDOW, 2), fill(QUALITY_WINDOW, QUALITY_MAX_LATENESS + 0.01))).toBe('down');
  });
  it('is a median: a few slow frames (a step transition, a GC) do not step down', () => {
    const cost = [...fill(QUALITY_WINDOW - 5, 3), ...fill(5, 80)];
    const late = [...fill(QUALITY_WINDOW - 5, 1), ...fill(5, 6)];
    expect(judgeWindow(cost, late)).toBe('keep');
  });
  it('lateness needs enough back-to-back samples to count', () => {
    expect(judgeWindow(fill(QUALITY_WINDOW, 2), fill(QUALITY_WINDOW / 2 - 1, 9))).toBe('keep');
    expect(judgeWindow(fill(QUALITY_WINDOW, 2), fill(QUALITY_WINDOW / 2, 9))).toBe('down');
  });
});

describe('createQualityTracker', () => {
  it('steps down only after QUALITY_STRIKES bad windows in a row, then starts over', () => {
    const t = createQualityTracker();
    const verdicts: string[] = [];
    for (let i = 0; i < QUALITY_WINDOW * QUALITY_STRIKES; i++) verdicts.push(t.push(50, 3));
    expect(verdicts.filter((v) => v === 'down')).toHaveLength(1);
    expect(verdicts[verdicts.length - 1]).toBe('down');
    for (let i = 0; i < QUALITY_WINDOW * QUALITY_STRIKES; i++) expect(t.push(1, 1)).toBe('keep');
  });
  it('a single bad window (an entrance burst) never steps down', () => {
    const t = createQualityTracker();
    for (let i = 0; i < QUALITY_WINDOW; i++) expect(t.push(50, 3)).toBe('keep');
    for (let i = 0; i < QUALITY_WINDOW; i++) expect(t.push(1, 1)).toBe('keep');
    for (let i = 0; i < QUALITY_WINDOW; i++) expect(t.push(50, 3)).toBe('keep');
  });
  it('reset() discards a partial window and the strikes so far', () => {
    const t = createQualityTracker();
    for (let i = 0; i < QUALITY_WINDOW * QUALITY_STRIKES - 1; i++) t.push(50, 3);
    t.reset();
    expect(t.push(50, 3)).toBe('keep');
  });
});
