import React, { useState, useSyncExternalStore } from 'react';
import { Lock, NotebookPen } from 'lucide-react';
import { NOTE_MAX, getNotes, noteOf, setNote, subscribeNotes } from '../../utils/profileNotes';
import '../../styles/profile-card.css';

/**
 * A private note on someone, visible only to you. Saved on this device
 * (encrypted) and synced between YOUR devices end-to-end; never sent to the
 * server in plaintext. Saves when the field loses focus or Ctrl/Cmd+Enter.
 */
export const ProfileNoteField: React.FC<{ userId: string; className?: string }> = ({ userId, className }) => {
    const saved = useSyncExternalStore(subscribeNotes, () => noteOf(getNotes(), userId));
    const [draft, setDraft] = useState(saved);
    const [open, setOpen] = useState(false);
    // Follow the stored note when it changes underneath (another device synced, or another person's card).
    const [seen, setSeen] = useState({ saved, userId });
    if (seen.saved !== saved || seen.userId !== userId) { setSeen({ saved, userId }); setDraft(saved); }

    const commit = () => { if (draft !== saved && !setNote(userId, draft)) setDraft(saved); };

    if (!open && !saved) {
        return (
            <button
                type="button" className={`pcd-note-add${className ? ` ${className}` : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}
                data-testid="profile-note-add"
            ><NotebookPen size={13} aria-hidden="true" /><span>Add a private note</span></button>
        );
    }
    return (
        <section className={`pcd-sec${className ? ` ${className}` : ''}`} data-testid="profile-note">
            <div className="pcd-sec-head">
                <h3 className="pcd-sec-title">Private note <Lock size={11} aria-label="Only you can see this" /></h3>
            </div>
            <textarea
                value={draft} maxLength={NOTE_MAX} rows={3} autoFocus={open && !saved}
                aria-label="Private note. Only you can see this."
                placeholder="Only you can see this"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    e.stopPropagation(); // arrows belong to the field, not the card
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
                }}
                className="pcd-note-input"
                data-testid="profile-note-input"
            />
            <p className="pcd-note-meta">{draft.length}/{NOTE_MAX} · encrypted on your devices, never on our servers</p>
        </section>
    );
};

export default ProfileNoteField;
