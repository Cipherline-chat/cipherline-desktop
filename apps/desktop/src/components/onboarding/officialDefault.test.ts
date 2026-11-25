import { describe, it, expect } from 'vitest';
import { INITIAL_FLOW_STATE } from './types';

describe('onboarding defaults', () => {
    it('"Also join the official Cipherline server" starts ON (owner 2026-11-24); the person can still switch it off', () => {
        expect(INITIAL_FLOW_STATE.joinOfficial).toBe(true);
    });
});
