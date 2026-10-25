import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractYouTubeId } from './youtubeLink';

const ID = 'dQw4w9WgXcQ';

describe('extractYouTubeId: only YouTube\'s own hosts produce a player', () => {
    it.each([
        `https://www.youtube.com/watch?v=${ID}`,
        `https://youtube.com/watch?v=${ID}&t=42s`,
        `https://m.youtube.com/watch?feature=share&v=${ID}`,
        `https://youtu.be/${ID}`,
        `https://youtu.be/${ID}?si=abc`,
        `https://www.youtube.com/embed/${ID}`,
        `https://www.youtube.com/shorts/${ID}`,
        `http://www.youtube.com/watch?v=${ID}`,
        `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
    ])('%s', url => {
        expect(extractYouTubeId(url)).toBe(ID);
    });

    it.each([
        `https://evil.example/watch?v=${ID}`,
        `https://evil.example/?v=${ID}`,
        `https://evil.example/embed/${ID}`,
        `https://youtube.com.evil.example/watch?v=${ID}`,
        `https://evil.example/youtu.be/${ID}`,
        `https://notyoutube.com/watch?v=${ID}`,
        `https://www.youtube.com@evil.example/watch?v=${ID}`,
        `https://user:pw@www.youtube.com/watch?v=${ID}`,
        `javascript://www.youtube.com/watch?v=${ID}`,
        `https://www.youtube.com/watch?v=short`,
        `https://www.youtube.com/watch?v=${ID}x`,
        `https://www.youtube.com/channel/${ID}`,
        'not a url',
    ])('%s is not a YouTube video', url => {
        expect(extractYouTubeId(url)).toBeNull();
    });
});

describe('call sites', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
    it('ChatPane and the pinned panel use the shared, host-pinned parser', () => {
        for (const f of ['components/ChatPane.tsx', 'components/PinnedMessagesPanel.tsx']) {
            const src = read(f);
            expect(src).toMatch(/import \{ extractYouTubeId \} from '\.\.\/utils\/youtubeLink'/);
            expect(src).not.toMatch(/function extractYouTubeId/);
        }
    });
    it('the pinned panel draws no <img> from a URL in message text', () => {
        const src = read('components/PinnedMessagesPanel.tsx');
        expect(src).not.toMatch(/src=\{firstImgUrl\}/);
        expect(src).not.toMatch(/isDirectImageUrl/);
    });
});
