/* eslint-disable -- visual harness, not shipped */
// Stand-in for components/server/EmojiImage: draws the harness's server emoji picture
// (the real component decrypts it through the API's emoji URL route).
import React from 'react';
export const serverEmojiPictures = new Map<string, string>();
export const EmojiImage: React.FC<{ name: string; attachmentId: string; style?: React.CSSProperties; className?: string }> = ({ name, attachmentId, style, className }) => (
    <img src={serverEmojiPictures.get(attachmentId) ?? ''} alt={`:${name}:`} className={className} style={{ objectFit: 'contain', ...style }} />
);
export const EmojiPlaceholder: React.FC = () => null;
export const MissingEmojiPlaceholder: React.FC = () => null;
