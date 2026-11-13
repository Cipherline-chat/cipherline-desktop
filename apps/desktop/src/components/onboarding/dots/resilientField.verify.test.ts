/* The WebGL -> Canvas 2D decision in resilientField.ts, with both engines faked:
   the WebGL field is verified (drew), found blank, lost, or throws a frame; a remembered
   fallback skips WebGL; every path reports exactly one outcome. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotFieldOptions } from './engine';
import type { RenderOutcome } from './renderVerify';

const h = vi.hoisted(() => ({
  glOpts: null as null | DotFieldOptions,
  glCreated: 0, glDestroyed: 0, twoCreated: 0,
  glThrows: false,
}));

function fake(renderer: 'webgl' | 'canvas2d') {
  return {
    N: 10, renderer, running: false,
    morph: () => Promise.resolve(), snap: () => {}, param: () => Promise.resolve(), get: () => 0,
    project: () => ({ x: 0, y: 0, depth: 1 }), bg: () => {}, pulse: () => {}, on: () => () => {},
    kick: () => {}, pause: () => {}, draw: () => {},
    destroy: () => { if (renderer === 'webgl') h.glDestroyed++; },
    stats: () => null, resetStats: () => {},
  };
}

vi.mock('./engine', () => ({
  PARAM_NAMES: ['offX'],
  createDotField: (_c: unknown, o: DotFieldOptions) => {
    if (h.glThrows) throw new Error('WebGL unavailable');
    h.glCreated++; h.glOpts = o; return fake('webgl');
  },
}));
vi.mock('./canvasEngine', () => ({
  createCanvasDotField: () => { h.twoCreated++; return fake('canvas2d'); },
}));

import { createResilientDotField } from './resilientField';

function canvas(): HTMLCanvasElement {
  const parent = { insertBefore: vi.fn() };
  return { parentNode: parent, style: { display: '' }, className: '', cloneNode: () => ({ removeAttribute: () => {}, remove: () => {}, className: '', style: {} }) } as unknown as HTMLCanvasElement;
}

beforeEach(() => { h.glOpts = null; h.glCreated = 0; h.glDestroyed = 0; h.twoCreated = 0; h.glThrows = false; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

function make(extra: Record<string, unknown> = {}) {
  const out: RenderOutcome[] = [];
  const f = createResilientDotField(canvas(), { onRender: (o) => out.push(o), ...extra });
  return { f, out };
}

describe('resilient field: verification and fallback decision', () => {
  it('drew: stays on WebGL and reports verified', () => {
    const { f, out } = make();
    expect(f?.renderer).toBe('webgl');
    h.glOpts!.verify!.onResult('drew');
    expect(f?.renderer).toBe('webgl');
    expect(out).toEqual([{ path: 'webgl', reason: 'verified' }]);
    expect(h.twoCreated).toBe(0);
  });
  it('drew nothing: WebGL is destroyed, 2D takes over, reports blank', () => {
    const { f, out } = make();
    h.glOpts!.verify!.onResult('blank');
    expect(f?.renderer).toBe('canvas2d');
    expect(h.glDestroyed).toBe(1);
    expect(out).toEqual([{ path: 'canvas2d', reason: 'blank' }]);
  });
  it('context lost: 2D takes over, reports lost', () => {
    const { f, out } = make();
    h.glOpts!.onContextLost!();
    expect(f?.renderer).toBe('canvas2d');
    expect(out).toEqual([{ path: 'canvas2d', reason: 'lost' }]);
  });
  it('a frame threw: 2D takes over, reports threw', () => {
    const { f, out } = make();
    h.glOpts!.onFrameError!(new Error('GL_INVALID_OPERATION'));
    expect(f?.renderer).toBe('canvas2d');
    expect(out).toEqual([{ path: 'canvas2d', reason: 'threw' }]);
  });
  it('unknown readback (unsupported) never falls back and reports nothing', () => {
    const { f, out } = make();
    h.glOpts!.verify!.onResult('unknown');
    expect(f?.renderer).toBe('webgl');
    expect(out).toEqual([]);
  });
  it('no WebGL at creation: 2D, reports no_webgl', () => {
    h.glThrows = true;
    const { f, out } = make();
    expect(f?.renderer).toBe('canvas2d');
    expect(out).toEqual([{ path: 'canvas2d', reason: 'no_webgl' }]);
  });
  it('a remembered fallback never even creates the WebGL field', () => {
    const { f, out } = make({ remembered: 'blank' });
    expect(f?.renderer).toBe('canvas2d');
    expect(h.glCreated).toBe(0);
    expect(out).toEqual([{ path: 'canvas2d', reason: 'remembered' }]);
  });
  it('negative control: no remembered value and a healthy engine creates WebGL', () => {
    make({ remembered: null });
    expect(h.glCreated).toBe(1);
  });
  it('a verdict after destroy() is ignored', () => {
    const { f, out } = make();
    f!.destroy();
    h.glOpts!.verify!.onResult('blank');
    expect(h.twoCreated).toBe(0);
    expect(out).toEqual([]);
  });
});
