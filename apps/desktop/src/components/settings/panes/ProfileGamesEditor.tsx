import React, { useId, useState } from 'react';
import { ReorderChips } from './ReorderChips';
import { moveItem } from '../../../utils/moveItem';
import { WIDGET_GAMES_MAX, WIDGET_GAME_MAX_LEN, cleanGameName } from '../../../utils/profileCosmetics';

/**
 * Favorite games as one tag input (owner round 2): the games are chips inside
 * the field; type a name and press Enter (or a comma) to add it, × or
 * Backspace on an empty field removes, drag or Alt + arrows reorder. Messages
 * are short and inline. The server re-checks every name (length, characters,
 * the shared name filter) and the caller shows its answer if it refuses one.
 */
export const ProfileGamesEditor: React.FC<{
    games: string[];
    disabled?: boolean;
    onChange: (next: string[]) => void;
}> = ({ games, disabled, onChange }) => {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const msgId = useId();
    const full = games.length >= WIDGET_GAMES_MAX;

    const commit = (raw: string): boolean => {
        if (!raw.trim()) return false;
        const name = cleanGameName(raw);
        if (!name) { setError(raw.trim().length > WIDGET_GAME_MAX_LEN ? `Keep it under ${WIDGET_GAME_MAX_LEN + 1} characters.` : 'That name has characters we can’t show.'); return false; }
        if (full) { setError(`That's the most games (${WIDGET_GAMES_MAX}).`); return false; }
        if (games.some((g) => g.toLowerCase() === name.toLowerCase())) { setError('Already on your list.'); return false; }
        setError('');
        onChange([...games, name]);
        return true;
    };

    return (
        <div data-testid="games-editor">
        <div className="ps-tagbox-field" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}
            onClick={(e) => { if (e.target === e.currentTarget) (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus(); }}>
            <ReorderChips
                items={games.map((g) => ({ key: g, name: g, label: g }))} disabled={disabled}
                label={`Your favorite games, ${games.length} of ${WIDGET_GAMES_MAX}`}
                onMove={(a, b) => onChange(moveItem(games, a, b))}
                onRemove={(i) => onChange(games.filter((_, k) => k !== i))}
            />
            <input
                id="pc-game-input" className="ps-tagbox-input" value={draft} maxLength={WIDGET_GAME_MAX_LEN + 1} disabled={disabled || full}
                placeholder={full ? '' : games.length ? 'Add another' : 'Type a game, press Enter'}
                aria-label={`Add a favorite game, ${games.length} of ${WIDGET_GAMES_MAX}`}
                aria-invalid={!!error} aria-describedby={msgId}
                onChange={(e) => {
                    const v = e.target.value;
                    // A comma (typed or pasted) adds what is before it.
                    if (v.includes(',')) {
                        const parts = v.split(',');
                        const rest = parts.pop() ?? '';
                        let ok = true;
                        for (const p of parts) if (p.trim()) ok = commit(p) && ok;
                        setDraft(ok ? rest : v.replace(/,/g, ''));
                        return;
                    }
                    setError('');
                    setDraft(v);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); if (commit(draft)) setDraft(''); }
                    else if (e.key === 'Backspace' && !draft && games.length) { e.preventDefault(); onChange(games.slice(0, -1)); }
                }}
            />
            <span className="ps-tagbox-count" aria-hidden="true">{games.length}/{WIDGET_GAMES_MAX}</span>
        </div>
        <p id={msgId} className={error ? 'ps-inline-err' : 'ps-inline-hint'} role={error ? 'alert' : undefined}>{error || '\u00a0'}</p>
        </div>
    );
};
