import React from 'react';
import { useServerEmojiUrl } from '../../../hooks/useServerEmojiUrl';
import type { RoleIcon } from '../../../utils/roleStyle';

/**
 * A role's icon (emoji or uploaded image) at a fixed square size, with the
 * role's name as its accessible label and tooltip. An image loads through the
 * custom-emoji pipeline (memory -> encrypted disk cache -> batched presigned
 * GETs, decrypted off the UI thread); until it resolves a same-size neutral
 * placeholder holds the space so the name never shifts.
 *
 * Shown in the member list, profile role pills and the role editor — not in
 * chat (owner decision 2026-11-22).
 */
export const RoleIconBadge: React.FC<{
    icon: RoleIcon;
    token: string | null;
    size?: number;
    className?: string;
    /** Decorative where the role name is already right next to it. */
    decorative?: boolean;
}> = ({ icon, token, size = 16, className, decorative }) => {
    const label = `${icon.roleName} role icon`;
    const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
    const box: React.CSSProperties = { width: size, height: size };
    if (icon.kind === 'emoji') {
        return (
            <span
                {...a11y}
                title={icon.roleName}
                data-role-icon="emoji"
                className={`cl-role-icon ${className ?? ''}`}
                style={{ ...box, fontSize: Math.round(size * 0.92) }}
            >
                {icon.emoji}
            </span>
        );
    }
    return <RoleIconImage icon={icon} token={token} box={box} a11y={a11y} className={className} />;
};

const RoleIconImage: React.FC<{
    icon: Extract<RoleIcon, { kind: 'image' }>;
    token: string | null;
    box: React.CSSProperties;
    a11y: Record<string, unknown>;
    className?: string;
}> = ({ icon, token, box, a11y, className }) => {
    // Stable ref per image: callers rebuild the icon object on render, and the
    // hook's load effect is keyed on ref identity.
    const { attachmentId, keyB64 } = icon.ref;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity is the (attachment, key) pair
    const ref = React.useMemo(() => icon.ref, [attachmentId, keyB64]);
    const url = useServerEmojiUrl(ref, token);
    if (!url) {
        return <span {...a11y} title={icon.roleName} data-role-icon="pending" className={`cl-role-icon cl-role-icon--pending ${className ?? ''}`} style={box} />;
    }
    return (
        <span {...a11y} title={icon.roleName} data-role-icon="image" className={`cl-role-icon ${className ?? ''}`} style={box}>
            <img src={url} alt="" draggable={false} />
        </span>
    );
};
