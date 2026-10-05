import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios', () => ({
    default: { post: vi.fn() },
}));

import { ackMessageEnvelopes } from './messageAck';

const mockedPost = axios.post as unknown as ReturnType<typeof vi.fn>;

describe('ackMessageEnvelopes', () => {
    beforeEach(() => {
        mockedPost.mockReset();
    });

    it('posts the envelope ids and resolves ok on success', async () => {
        mockedPost.mockResolvedValueOnce({ data: {} });

        const result = await ackMessageEnvelopes('http://api', ['e1', 'e2'], 'tok', 'dev1');

        expect(result).toEqual({ ok: true });
        expect(mockedPost).toHaveBeenCalledWith(
            'http://api/messages/ack',
            { envelope_ids: ['e1', 'e2'] },
            { headers: { Authorization: 'Bearer tok', 'x-device-id': 'dev1' } },
        );
    });

    // This is the regression this module exists to close: before
    // ackMessageEnvelopes existed, Dashboard.tsx awaited the raw axios.post
    // inline with no local try/catch, as the FIRST statement inside the
    // block that also runs every notify() and unread/mention counter update
    // for a batch of decrypted DMs. Any rejection there — network error,
    // transient 5xx, timeout — threw straight past all of it into the outer
    // `catch (err) { console.error('Polling error', err) }`, so a flaky ack
    // silently dropped the sound, toast, and badge for every DM in the
    // batch. The channel/server path has no equivalent dependency (it is
    // pushed over the open WS connection and notified synchronously), which
    // is why "channel notifications still work" was never proof the DM path
    // was healthy too.
    //
    // The fix is this function never throwing. A caller that awaits it can
    // safely run its notify/count logic unconditionally afterwards, whether
    // or not the ack itself succeeded.
    it('never throws on a rejected POST — resolves ok:false instead', async () => {
        const networkError = new Error('Network Error');
        mockedPost.mockRejectedValueOnce(networkError);

        await expect(
            ackMessageEnvelopes('http://api', ['e1'], 'tok', 'dev1'),
        ).resolves.toEqual({ ok: false, error: networkError });
    });

    it('never throws on a non-2xx rejection either', async () => {
        const httpError = Object.assign(new Error('Request failed with status code 503'), {
            response: { status: 503 },
        });
        mockedPost.mockRejectedValueOnce(httpError);

        const result = await ackMessageEnvelopes('http://api', ['e1'], 'tok', 'dev1');
        expect(result.ok).toBe(false);
        expect(result.error).toBe(httpError);
    });
});
