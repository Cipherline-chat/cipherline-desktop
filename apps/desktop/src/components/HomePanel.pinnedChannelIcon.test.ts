import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Owner request: a pinned SERVER CHANNEL on Home shows its server's icon, not a '#'. */
const src = readFileSync(join(__dirname, 'HomePanel.tsx'), 'utf8');
const pinCard = src.slice(src.indexOf('const PinCard: React.FC'), src.indexOf('const AddPinCard: React.FC'));

describe('Home pinned channel card icon', () => {
    it('channel and server pins both render the server icon', () => {
        // Only two branches: conversation (avatar) vs everything else (server icon).
        expect(pinCard).toMatch(/entry\.kind === 'conversation' \? \([\s\S]*?EncryptedAvatar[\s\S]*?\) : \([\s\S]*?<ServerIcon[\s\S]*?serverId=\{entry\.server\.server_id\}/);
    });
    it('no hash or speaker glyph chip for channel pins any more', () => {
        expect(pinCard).not.toMatch(/'#'/);
        expect(pinCard).not.toContain('Volume2');
    });
});
