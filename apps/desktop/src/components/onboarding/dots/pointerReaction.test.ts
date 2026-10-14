import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POINTER_REACTION, applyPointerReaction, effectiveFollow } from './pointerReaction';

const STEPS = resolve(__dirname, '..', 'steps');
const read = (f: string): string => readFileSync(resolve(STEPS, f), 'utf8');

/** A field that records param() calls and fails on anything else (no morph / snap / kick). */
function recordingField() {
  const calls: Array<[string, number, number | undefined]> = [];
  const field = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'param') return (n: string, v: number, ms?: number) => { calls.push([n, v, ms]); return Promise.resolve(); };
      return () => { throw new Error(`pointer reaction must only call param(), not ${String(prop)}()`); };
    },
  });
  return { calls, field: field as unknown as Parameters<typeof applyPointerReaction>[0] };
}

describe('POINTER_REACTION', () => {
  it('is the invite step\'s feel: a real tilt and a gentler repel', () => {
    expect(POINTER_REACTION.follow).toBe(0.6);
    expect(POINTER_REACTION.repel).toBe(0.5);
  });
});

describe('applyPointerReaction', () => {
  it('sets follow and repel (and nothing else) with a tween', () => {
    const { calls, field } = recordingField();
    applyPointerReaction(field, 600);
    expect(calls).toEqual([['follow', 0.6, 600], ['repel', 0.5, 600]]);
  });

  it('never morphs, snaps or kicks the scene (Proxy throws on any other method)', () => {
    const { field } = recordingField();
    expect(() => applyPointerReaction(field)).not.toThrow();
  });

  it('negative control: the recording field really does throw on a morph', () => {
    const { field } = recordingField();
    expect(() => (field as unknown as { morph: () => void }).morph()).toThrow(/only call param/);
  });
});

describe('effectiveFollow (reduced motion)', () => {
  it('passes the step\'s follow through normally', () => {
    expect(effectiveFollow(POINTER_REACTION.follow, false)).toBe(0.6);
  });
  it('is 0 under reduced motion whatever the step asked for', () => {
    expect(effectiveFollow(POINTER_REACTION.follow, true)).toBe(0);
    expect(effectiveFollow(1, true)).toBe(0);
  });
});

/* Which steps enable the reaction is a property of the step's source: both
   must route through the shared helper, and neither may switch it off again. */
const ZEROS_IT = /\[\s*'(follow|repel)'\s*,\s*0\s*\]|param\(\s*'(follow|repel)'\s*,\s*0\b/;

describe('steps enable the pointer reaction', () => {
  for (const file of ['InviteStep.tsx', 'PrivacyStep.tsx']) {
    it(`${file} calls applyPointerReaction`, () => {
      expect(read(file)).toMatch(/applyPointerReaction\(\s*(F|dots)\s*,/);
    });
    it(`${file} does not zero follow/repel`, () => {
      expect(read(file)).not.toMatch(ZEROS_IT);
    });
  }

  it('negative control: the zero-detector catches the old privacy wiring', () => {
    const old = "for (const [name, v] of [['follow', 0], ['repel', 0], ['bright', 1.25]] as const) { void dots.param(name, v, 600); }";
    expect(old).toMatch(ZEROS_IT);
    expect("void F.param('follow', 0, 600);").toMatch(ZEROS_IT);
    expect("applyPointerReaction(F, 600);").not.toMatch(ZEROS_IT);
  });

  it('the privacy step keeps its toggle-only SCENE changes: morph only inside flip()', () => {
    const src = read('PrivacyStep.tsx');
    const morphs = src.match(/dots\.morph\(/g) ?? [];
    // one in flip() (a toggle press), one in the entrance effect (runs on [dots, reducedMotion] only)
    expect(morphs.length).toBe(2);
    expect(src).toMatch(/const flip = \(k: SatKey, v: boolean\) => \{[\s\S]*?dots\.morph\(privacyScene/);
    // the entrance effect depends on the field and reduced motion only: no pointer / hover / toggle state
    expect(src).toMatch(/\}, \[dots, reducedMotion\]\);/);
  });
});
