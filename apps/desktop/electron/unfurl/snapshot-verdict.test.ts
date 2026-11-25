/**
 * A page snapshot is never a login page, a captcha / bot wall, an error page
 * or a blank screen (snapshot-verdict.ts). Each wall kind is checked, and the
 * POSITIVE CONTROLS are real pages that must still be shown: an article with
 * a sign-in link in its header, a long page with a small search box, an
 * article whose title says "error", a mostly white page with some text.
 */
import { describe, it, expect } from 'vitest';
import { cleanFacts, isLoginUrl, judgePage, pixelUniformity, type PageFacts } from './snapshot-verdict';

const page = (over: Partial<PageFacts> = {}): PageFacts => ({
    finalUrl: 'https://news.example/story', title: 'A real story', text: 'Lorem ipsum '.repeat(300), textLength: 3600,
    visiblePassword: false, captchaFrames: 0, challengeMarkers: false, media: 4, ...over,
});
const judge = (facts: PageFacts | null, over: { httpStatus?: number; loginSeen?: boolean; uniformity?: number } = {}) =>
    judgePage({ facts, httpStatus: over.httpStatus ?? 200, loginSeen: over.loginSeen ?? false, uniformity: over.uniformity ?? 0.4 });

describe('isLoginUrl', () => {
    it.each([
        'https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/document/d/x/edit',
        'https://accounts.google.com/v3/signin/identifier?dsh=1',
        'https://login.microsoftonline.com/common/oauth2/authorize',
        'https://www.example.com/login',
        'https://www.example.com/users/sign_in',
        'https://example.com/account/login?next=/',
        'https://www.amazon.com/ap/signin?openid=1',
        'https://login.example.org/',
        'https://sso.corp.example/',
    ])('%s is a sign-in URL', (u) => expect(isLoginUrl(u)).toBe(true));

    it.each([
        'https://docs.google.com/document/d/1MPjVwL-oB8RT476yEPP47JEVqk6iVty5WpylrqsGESg/edit',
        'https://www.bbc.com/news',
        'https://id.wikipedia.org/wiki/Kucing',               // "id." is Indonesian, not identity
        'https://blog.example/how-to-fix-login-issues',        // the word, not the page
        'https://example.com/',
        'not a url',
    ])('%s is not', (u) => expect(isLoginUrl(u)).toBe(false));
});

