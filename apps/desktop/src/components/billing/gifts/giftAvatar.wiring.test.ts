import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Owner, 2026-11-18: "The picker to select who to send the gift to doesn't show their profile picture ... nor in the
// payment section". Both spots use GiftAvatar, which draws the friend's encrypted avatar (EncryptedAvatar) when they
// have one, and the coloured initial otherwise.
const src = readFileSync(resolve(__dirname, 'GiftProModal.tsx'), 'utf8');

describe('gift picker and pay step show profile pictures', () => {
    it('both avatar spots use GiftAvatar with the friend avatar_url', () => {
        expect(src).toMatch(/<GiftAvatar userId=\{f\.user_id\} name=\{name\} avatarUrl=\{f\.avatar_url\} \/>/);
        expect(src).toMatch(/<GiftAvatar userId=\{recipient\.userId\} name=\{recipient\.name\} avatarUrl=\{recipient\.avatarUrl\} \/>/);
        expect(src).toMatch(/avatarUrl: recipientFriend\?\.avatar_url \?\? null/);
    });
    it('no bare initial-only circle is left', () => {
        expect(src).not.toMatch(/<span className="gft-av" style=\{\{ background: avatarBg\(/);
    });
    it('the image path goes through EncryptedAvatar; auth is only read when there is a picture', () => {
        expect(src).toMatch(/const GiftAvatarImage[\s\S]{0,200}useAuth\(\)[\s\S]{0,200}<EncryptedAvatar attachmentId=\{avatarUrl\}/);
        expect(src).toMatch(/avatarUrl \? <GiftAvatarImage/);
    });
});
