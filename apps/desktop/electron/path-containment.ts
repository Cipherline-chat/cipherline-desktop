/**
 * The ONE path-containment check for the Electron main process.
 *
 * WHY THIS EXISTS: `target.startsWith(base)` is not a containment check. With
 * no trailing separator `/app/dist-evil/x` "starts with" `/app/dist`, so a
 * sibling directory whose name merely begins with the base name passes. The
 * variants that did append `path.sep` were correct, but ad-hoc: one more copy
 * (the custom-sound delete) forgot it. Every containment decision now goes
 * through here so there is exactly one rule to get right (and to test).
 *
 * The rule: resolve both sides to absolute normalised paths, take
 * `path.relative(base, target)`, and reject when the result climbs out (`..`
 * prefix) or is itself absolute (different Windows drive / UNC root). It does
 * NOT touch the filesystem, so symlinks are the caller's concern (see
 * `resolveReal` in main.ts, which realpaths before calling this).
 *
 * Deliberately free of any `electron` import so it is unit-testable.
 */
import * as nodePath from 'path';

export interface PathInsideOptions {
  /**
   * Whether `target === base` counts as inside. Default false: "is this strictly
   * a child of the directory". Pass true where the directory itself is an
   * acceptable answer (a static server asked for `/`, a picked-folder root).
   */
  allowEqual?: boolean;
  /** Path implementation to use; only tests override this (e.g. `path.win32`). */
  pathApi?: Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute'>;
}

export function isPathInside(base: string, target: string, opts: PathInsideOptions = {}): boolean {
  const p = opts.pathApi ?? nodePath;
  const resolvedBase = p.resolve(base);
  const resolvedTarget = p.resolve(target);
  const rel = p.relative(resolvedBase, resolvedTarget);
  if (rel === '') return opts.allowEqual === true;
  // A leading '..' means the target is outside (or a sibling). This also rejects
  // a child literally named '..foo'; no path this app serves or writes looks
  // like that, and over-rejecting is the safe direction.
  if (rel.startsWith('..')) return false;
  // Different drive / UNC root: path.relative returns the absolute target.
  if (p.isAbsolute(rel)) return false;
  return true;
}
