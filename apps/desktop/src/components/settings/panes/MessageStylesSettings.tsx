/**
 * Settings → Appearance → Message styles.
 *
 *  - How YOU see other people's styled messages: Show all / Without
 *    animation / Plain (a device display preference; your OS's
 *    reduced-motion setting always removes animation too).
 *  - "My styles": the library of styles you saved from the card editor, to
 *    apply to a message in one click. Rename, edit or delete them here.
 *
 * There is no default style: styling is a deliberate, per-message act
 * ("Style this message" in the formatting bar), for rules, announcements and
 * posts that should stand apart.
 */
import React, { useState } from 'react';
import { Palette, Pencil, Trash2, Plus, Check } from 'lucide-react';
import type { CardStyle, UserCardStyleMode } from '@cipherline/shared';
import { ClSegment } from '../../cl';
import { ClButton } from '../../ClButton';
import { useAuth } from '../../../contexts/AuthContext';
import { useCardStyleLibrary, useMessageStylesMode } from '../../../hooks/useCardStylePrefs';
import { MessageCard } from '../../messageCard/MessageCard';
import { CardStyleDialog } from '../../messageCard/CardStyleDialog';
import { resolveCard } from '../../../utils/cardStyle/cardStyleReact';
import '../../../styles/card-style-editor.css';

const MODE_HINT: Record<UserCardStyleMode, string> = {
    all: 'Cards show with their colours and animation.',
    static: 'Cards keep their look but never move.',
    plain: 'Every message shows as plain text, without its card.',
};

export const MessageStylesSettings: React.FC = () => {
    const { userId, user } = useAuth();
    const [mode, setMode] = useMessageStylesMode();
    const library = useCardStyleLibrary(userId ?? user?.user_id ?? null);
    const [editing, setEditing] = useState<null | { id: string | null; style: CardStyle | null }>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    return (
        <div className="sd-card" data-testid="message-styles-settings" data-labels="Message styles|My styles">
            <h3>Message styles</h3>
            <p className="sd-sub">Cards that people put around messages: rules, announcements, events. Everything about them travels encrypted.</p>
            <div className="sd-row" style={{ borderTop: 'none' }}>
                <span className={`sd-tile${mode === 'plain' ? ' sd-tile--dim' : ''}`}><Palette size={16} /></span>
                <div className="sd-rl">
                    <b>Show message styles</b>
                    <span>{MODE_HINT[mode]} Servers can turn styles off for their channels, and you can show any single message plain from its right-click menu.</span>
                </div>
            </div>
            <div style={{ padding: '4px 0 12px 46px' }}>
                <ClSegment<UserCardStyleMode>
                    value={mode}
                    onChange={setMode}
                    options={[{ value: 'all', label: 'Show all' }, { value: 'static', label: 'Without animation' }, { value: 'plain', label: 'Plain' }]}
                />
            </div>

            <div className="sd-row">
                <span className="sd-tile"><Palette size={16} /></span>
                <div className="sd-rl">
                    <b>My styles</b>
                    <span>Styles you saved from the card editor. Apply one to a message from "Style this message" in the formatting bar.</span>
                </div>
                <div className="sd-rc">
                    <ClButton size="sm" variant="ghost" onClick={() => setEditing({ id: null, style: null })}><Plus size={14} /> New style</ClButton>
                </div>
            </div>
            {library.items.length === 0
                ? <p className="mss-empty">No saved styles yet.</p>
                : (
                    <ul className="mss-list">
                        {library.items.map(item => (
                            <li key={item.id}>
                                <MessageCard resolved={resolveCard(item.style, 'static')} className="mss-card">
                                    <span>{item.name}</span>
                                </MessageCard>
                                {renaming === item.id ? (
                                    <form className="cse-lib-rename" onSubmit={(e) => { e.preventDefault(); if (library.rename(item.id, renameValue)) setRenaming(null); }}>
                                        <input autoFocus value={renameValue} maxLength={40} aria-label="Style name" onChange={(e) => setRenameValue(e.target.value)} />
                                        <button type="submit" className="cse-icon-btn" aria-label="Save name"><Check size={14} /></button>
                                    </form>
                                ) : (
                                    <span className="mss-actions">
                                        <button type="button" className="cse-icon-btn" aria-label={`Edit ${item.name}`} onClick={() => setEditing({ id: item.id, style: item.style })}><Palette size={14} /></button>
                                        <button type="button" className="cse-icon-btn" aria-label={`Rename ${item.name}`} onClick={() => { setRenaming(item.id); setRenameValue(item.name); }}><Pencil size={14} /></button>
                                        <button type="button" className="cse-icon-btn" aria-label={`Delete ${item.name}`} onClick={() => library.remove(item.id)}><Trash2 size={14} /></button>
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            {editing && <CardStyleDialog
                open
                title={editing?.id ? 'Edit saved style' : 'New style'}
                applyLabel="Save style"
                initial={editing?.style ?? null}
                previewText={'# Server rules\n1. **Be kind.** Disagree with ideas, not people.\n2. No spam outside #showcase.\n3. Keep it safe for work.'}
                previewName={user?.username ?? 'You'}
                library={library}
                onClose={() => setEditing(null)}
                onApply={(style) => {
                    const e = editing;
                    setEditing(null);
                    if (!e || !style) return;
                    if (e.id) library.update(e.id, style);
                    else library.save(`Style ${library.items.length + 1}`, style);
                }}
            />}
        </div>
    );
};

export default MessageStylesSettings;
