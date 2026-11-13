export { createDotField, tryCreateDotField, PARAM_NAMES } from './engine';
export type {
  DotRenderer, DotField, DotFieldOptions, DotFieldEvent, DotBackground, FrameListener, MorphOptions, ParamName, Projected, Shape, Vec3,
} from './engine';
export { frameBudget, BREATHING_GAP_MS } from './frameBudget';
export type { FrameBudget, FrameBudgetInput } from './frameBudget';
export * from './shapes';
export * from './scenes';
export { place, clampTagX } from './placement';
export { DotTagLayer } from './DotTagLayer';
export type { DotTag, DotTagLayerProps } from './DotTagLayer';
export { useDotField } from './useDotField';
export { createCanvasDotField } from './canvasEngine';
export type { CanvasDotField, CanvasDotFieldOptions, CanvasFrameStats, CanvasQuality } from './canvasEngine';
export { createResilientDotField } from './resilientField';
export type { ResilientDotField, ResilientFieldOptions } from './resilientField';
export { POINTER_REACTION, applyPointerReaction, effectiveFollow } from './pointerReaction';