describe('judgePage', () => {
    it('a real page is shown', () => {
        expect(judge(page())).toBe('ok');
    });

    it('login: redirected / navigating to a sign-in host, a sign-in title, a page that is mostly a password box, "sign in to continue"', () => {
        expect(judge(page(), { loginSeen: true })).toBe('login');
        expect(judge(page({ finalUrl: 'https://accounts.google.com/v3/signin/identifier' }))).toBe('login');
        expect(judge(page({ title: 'Sign in - Google Accounts' }))).toBe('login');
        expect(judge(page({ title: 'Log in to Example' }))).toBe('login');
        expect(judge(page({ title: 'Example', visiblePassword: true, textLength: 400, text: 'Email Password Forgot?' }))).toBe('login');
        expect(judge(page({ title: 'Example Docs', textLength: 300, text: 'You need permission. Request access, or switch to an account with access.' }))).toBe('login');
    });

    it('bot walls and captchas: Cloudflare, challenge markup, captcha frames, Amazon / DataDome texts', () => {
        expect(judge(page({ title: 'Just a moment...', textLength: 120, text: 'Verifying you are human. This may take a few seconds.' }))).toBe('bot-wall');
        expect(judge(page({ title: 'stackoverflow.com', textLength: 200, text: 'Performing security verification. This website uses a security service to protect against malicious bots.' }))).toBe('bot-wall');
        expect(judge(page({ challengeMarkers: true }))).toBe('bot-wall');
        expect(judge(page({ captchaFrames: 1 }))).toBe('bot-wall');
        expect(judge(page({ title: 'Amazon.com', textLength: 300, text: "Click the button below to continue shopping. Sorry, we just need to make sure you're not a robot." }))).toBe('bot-wall');
        expect(judge(page({ title: 'Robot Check' }))).toBe('bot-wall');
        expect(judge(page({ title: 'Access to this page has been denied', textLength: 200, text: 'Press & Hold to confirm you are a human (and not a bot).' }))).toBe('bot-wall');
    });

    it('error pages: an error status, or a short page titled like one', () => {
        expect(judge(page(), { httpStatus: 404 })).toBe('error');
        expect(judge(page(), { httpStatus: 503 })).toBe('error');
        expect(judge(page({ title: '404 Not Found', textLength: 60, text: 'Not Found. The requested URL was not found on this server.' }))).toBe('error');
        expect(judge(page({ title: 'Page not found | Example', textLength: 300, text: 'Sorry' }))).toBe('error');
    });

    it('blank pages: nothing to read and nothing drawn, or one flat colour', () => {
        expect(judge(page({ textLength: 0, text: '', media: 0 }))).toBe('blank');
        expect(judge(page(), { uniformity: 0.999 })).toBe('blank');
        expect(judge(page({ textLength: 10, text: 'Loading…', media: 1 }), { uniformity: 0.98 })).toBe('blank');
        expect(judge(null)).toBe('blank'); // the page could not be read (hung / crashed): never shown
    });

    it('POSITIVE CONTROLS: real pages that look a little like walls are still shown', () => {
        // A long article with a header sign-in box.
        expect(judge(page({ visiblePassword: true, textLength: 9000 }))).toBe('ok');
        // An article ABOUT errors.
        expect(judge(page({ title: 'How to fix a 500 Internal Server Error in Nginx', textLength: 8000 }))).toBe('ok');
        // A mostly white page with a heading and a paragraph (example.com).
        expect(judge(page({ title: 'Example Domain', textLength: 160, text: 'Example Domain This domain is for use in documentation examples without needing permission.', media: 0 }), { uniformity: 0.96 })).toBe('ok');
        // A page with some pictures and little text (a gallery / app shell that drew).
        expect(judge(page({ textLength: 12, text: 'Photos', media: 6 }), { uniformity: 0.6 })).toBe('ok');
    });
});

describe('pixelUniformity', () => {
    const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
        const b = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) b.set(rgba, i * 4);
        return b;
    };
    it('one flat colour is 1; half and half is ~0.5; a too-short buffer counts as flat', () => {
        expect(pixelUniformity(solid(120, 60, [255, 255, 255, 255]), 120, 60)).toBe(1);
        const b = solid(120, 60, [255, 255, 255, 255]);
        for (let y = 0; y < 60; y++) for (let x = 60; x < 120; x++) b.set([10, 20, 30, 255], (y * 120 + x) * 4);
        const u = pixelUniformity(b, 120, 60);
        expect(u).toBeGreaterThan(0.4);
        expect(u).toBeLessThan(0.6);
        expect(pixelUniformity(new Uint8Array(10), 120, 60)).toBe(1);
    });
});

describe('cleanFacts (the isolated script\'s answer is untrusted shape)', () => {
    it('keeps well-typed fields, caps strings, drops junk', () => {
        const f = cleanFacts({ finalUrl: 'https://a.example/', title: 'x'.repeat(900), text: 'y', textLength: 5, visiblePassword: 'yes', captchaFrames: -3, challengeMarkers: 1, media: Infinity });
        expect(f).toEqual({ finalUrl: 'https://a.example/', title: 'x'.repeat(500), text: 'y', textLength: 5, visiblePassword: false, captchaFrames: 0, challengeMarkers: false, media: 0 });
        expect(cleanFacts(null)).toBeNull();
        expect(cleanFacts({ title: 'no url' })).toBeNull();
    });
});
