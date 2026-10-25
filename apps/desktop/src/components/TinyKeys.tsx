import React from 'react';

/** Keys' mark, small: the same geometry as the loading screen's. Static art. */
export const TinyKeys: React.FC = () => (
    <svg className="tb-keys-mark" viewBox="21 14 68 64" width="23" height="22" aria-hidden="true" focusable="false">
        <g fill="#25E0C8">
            <rect x="22.5" y="44" width="13" height="34" rx="6.5" />
            <rect x="39.8" y="44" width="13" height="34" rx="6.5" />
            <rect x="57.1" y="44" width="13" height="34" rx="6.5" />
            <rect x="74.4" y="44" width="13" height="34" rx="6.5" />
            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" />
        </g>
        <g fill="none" stroke="#0B0F1E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" />
            <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" />
        </g>
    </svg>
);


export default TinyKeys;
