import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ClSegmentOption<T extends string> {
    value: T;
    label: React.ReactNode;
}

interface ClSegmentProps<T extends string> {
    options: ClSegmentOption<T>[];
    value: T;
    onChange: (v: T) => void;
    className?: string;
    style?: React.CSSProperties;
}

/**
 * Segmented control — guide markup verbatim: `.seg` with the sliding `.sind`
 * lume indicator. Measures the active button's box so the cap animates between
 * segments (guide `layout()`).
 */
export function ClSegment<T extends string>({
    options, value, onChange, className, style,
}: ClSegmentProps<T>) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const [ind, setInd] = useState<{ left: number; width: number } | null>(null);

    const measure = () => {
        const btn = btnRefs.current[value];
        if (!btn) return;
        setInd({ left: btn.offsetLeft, width: btn.offsetWidth });
    };

    useLayoutEffect(measure, [value, options.length]);
    useEffect(() => {
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
        if (fonts?.ready) fonts.ready.then(measure);
        const t = setTimeout(measure, 300);
        return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    return (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <div ref={wrapRef} className={['seg', className ?? ''].filter(Boolean).join(' ')} style={style} role="tablist">
                <span className="sind" style={ind ? { left: ind.left, width: ind.width } : undefined} />
                {options.map((o) => (
                    <button
                        key={o.value}
                        ref={(n) => { btnRefs.current[o.value] = n; }}
                        type="button"
                        role="tab"
                        aria-selected={value === o.value}
                        className={value === o.value ? 'on' : ''}
                        onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </span>
    );
}

export default ClSegment;
