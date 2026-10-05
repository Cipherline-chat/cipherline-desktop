import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * Last-resort error boundary wrapped around the ENTIRE renderer tree in
 * main.tsx. Before this existed, any uncaught render throw left the user
 * staring at a permanent white window with no way out — and with unsigned
 * builds and no crash-reporting backend, that failure was completely
 * invisible to us and unrecoverable for them (short of knowing to hit
 * Ctrl+R). This gives a branded "something broke" screen with a one-click
 * reload and copyable diagnostics they can paste into a bug report.
 *
 * DELIBERATELY self-contained: it imports nothing from the app's own
 * component tree, contexts, router, or design system — any of which could be
 * the thing that threw. Pure inline styles, no hooks, no external state. If
 * this component itself can't render, nothing can.
 */

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    info: ErrorInfo | null;
    copied: boolean;
}

const BG = '#0B0F1E';
const LUME = '#25E0C8';
const TEXT = '#E7ECF3';
const MUTED = '#8A93A6';
const SURFACE = '#141A2E';
const BORDER = '#26304A';

export class RootErrorBoundary extends Component<Props, State> {
    state: State = { error: null, info: null, copied: false };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        this.setState({ info });
        // Goes to the main-process log (and DevTools in dev). This is the only
        // breadcrumb we get without a crash-reporting backend, so make it loud.
        console.error('[RootErrorBoundary] Uncaught render error:', error, info.componentStack);
    }

    private details(): string {
        const { error, info } = this.state;
        return [
            `Cipherline crash report`,
            `error: ${error?.name}: ${error?.message}`,
            ``,
            `stack:`,
            error?.stack ?? '(no stack)',
            ``,
            `component stack:`,
            info?.componentStack ?? '(no component stack)',
        ].join('\n');
    }

    private copyDetails = () => {
        try {
            navigator.clipboard?.writeText(this.details());
            this.setState({ copied: true });
            setTimeout(() => this.setState({ copied: false }), 2000);
        } catch { /* clipboard may be unavailable — the <pre> is still selectable */ }
    };

    render() {
        if (!this.state.error) return this.props.children;

        return (
            <div style={{
                position: 'fixed', inset: 0, background: BG, color: TEXT,
                fontFamily: 'Nunito, system-ui, sans-serif',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', padding: '40px', textAlign: 'center',
                overflow: 'auto',
            }}>
                <div style={{ maxWidth: 520, width: '100%' }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>🔑</div>
                    <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 8px' }}>
                        Cipherline hit a snag
                    </h1>
                    <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: '0 0 24px' }}>
                        Something in the app crashed while rendering. Your messages and keys are
                        safe on disk — a reload usually fixes it. If it keeps happening, copy the
                        details below and send them to support.
                    </p>

                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 22 }}>
                        <button
                            onClick={() => window.location.reload()}
                            style={{
                                background: LUME, color: BG, border: 'none', borderRadius: 10,
                                padding: '11px 22px', fontSize: 14, fontWeight: 800, cursor: 'pointer',
                            }}
                        >
                            Reload Cipherline
                        </button>
                        <button
                            onClick={this.copyDetails}
                            style={{
                                background: 'transparent', color: TEXT, border: `1px solid ${BORDER}`,
                                borderRadius: 10, padding: '11px 22px', fontSize: 14, fontWeight: 700,
                                cursor: 'pointer',
                            }}
                        >
                            {this.state.copied ? 'Copied ✓' : 'Copy details'}
                        </button>
                    </div>

                    <pre style={{
                        textAlign: 'left', background: SURFACE, border: `1px solid ${BORDER}`,
                        borderRadius: 10, padding: '14px', fontSize: 11.5, lineHeight: 1.5,
                        color: MUTED, maxHeight: 220, overflow: 'auto', margin: 0,
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text',
                    }}>
                        {this.state.error.name}: {this.state.error.message}
                    </pre>
                </div>
            </div>
        );
    }
}

export default RootErrorBoundary;
