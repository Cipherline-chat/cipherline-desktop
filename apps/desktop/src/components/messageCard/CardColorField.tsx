/**
 * A card-style colour input: the six THEME colours first (they resolve per
 * viewer theme, so a card reads right everywhere), then a custom colour
 * (the app's own picker), and an opacity slider. The value is a normalised
 * CardColor string (`#rrggbb[aa]` or `theme(token[ / n%])`).
 */
import React from 'react';
import { CARD_THEME_TOKENS, type CardColor, type CardThemeToken } from '@cipherline/shared';
import { ClSlider } from '../ClSlider';
import { ColourSwatchButton } from '../settings/ui/ColourPicker';
import { DESKTOP_CARD_THEME } from '../../utils/cardStyle/cardStyleReact';
import { joinCardColor, splitCardColor } from '../../utils/cardStyle/cardColorParts';

const TOKEN_LABEL: Record<CardThemeToken, string> = {
    accent: 'Accent', success: 'Success', warning: 'Warning', danger: 'Danger', info: 'Info', muted: 'Muted',
};

export interface CardColorFieldProps {
    label: string;
    value: CardColor | null | undefined;
    onChange: (c: CardColor) => void;
    /** Hide the opacity slider (e.g. text colour). */
    noAlpha?: boolean;
}

export const CardColorField: React.FC<CardColorFieldProps> = ({ label, value, onChange, noAlpha }) => {
    const { token, hex, alpha } = splitCardColor(value);
    return (
        <div className="cse-color" role="group" aria-label={label}>
            <div className="cse-color-row">
                {CARD_THEME_TOKENS.map(t => (
                    <button
                        key={t}
                        type="button"
                        className="cse-token"
                        data-token={t}
                        aria-pressed={token === t}
                        aria-label={`${label}: theme ${TOKEN_LABEL[t]}`}
                        title={`${TOKEN_LABEL[t]} (theme colour: adapts to the reader's theme)`}
                        style={{ background: DESKTOP_CARD_THEME.tokens[t] }}
                        onClick={() => onChange(joinCardColor(t, hex, alpha))}
                    />
                ))}
                <span className="cse-color-sep" aria-hidden="true" />
                <ColourSwatchButton
                    label={`${label}: custom colour`}
                    value={hex}
                    size={22}
                    className={token ? undefined : 'cse-custom-on'}
                    onChange={(h) => onChange(joinCardColor(null, h, alpha))}
                    onCommit={(h) => onChange(joinCardColor(null, h, alpha))}
                />
            </div>
            {!noAlpha && (
                <ClSlider
                    value={alpha}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(a) => onChange(joinCardColor(token, hex, a))}
                    formatLabel={(a) => `${Math.round(a)}%`}
                    ariaLabel={`${label} opacity`}
                    resetValue={100}
                    className="cse-slider"
                />
            )}
        </div>
    );
};
