import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Instant send: a plain-text message is in the feed and the composer is free
 * the moment Enter is pressed; delivery happens behind it, and a failure stays
 * ON THE MESSAGE (Retry / Delete) instead of taking it back. ChatPane has no
 * render harness, so the rules that keep that safe are pinned at the source
 * level; each names the way it would go wrong. The marker logic itself is
 * unit-tested in utils/pendingSend.test.ts.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const send = src.slice(src.indexOf('const handleSendAll = async'), src.indexOf('const [pendingCallMode'));
const deliver = src.slice(src.indexOf('const enqueueDelivery = (job: DeliveryJob)'), src.indexOf('const handleSendAll = async'));

describe('handleSendAll — plain text is instant', () => {
    it('only for plain text: not edits, not anything with files', () => {
        expect(send).toContain('const textOnly = !editingId && stagedFiles.length === 0 && inputText.trim().length > 0;');
    });

    it('a DM/group message is shown as sending, the composer freed, THEN delivery is queued — nothing awaited', () => {
        const shown = send.indexOf("onMessageSent({ ...sentMsg, send_state: 'sending' });");
        const freed = send.indexOf('releaseComposerEarly();', shown);
        const queued = send.indexOf("enqueueDelivery({ kind: 'dm', conversationId: activeChat.id, content });", freed);
        expect(shown).toBeGreaterThan(-1);
        expect(freed).toBeGreaterThan(shown);
        expect(queued).toBeGreaterThan(freed);
    });

    it('a channel message is shown at once too (under its client id), not after the POST', () => {
        const block = send.slice(send.indexOf('if (textOnly) {', send.indexOf('const msgContent')));
        const shown = block.indexOf('onChannelMessageSent?.({');
        const freed = block.indexOf('releaseComposerEarly();');
        const queued = block.indexOf("enqueueDelivery({ kind: 'channel'");
        expect(shown).toBeGreaterThan(-1);
        expect(block.slice(shown, freed)).toContain("send_state: 'sending'");
        expect(block.slice(shown, freed)).toContain('id: safeUUID,');
        expect(freed).toBeGreaterThan(shown);
        expect(queued).toBeGreaterThan(freed);
        // the encrypt for this path lives in enqueueDelivery, never inline before the append
        expect(block.slice(0, queued)).not.toContain('encryptChannelMessage');
    });

    it('the DM message keeps its client_msg_id as its id (nothing to swap when the send lands)', () => {
        expect(send).toContain('id: content.client_msg_id!,');
    });

    it('a failure never takes the message back or restores the draft', () => {
        expect(src).not.toContain('rollbackSend');
        expect(src).not.toContain('draftSnapshot');
    });

    it('does not clear the composer a second time when the send lands (that would wipe the NEXT message)', () => {
        expect(send).toContain('if (!earlyReleased) {\n                    setInputText(\'\');');
    });

    it('the rate limiter counts an instant send immediately, and only once', () => {
        expect(send).toContain('sendTimestamps.current.push(Date.now()); // the rate limiter counts it NOW');
        expect(send).toContain('if (!earlyReleased) sendTimestamps.current.push(Date.now());');
    });
});

