import React from 'react';
import { shallowArrayEqual } from '../utils/renderMemo';

/**
 * Contains a render error to ONE row of a list (a message row, a
 * conversation-list row) instead of letting it reach RootErrorBoundary and put
 * the whole app on the error screen.
 *
 * Rows render content chosen by another user. The content boundary
 * (utils/contentValidation.ts) refuses shapes a renderer would throw on, but a
 * renderer bug or a row stored by an older build must still cost that row only,
 * not every chat, on every launch.
 *
 * `resetKeys`: when any of them changes (shallow), a failed row tries again —
 * e.g. the message was edited or replaced by a placeholder.
 */
interface Props {
    children?: React.ReactNode;
    resetKeys?: readonly unknown[];
    /** What to draw instead of the row. Default: a quiet one-line note. */
    fallback?: React.ReactNode;
    /** For logs only. */
    label?: string;
}

interface State {
    failed: boolean;
}

export class RowErrorBoundary extends React.Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: unknown): void {
        // Name only: the message (and the row) may carry user content.
        const name = error instanceof Error ? error.name : typeof error;
        console.error(`[RowErrorBoundary] a ${this.props.label ?? 'row'} failed to render (${name})`);
    }

    componentDidUpdate(prev: Props): void {
        if (this.state.failed && !shallowArrayEqual(prev.resetKeys ?? [], this.props.resetKeys ?? [])) {
            this.setState({ failed: false });
        }
    }

    render(): React.ReactNode {
        if (!this.state.failed) return this.props.children;
        if (this.props.fallback !== undefined) return this.props.fallback;
        return (
            <div role="note" data-row-error="" className="px-4 py-1 text-[11px] italic text-cl-faint select-none">
                This item couldn’t be shown
            </div>
        );
    }
}

export default RowErrorBoundary;
