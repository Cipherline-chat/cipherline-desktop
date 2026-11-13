import { describe, it, expect } from 'vitest';
import { bestAppForWindow, normalizeForMatch, type AudioApp } from './appAudioMatch';

const app = (name: string, binary = name.toLowerCase().replace(/\s+/g, '-'), handle = `h_${name}`): AudioApp => ({ handle, name, binary });
const FIREFOX = app('Firefox', 'firefox');
const SPOTIFY = app('Spotify', 'spotify');
const CHROME = app('Google Chrome', 'chrome');
const MPV = app('mpv Media Player', 'mpv');

describe('normalizeForMatch', () => {
    it('lower-cases, folds accents and reduces punctuation to single spaces', () => {
        expect(normalizeForMatch('  Café — Mozilla®  Firefox!! ')).toBe('cafe mozilla firefox');
        expect(normalizeForMatch('org.mozilla.firefox')).toBe('org mozilla firefox');
        expect(normalizeForMatch('')).toBe('');
    });
});

describe('bestAppForWindow', () => {
    const apps = [FIREFOX, SPOTIFY, CHROME, MPV];

    it('picks the app a window title names (name or program), on whole words', () => {
        expect(bestAppForWindow('YouTube - Mozilla Firefox', apps)).toBe(FIREFOX);
        expect(bestAppForWindow('Spotify Premium', apps)).toBe(SPOTIFY);
        expect(bestAppForWindow('Inbox - Google Chrome', apps)).toBe(CHROME);
        expect(bestAppForWindow('movie.mkv - mpv', apps)).toBe(MPV);          // matched by its program name
        expect(bestAppForWindow('org.mozilla.firefox', apps)).toBe(FIREFOX);  // an app id
    });

    it('selects nothing when the title names no app: no silent guess', () => {
        expect(bestAppForWindow('Untitled document - Notes', apps)).toBeNull();
        expect(bestAppForWindow('Window 1', apps)).toBeNull();
        expect(bestAppForWindow('', apps)).toBeNull();
        expect(bestAppForWindow(undefined, apps)).toBeNull();
        expect(bestAppForWindow(null, apps)).toBeNull();
        expect(bestAppForWindow('Firefox', [])).toBeNull();
    });

    it('does not match inside a longer word', () => {
        expect(bestAppForWindow('Spotifyish settings', apps)).toBeNull();
        expect(bestAppForWindow('Firefoxes of the world', apps)).toBeNull();
    });

    it('selects nothing when two different apps are named equally well', () => {
        expect(bestAppForWindow('Firefox vs Spotify', apps)).toBeNull();
        // ...but a longer, more specific name wins over a shorter one it contains
        const both = [app('Chrome', 'chrome'), CHROME];
        expect(bestAppForWindow('Inbox - Google Chrome', both)).toBe(CHROME);
    });

    it('ignores names too short or too generic to prove anything', () => {
        expect(bestAppForWindow('Audio settings', [app('Audio', 'audio')])).toBeNull();
        expect(bestAppForWindow('vi editor', [app('vi', 'vi')])).toBeNull();
    });
});
