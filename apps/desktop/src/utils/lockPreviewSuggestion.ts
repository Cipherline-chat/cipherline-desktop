import type { NotificationPrefs } from '../contexts/NotificationContext';

/**
 * The most private preview option that still notifies: the toast reads
 * "Cipherline / New message" (no sender, no text). `useNotificationDispatch`
 * maps 'hidden' to exactly that - it is NOT "notifications off".
 */
export const HIDDEN_PREVIEW: NotificationPrefs['show_preview'] = 'hidden';

/**
 * Whether turning on Screen Lock should suggest hiding previews. Only 'full'
 * puts message TEXT in the OS toast; 'sender_only' / 'hidden' already keep it
 * out, so there is nothing to suggest.
 */
export const previewShowsMessageText = (mode: NotificationPrefs['show_preview']): boolean => mode === 'full';

export const LOCK_PREVIEW_SUGGESTION_TEXT =
    'Notifications can still show message text while Cipherline is locked. Hide message previews?';
