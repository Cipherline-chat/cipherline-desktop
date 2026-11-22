import { describe, it, expect } from 'vitest';
import { CONSENT_TEXT, GUILD_POLL, HISTORY_CONSENT_CONTENT, HISTORY_CONSENT_MEMBERS, SETUP_STEPS, canContinue, guildImportErrorMessage, guildListView, nextGuildPoll, nextStep, prevStep, setupIndex, type WizardFacts } from './steps';

const facts = (o: Partial<WizardFacts> = {}): WizardFacts => ({
    tokenValid: false, guildId: null, previewReady: false, serverName: '', consent: false, busy: false, ...o,
});
const all = facts({ tokenValid: true, guildId: '800000000000000001', previewReady: true, serverName: 'Pixel Farm', consent: true });

describe('wizard step rules', () => {
    it('walks token (FIRST) -> guild -> preview -> consent -> run', () => {
        expect(SETUP_STEPS).toEqual(['token', 'guild', 'preview', 'consent']);
        expect(nextStep('token')).toBe('guild');
        expect(nextStep('guild')).toBe('preview');
        expect(nextStep('preview')).toBe('consent');
        expect(nextStep('consent')).toBe('run');
        expect(nextStep('run')).toBe('run');
        expect(prevStep('token')).toBeNull();
        expect(prevStep('guild')).toBe('token');
        expect(prevStep('consent')).toBe('preview');
        expect(prevStep('run')).toBeNull();
        expect(setupIndex('token')).toBe(0);
        expect(setupIndex('guild')).toBe(1);
        expect(setupIndex('done')).toBeNull();
    });

    it('token needs a validated token; guild needs a pick', () => {
        expect(canContinue('token', facts())).toBe(false);
        expect(canContinue('token', facts({ tokenValid: true }))).toBe(true);
        expect(canContinue('guild', facts({ tokenValid: true }))).toBe(false);
        expect(canContinue('guild', facts({ guildId: '800000000000000001' }))).toBe(true);
    });

    it('preview needs a loaded preview and a 2+ character name', () => {
        expect(canContinue('preview', facts({ previewReady: false, serverName: 'Pixel' }))).toBe(false);
        expect(canContinue('preview', facts({ previewReady: true, serverName: ' a ' }))).toBe(false);
        expect(canContinue('preview', facts({ previewReady: true, serverName: 'Pixel' }))).toBe(true);
    });

    it('the run can NEVER start without the consent box (negative control for each other fact)', () => {
        expect(canContinue('consent', all)).toBe(true);
        expect(canContinue('consent', { ...all, consent: false })).toBe(false);
        expect(canContinue('consent', { ...all, previewReady: false })).toBe(false);
        expect(canContinue('consent', { ...all, guildId: null })).toBe(false);
        expect(canContinue('consent', { ...all, serverName: '' })).toBe(false);
    });

    it('copying messages needs ALL THREE boxes and at least one channel (plan A5 item 8)', () => {
        const h = { ...all, withHistory: true, historyConsent: { members: true, content: true }, historyChannels: 2 };
        expect(canContinue('consent', h)).toBe(true);
        expect(canContinue('consent', { ...h, consent: false })).toBe(false);
        expect(canContinue('consent', { ...h, historyConsent: { members: false, content: true } })).toBe(false);
        expect(canContinue('consent', { ...h, historyConsent: { members: true, content: false } })).toBe(false);
        expect(canContinue('consent', { ...h, historyChannels: 0 })).toBe(false);
        expect(HISTORY_CONSENT_MEMBERS).toMatch(/honour requests to remove/);
        expect(HISTORY_CONSENT_CONTENT).toMatch(/will not change them/);
    });

    it('nothing continues while busy; run and done have no Continue', () => {
        for (const s of SETUP_STEPS) expect(canContinue(s, { ...all, busy: true })).toBe(false);
        expect(canContinue('run', all)).toBe(false);
        expect(canContinue('done', all)).toBe(false);
    });

    it('consent wording names administering the server and the right to copy', () => {
        expect(CONSENT_TEXT).toMatch(/administer this Discord server/);
        expect(CONSENT_TEXT).toMatch(/right to copy its settings to Cipherline/);
    });

    it('API errors map to plain copy', () => {
        expect(guildImportErrorMessage({ response: { status: 400, data: { code: 'GUILD_SNAPSHOT_INVALID' } } })).toMatch(/pick the server again/);
        expect(guildImportErrorMessage({ response: { status: 429 } })).toMatch(/Too many tries/);
        expect(guildImportErrorMessage({ response: { status: 400, data: { message: ['name too short'] } } })).toBe('name too short');
        expect(guildImportErrorMessage({})).toMatch(/Couldn’t reach Cipherline/);
        expect(guildImportErrorMessage({ response: { status: 500 } })).toMatch(/Something went wrong/);
    });
});

describe('server list polling and empty states', () => {
    it('polls every 5 s while the list answers, slower when the window is hidden, and stops after 10 minutes', () => {
        expect(GUILD_POLL.okMs).toBe(5000);
        expect(nextGuildPoll({ ok: true }, 0)).toBe(GUILD_POLL.okMs);
        expect(nextGuildPoll({ ok: true }, 0, true)).toBe(GUILD_POLL.hiddenMs);
        expect(nextGuildPoll({ ok: true }, GUILD_POLL.maxMs)).toBeNull();
    });
    it('backs off to 15 s on a transient failure and honours a longer rate-limit wait', () => {
        for (const code of ['network', 'timeout', 'discord_down']) expect(nextGuildPoll({ ok: false, code }, 1000)).toBe(15000);
        expect(nextGuildPoll({ ok: false, code: 'rate_limited', retryAfterMs: 40000 }, 1000)).toBe(40000);
        expect(nextGuildPoll({ ok: false, code: 'rate_limited', retryAfterMs: 10 }, 1000)).toBe(15000);
    });
    it('NEVER re-polls a rejected token (Discord bans IPs that keep sending invalid requests)', () => {
        for (const code of ['invalid_token', 'no_token', 'not_a_bot', 'storage_locked', 'forbidden', 'missing_access']) {
            expect(nextGuildPoll({ ok: false, code }, 1000)).toBeNull();
        }
    });
    it('"bot is in no server" and "couldn\'t reach Discord" are different states; a good list survives a later blip', () => {
        expect(guildListView(null, null)).toEqual({ kind: 'loading' });
        expect(guildListView([], null)).toEqual({ kind: 'no-servers' });
        expect(guildListView([], { code: 'network', message: 'm' })).toEqual({ kind: 'unreachable', message: 'm' });
        expect(guildListView(null, { code: 'timeout', message: 'm' })).toEqual({ kind: 'unreachable', message: 'm' });
        expect(guildListView([], { code: 'invalid_token', message: 't' })).toEqual({ kind: 'token-problem', message: 't' });
        expect(guildListView([{ id: '1' }], { code: 'network', message: 'm' })).toEqual({ kind: 'list' });
    });
});
