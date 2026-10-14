import React from 'react';
import { ClNote } from './cl/ClNote';
import { ClButton } from './cl';
import { LOCK_PREVIEW_SUGGESTION_TEXT } from '../utils/lockPreviewSuggestion';

/**
 * One-time inline suggestion shown right after Screen Lock is enabled. Purely
 * presentational: the parent owns visibility and applies the setting through
 * the shared notification-prefs setter, so it persists exactly like a manual
 * change in Settings → Notifications.
 */
export const LockPreviewSuggestion: React.FC<{ onHide: () => void; onKeep: () => void }> = ({ onHide, onKeep }) => (
    <div className="flex flex-col gap-2.5 px-0 pt-3 pb-3" data-testid="lock-preview-suggestion">
        <ClNote>{LOCK_PREVIEW_SUGGESTION_TEXT}</ClNote>
        <div className="flex gap-2">
            <ClButton size="sm" onClick={onHide}>Hide previews</ClButton>
            <ClButton size="sm" variant="ghost" onClick={onKeep}>Keep as is</ClButton>
        </div>
    </div>
);