describe('enqueueDelivery — delivery behind the feed', () => {
    it('marks the message delivered on success; a channel message also takes its server id and the server time', () => {
        expect(deliver).toMatch(/onPatchSentMessage\?\.\('channel', job\.conversationId, clientMsgId, \{\s*send_state: null,\s*id: resp\.data\?\.id,/);
        expect(deliver).toContain('timestamp: resp.data?.created_at ? clampFutureTimestamp(String(resp.data.created_at)) : undefined,');
    });

    it("a DM takes the server's received_at_server (its ordering key everywhere) when the API returns it", () => {
        expect(deliver).toContain('{ send_state: null, server_ts: serverTs, timestamp: clampFutureTimestamp(serverTs) }');
        // an older API without it: confirmed in place, as before
        expect(deliver).toContain(': { send_state: null });');
    });

    it('a failure marks the message failed with a reason and never rethrows', () => {
        const body = deliver.slice(deliver.indexOf('const fail = (err: unknown) => {'), deliver.indexOf("if (job.kind === 'channel') {\n            const c ="));
        expect(body.length).toBeGreaterThan(100);
        expect(body).toContain("send_state: 'failed', send_error: sendFailureReason(err)");
        expect(body).not.toMatch(/\bthrow\b/);
        // a missing channel key starts the key fetch so Retry can succeed
        expect(body).toContain('onChannelKeyMissing?.(job.serverId, job.conversationId)');
        // both kinds report through it
        expect(deliver.match(/\bfail,\n/g)).toHaveLength(2);
    });

    it('deliveries go through the shared per-conversation pipeline (prepare overlaps, POSTs in order)', () => {
        expect(deliver).toContain("void deliveryQueue.enqueue(deliveryKey('channel', job.conversationId), {");
        expect(deliver).toContain("void deliveryQueue.enqueue(deliveryKey('dm', job.conversationId), {");
        expect(src).not.toContain('sendQueueRef');
    });

    it('a DM takes the recipients primed while typing (single use), and encrypts in prepare, not post', () => {
        const dm = deliver.slice(deliver.indexOf("void deliveryQueue.enqueue(deliveryKey('dm'"));
        expect(dm.indexOf('await takeRecipients(job.conversationId)')).toBeGreaterThan(-1);
        expect(dm.indexOf('await takeRecipients(job.conversationId)')).toBeLessThan(dm.indexOf('post: async'));
        expect(dm.indexOf('encryptAndAddress(')).toBeLessThan(dm.indexOf('post: async'));
        expect(src).toContain('if (!activeChannel && bundleReady) primeRecipients(activeChat.id);');
    });

    it('a 429 waits out the server window and retries instead of failing the message', () => {
        expect(deliver.match(/withRateLimitRetry\(\(\) => axios\.post\(/g)).toHaveLength(2);
    });

    it('awaited sends (files, edits, reactions) never overtake queued messages', () => {
        expect(send).toContain('await deliveryQueue.idle(activeChannel ? deliveryKey(');
        const scc = src.slice(src.indexOf('const sendClientContent = async'), src.indexOf('const handleSendKlipyGif = async'));
        expect(scc).toContain('await deliveryQueue.idle(activeChannel ? deliveryKey(');
    });

    it('every DM message resolves its OWN recipients, never one claim shared by several messages', () => {
        // Each claim is one one-time prekey per device, deleted by the recipient
        // after its first use: a second message on the same claim is undecryptable.
        expect(send).not.toMatch(/const devices[^=]*=\s*activeChannel \|\| textOnly/);
        expect(send).toContain('const fileRecipients = await takeRecipients(activeChat.id);');
        expect(send).toContain('uploadFile(file, fileRecipients)');
        expect(send).toMatch(/const devices = await takeRecipients\(activeChat\.id\);\s*\/\/ RC-2/);
    });

    it('Retry re-sends the SAME content (same client_msg_id, so receivers dedupe a copy that did land)', () => {
        const retry = src.slice(src.indexOf('const retrySend = '), src.indexOf('const discardUnsent = '));
        expect(retry).toContain("{ send_state: 'sending' }");
        expect(retry).toContain('enqueueDelivery({ kind, conversationId, serverId: activeChannel?.server_id, content });');
    });

    it('the step timings are recorded for the Performance log', () => {
        for (const label of ['send:devices', 'send:encrypt', 'send:post']) expect(src).toContain(`'${label}'`);
    });
});

describe('the undelivered message in the feed', () => {
    it('carries the red "!" indicator, whose popover offers Retry and Discard (utils/undeliveredSend.ts)', () => {
        expect(src).toContain('<UndeliveredIndicator');
        expect(src).toContain('onRetry={() => retrySend(msg)}');
        expect(src).toContain('onDiscard={() => discardUnsent(msg)}');
        // The old always-visible "Not delivered — reason · Retry · Delete" line is gone.
        expect(src).not.toContain("{msg.send_state === 'failed' && (");
    });

    it('an unconfirmed message has no hover actions; its context menu appears only once flagged undelivered', () => {
        expect(src).toContain('hoveredMsgId === msg.id && !isUnconfirmedSend(msg) &&');
        expect(src).toContain('if (undelivered) openUndeliveredMenu(e, msg); else e.preventDefault();');
    });

    it('a pending message is drawn like a sent one: no dimming class, no .cl-send-pending rule', () => {
        expect(src).not.toContain('cl-send-pending');
        const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
        expect(css).not.toContain('cl-send-pending');
    });

    it('Retry restarts the 10 s clock and a discarded message is never sent by a queued attempt', () => {
        const retry = src.slice(src.indexOf('const retrySend = '), src.indexOf('const discardUnsent = '));
        expect(retry).toContain('sendClock.restart(clientMsgId);');
        expect(src.slice(src.indexOf('const discardUnsent = '), src.indexOf('const handleSendAll = async'))).toContain('markCancelled(cid);');
        // Both POST paths skip when an earlier attempt already landed or the user discarded it.
        expect(deliver.split('if (wasDelivered(clientMsgId) || wasCancelled(clientMsgId)) return;').length - 1).toBe(2);
        expect(deliver.split('markDelivered(clientMsgId);').length - 1).toBe(2);
    });
});
