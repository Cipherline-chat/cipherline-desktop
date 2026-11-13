import React from 'react';
import { EncryptedAvatar } from './EncryptedAvatar';
import { useAuthorNameHovered } from '../utils/authorNameHover';

type AvatarProps = React.ComponentProps<typeof EncryptedAvatar>;

/**
 * A message author's avatar that also plays (animated GIF / WebP) while the
 * pointer is on that message's author NAME. `hoverKey` is the message id the
 * name reports under (see utils/authorNameHover). Everything else, including
 * the avatar's own hover and click behaviour, is EncryptedAvatar's.
 */
export const AuthorHoverAvatar: React.FC<AvatarProps & { hoverKey: string }> = ({ hoverKey, playing, ...rest }) => {
    const nameHovered = useAuthorNameHovered(hoverKey);
    return <EncryptedAvatar {...rest} playing={!!playing || nameHovered} />;
};
