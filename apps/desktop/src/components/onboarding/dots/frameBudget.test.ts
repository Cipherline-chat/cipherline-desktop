import { describe, expect, it } from 'vitest';
import { frameBudget } from './frameBudget';
import type { FrameBudgetInput } from './frameBudget';
import { clampTagX } from './placement';

const base: FrameBudgetInput = { busy: false, sinceActiveMs: 0, settleMs: 3500, hidden: false, paused: false };

describe('frameBudget', () => {
  it('runs at 60 while something moves', () => {
    expect(frameBudget({ ...base, busy: true })).toBe(60);
    expect(frameBudget({ ...base, busy: true, sinceActiveMs: 99999 })).toBe(60);
  });

  it('drops to 30 while only breathing inside the settle window', () => {
    expect(frameBudget({ ...base, sinceActiveMs: 0 })).toBe(30);
    expect(frameBudget({ ...base, sinceActiveMs: 3499 })).toBe(30);
  });

  it('stops once the settle window has elapsed (boundary is exclusive)', () => {
    expect(frameBudget({ ...base, sinceActiveMs: 3500 })).toBe('stop');
    expect(frameBudget({ ...base, sinceActiveMs: 60000 })).toBe('stop');
  });

  it('draws nothing while hidden, even when busy', () => {
    expect(frameBudget({ ...base, busy: true, hidden: true })).toBe('stop');
    expect(frameBudget({ ...base, hidden: true })).toBe('stop');
  });

  it('draws nothing while paused, even when busy', () => {
    expect(frameBudget({ ...base, busy: true, paused: true })).toBe('stop');
  });

  it('reduced motion never breathes: a frame only on change', () => {
    expect(frameBudget({ ...base, reducedMotion: true })).toBe('stop');
    expect(frameBudget({ ...base, reducedMotion: true, busy: true })).toBe(60);
  });

  it('settleMs of 0 means never breathe', () => {
    expect(frameBudget({ ...base, settleMs: 0 })).toBe('stop');
  });
});

describe('clampTagX', () => {
  it('passes through an x well inside the viewport', () => {
    expect(clampTagX(500, 60, 1440)).toBe(500);
  });
  it('keeps the label 8px from the left edge', () => {
    expect(clampTagX(-50, 60, 1440)).toBe(68);
  });
  it('keeps the label 10px from the right edge', () => {
    expect(clampTagX(5000, 60, 1440)).toBe(1440 - 60 - 10);
  });
});
