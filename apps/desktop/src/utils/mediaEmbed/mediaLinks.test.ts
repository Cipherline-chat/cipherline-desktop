import { describe, it, expect } from 'vitest';
import { isDirectVideoUrl, mediaCaption } from './mediaLinks';
import { safeClmediaUrl } from '../safeMediaUrl';

describe('isDirectVideoUrl', () => {
    it.each([
        'https://cdn.example.com/a.mp4',
        'https://cdn.example.com/a.m4v',
        'https://cdn.example.com/dir/a.webm?sig=1#t=2',
        'https://cdn.example.com/a.MOV',
    ])('%s plays', (u) => expect(isDirectVideoUrl(u)).toBe(true));

    it.each([
        'http://cdn.example.com/a.mp4',
        'https://cdn.example.com/a.mp4.html',
        'https://cdn.example.com/a.mkv',
        'https://cdn.example.com/?file=a.mp4',
        'https://cdn.example.com/#a.mp4',
        'https://u:p@cdn.example.com/a.mp4',
        'https://cdn.example.com:8080/a.mp4',
        'ftp://cdn.example.com/a.mp4',
        'not a url',
    ])('%s does not', (u) => expect(isDirectVideoUrl(u)).toBe(false));
});

describe('mediaCaption', () => {
    it('decoded file name + host, bidi controls stripped, long names cut', () => {
        expect(mediaCaption('https://www.cdn.example.com/v/My%20Clip.mp4')).toEqual({ name: 'My Clip.mp4', host: 'cdn.example.com' });
        expect(mediaCaption('https://cdn.example.com/evil‮gpj.mp4').name).not.toContain('‮');
        expect(mediaCaption(`https://cdn.example.com/${'a'.repeat(200)}.mp4`).name.length).toBeLessThanOrEqual(80);
        expect(mediaCaption('https://cdn.example.com/%E0%A4%A.mp4').name).toBe('%E0%A4%A.mp4');
    });
});

describe('safeClmediaUrl', () => {
    it('only exactly clmedia://media/<32 hex>', () => {
        const ok = `clmedia://media/${'0123456789abcdef'.repeat(2)}`;
        expect(safeClmediaUrl(ok)).toBe(ok);
        for (const bad of [`${ok}x`, `${ok}?a`, 'clmedia://media/../x', `clmedia://other/${'a'.repeat(32)}`, `https://media/${'a'.repeat(32)}`,
            'javascript:alert(1)', `blob:${ok}`, '', null, undefined]) {
            expect(safeClmediaUrl(bad), String(bad)).toBeUndefined();
        }
    });
});
