import React from 'react';

interface GameControllerIconProps {
    size?: number;
    className?: string;
    /** Override fill color. Defaults to `currentColor`; pair with a Tailwind
     *  text-* class (e.g. `text-green-400`) to inherit naturally. */
    color?: string;
    title?: string;
}

/**
 * Custom filled game-controller icon. Replaces lucide-react's stroked
 * `Gamepad2` in the "playing X" activity indicators. Draws a rounded
 * controller body plus a visible D-pad cross and four face buttons so the
 * silhouette reads unmistakably as a gamepad even at small sizes.
 */
export const GameControllerIcon: React.FC<GameControllerIconProps> = ({
    size = 16,
    className = '',
    color,
    title,
}) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 32 24"
        className={className}
        fill={color ?? 'currentColor'}
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        {title ? <title>{title}</title> : null}
        {/* Main controller body with two side grips. */}
        <path d="M8.5 3.2 C3.8 3.2 1.5 7.2 1.1 13 C0.9 17.5 3 20.8 6 20.8 C8.3 20.8 9.5 18.8 10.4 17 L21.6 17 C22.5 18.8 23.7 20.8 26 20.8 C29 20.8 31.1 17.5 30.9 13 C30.5 7.2 28.2 3.2 23.5 3.2 Z" />
        {/* D-pad cross, dark cutout */}
        <g fill="#0a0f18" fillOpacity="0.55">
            <rect x="6.2" y="10.5" width="6" height="2" rx="0.5" />
            <rect x="8.2" y="8.5"  width="2" height="6" rx="0.5" />
        </g>
        {/* Four face buttons, diamond layout */}
        <g fill="#0a0f18" fillOpacity="0.55">
            <circle cx="24"   cy="8.5"  r="1.25" />
            <circle cx="27"   cy="11.5" r="1.25" />
            <circle cx="21"   cy="11.5" r="1.25" />
            <circle cx="24"   cy="14.5" r="1.25" />
        </g>
    </svg>
);
