import React from 'react';
import { useConversationDraft } from '../hooks/useConversationDraft';
import { DRAFT_PREVIEW_LABEL } from '../utils/draftPreview';

/**
 * The one-line preview under a conversation's name in the DM / group list.
 * Shows the unsent draft (italic, with a "Draft:" prefix) for a conversation
 * that is not open and has one; otherwise the normal last-message `fallback`.
 * Local only — see utils/draftPreview.ts.
 */
export function ConversationPreviewLine({ userId, conversationId, isActive, fallback }: {
    userId: string | null | undefined;
    conversationId: string;
    isActive: boolean;
    fallback: React.ReactNode;
}) {
    const draft = useConversationDraft(userId, conversationId, isActive);
    if (!draft) return <>{fallback}</>;
    return (
        <span data-testid="conversation-draft-preview" className="italic">
            <span style={{ color: 'var(--cl-flash)', fontWeight: 800 }}>{DRAFT_PREVIEW_LABEL}</span>{' '}
            {draft}
        </span>
    );
}
