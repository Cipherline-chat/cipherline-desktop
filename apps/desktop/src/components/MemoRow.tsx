import React from 'react';
import { shallowArrayEqual } from '../utils/renderMemo';

/**
 * Renders `render()` and then skips re-rendering for as long as `deps` stay
 * shallow-equal — `React.memo` keyed on an explicit dependency list instead
 * of on props, so a row's JSX can stay inline where it is written.
 *
 * The contract the caller must keep (ChatPane's message rows do):
 *   - `deps` lists EVERYTHING the render reads that can change: the message
 *     object, the row's derived flags, and the pane-wide inputs. A value
 *     missing from `deps` would show stale on screen.
 *   - Event handlers inside the output never call a per-render closure that
 *     reads state outside `deps`. On a skipped render the previous output is
 *     kept, handlers included, so such calls go through stable stand-ins
 *     (hooks/useLiveCallbacks) that reach the latest committed render.
 */
interface MemoRowProps {
    deps: readonly unknown[];
    render: () => React.ReactNode;
}

const MemoRowImpl: React.FC<MemoRowProps> = ({ render }) => <>{render()}</>;

export const MemoRow = React.memo(
    MemoRowImpl,
    (prev, next) => shallowArrayEqual(prev.deps, next.deps),
);
MemoRow.displayName = 'MemoRow';
