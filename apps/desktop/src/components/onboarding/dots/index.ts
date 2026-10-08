export { createDotField, tryCreateDotField } from './engine';
export type {
  DotField, DotFieldOptions, DotFieldEvent, DotBackground, FrameListener, MorphOptions, ParamName, Projected, Shape, Vec3,
} from './engine';
export { frameBudget, BREATHING_GAP_MS } from './frameBudget';
export type { FrameBudget, FrameBudgetInput } from './frameBudget';
export * from './shapes';
export * from './scenes';
export { place, clampTagX } from './placement';
export { DotTagLayer } from './DotTagLayer';
export type { DotTag, DotTagLayerProps } from './DotTagLayer';
export { useDotField } from './useDotField';
