import React, { createContext, useCallback, useContext, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import { ClButton } from '../components/cl';

export type ToastKind = 'error' | 'warning' | 'info' | 'success';

export interface ToastInput {
    kind?: ToastKind;
    title?: string;
    message: string;
    /** Override the 4.5s default. Set to 0 to disable auto-dismiss. */
    durationMs?: number;
}

interface Toast extends Required<Pick<ToastInput, 'message'>> {
    id: string;
    kind: ToastKind;
    title?: string;
}

interface ToastContextValue {
    push: (t: ToastInput) => void;
    dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Safe no-op hook when used outside the provider (lets a component render without
 *  forcing every test to wrap itself). */
export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    return ctx ?? { push: () => {}, dismiss: () => {} };
}

const KIND_STYLES: Record<ToastKind, { ring: string; bar: string; icon: React.JSX.Element }> = {
    error:   { ring: 'ring-cl-flash/30',   bar: 'bg-cl-flash',   icon: <AlertCircle   size={18} className="text-cl-flash" /> },
    warning: { ring: 'ring-cl-glow/30',    bar: 'bg-cl-glow',    icon: <AlertTriangle size={18} className="text-cl-glow" /> },
    info:    { ring: 'ring-cl-lume/30',    bar: 'bg-cl-lume',    icon: <Info          size={18} className="text-cl-lume" /> },
    success: { ring: 'ring-cl-ok/30',      bar: 'bg-cl-ok',      icon: <CheckCircle   size={18} className="text-cl-ok" /> },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [closing, setClosing] = useState<Set<string>>(new Set());

    const dismiss = useCallback((id: string) => {
        setClosing(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
        });
        // Wait for the exit animation before unmounting.
        window.setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
            setClosing(prev => { const next = new Set(prev); next.delete(id); return next; });
        }, 180);
    }, []);

    const push = useCallback((input: ToastInput) => {
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
            ? (crypto as any).randomUUID()
            : `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toast: Toast = {
            id,
            kind: input.kind ?? 'info',
            title: input.title,
            message: input.message,
        };
        setToasts(prev => [...prev, toast]);
        const dur = input.durationMs ?? 4500;
        if (dur > 0) window.setTimeout(() => dismiss(id), dur);
    }, [dismiss]);

    return (
        <ToastContext.Provider value={{ push, dismiss }}>
            {children}
            {/* Stack — fixed to the bottom-right, above every modal z-index.
                Individual toasts own their pointer events so nothing steals clicks
                from the rest of the UI. */}
            <div className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 pointer-events-none max-w-sm">
                {toasts.map(t => {
                    const style = KIND_STYLES[t.kind];
                    const isClosing = closing.has(t.id);
                    return (
                        <div
                            key={t.id}
                            className={`pointer-events-auto relative flex items-start gap-3 pl-4 pr-3 py-3 bg-cl-deep border border-white/[0.08] ring-1 ${style.ring} rounded-xl shadow-2xl overflow-hidden ${isClosing ? 'fade-rise-exit' : 'fade-rise-enter'}`}
                        >
                            {/* Accent stripe on the left */}
                            <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${style.bar}`} />
                            <span className="shrink-0 mt-0.5">{style.icon}</span>
                            <div className="flex-1 min-w-0">
                                {t.title && (
                                    <p className="text-[13px] font-semibold text-white leading-tight m-0">{t.title}</p>
                                )}
                                <p className={`text-[12px] text-cl-muted leading-snug m-0 ${t.title ? 'mt-0.5' : ''} whitespace-pre-wrap break-words`}>
                                    {t.message}
                                </p>
                            </div>
                            <ClButton
                                icon
                                size="sm"
                                variant="ghost"
                                onClick={() => dismiss(t.id)}
                                tooltip="Dismiss"
                            >
                                <X size={14} />
                            </ClButton>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
};
