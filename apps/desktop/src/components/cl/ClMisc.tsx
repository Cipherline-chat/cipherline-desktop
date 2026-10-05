import React from 'react';

/* ── Pill / badge (guide `.pill`) ── */
interface ClPillProps {
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}
export const ClPill: React.FC<ClPillProps> = ({ children, className, style }) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <span className={['pill', className ?? ''].filter(Boolean).join(' ')} style={style}>{children}</span>
    </span>
);

/* ── Role chip (guide `.rolet`, variants gold/coral) ── */
interface ClRoleProps {
    children: React.ReactNode;
    variant?: 'lume' | 'gold' | 'coral';
    className?: string;
    style?: React.CSSProperties;
}
export const ClRole: React.FC<ClRoleProps> = ({ children, variant = 'lume', className, style }) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <span
            className={['rolet', variant === 'gold' ? 'gold' : '', variant === 'coral' ? 'coral' : '', className ?? ''].filter(Boolean).join(' ')}
            style={style}
        >
            {children}
        </span>
    </span>
);

/* ── Progress bar (guide `.prog` > `.pf`) ── */
interface ClProgressProps {
    /** 0–100 */
    value: number;
    done?: boolean;
    className?: string;
    style?: React.CSSProperties;
}
export const ClProgress: React.FC<ClProgressProps> = ({ value, done, className, style }) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <div className={['prog', done ? 'done' : '', className ?? ''].filter(Boolean).join(' ')} style={style}>
            <div className="pf" style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
        </div>
    </span>
);

/* ── Skeleton shimmer (guide `.sk`, modifiers avt/ln) ── */
interface ClSkeletonProps {
    variant?: 'avt' | 'ln';
    className?: string;
    style?: React.CSSProperties;
}
export const ClSkeleton: React.FC<ClSkeletonProps> = ({ variant, className, style }) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <div className={['sk', variant ?? '', className ?? ''].filter(Boolean).join(' ')} style={style} />
    </span>
);

/* ── Avatar with presence dot (guide `.avx` + `.dot`) ── */
type ClStatus = 'onl' | 'idle' | 'dnd' | 'off';
interface ClAvatarProps {
    children: React.ReactNode;
    /** Background — solid color or gradient string. */
    background?: string;
    /** Presence: online / idle / do-not-disturb / offline. */
    status?: 'online' | 'idle' | 'dnd' | 'off';
    color?: string;
    size?: number;
    className?: string;
    style?: React.CSSProperties;
}
const STATUS_CLASS: Record<string, ClStatus> = { online: 'onl', idle: 'idle', dnd: 'dnd', off: 'off' };
export const ClAvatar: React.FC<ClAvatarProps> = ({
    children, background, status, color, size, className, style,
}) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <span
            className={['avx', className ?? ''].filter(Boolean).join(' ')}
            style={{
                ...(background ? { background } : null),
                ...(color ? { color } : null),
                ...(size ? { width: size, height: size } : null),
                ...style,
            }}
        >
            {children}
            {status && <span className={`dot ${STATUS_CLASS[status]}`} />}
        </span>
    </span>
);
