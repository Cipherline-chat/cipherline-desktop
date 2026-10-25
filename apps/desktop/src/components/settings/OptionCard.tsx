import React from 'react';

/**
 * A selectable option card: kit radio dot + title + one or two lines saying
 * what the option does. The Settings → Advanced → Update channel (Stable /
 * Staging) and Screen share encoder choices, and Voice & Video → Noise
 * suppression (Off / Light / Strong) — one component, so they look and size
 * the same. Put the cards in a `.sd-opts` grid with role="radiogroup".
 */
export const OptionCard: React.FC<{
    active: boolean;
    disabled?: boolean;
    title: string;
    description: React.ReactNode;
    onClick: () => void;
}> = ({ active, disabled = false, title, description, onClick }) => (
    <button
        type="button"
        role="radio"
        aria-checked={active}
        className={`sd-opt${active ? ' sd-on' : ''}`}
        disabled={disabled}
        onClick={onClick}
    >
        <span className="sd-opt-head">
            <span className="sd-opt-dot" />
            <b>{title}</b>
        </span>
        <p>{description}</p>
    </button>
);
