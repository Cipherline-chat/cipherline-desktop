/**
 * Source-level wiring guard for the sender binding in Dashboard's DM pull loop.
 * Dashboard.tsx is too large to mount in a unit test, and the failure this
 * guards (a later edit moving the binding below a sink that reads the claimed
 * sender id, or acking a held envelope) is a silent one - so the order is
 * asserted on the source text of the pull loop. The decision itself is tested
 * behaviourally in senderBindingGroup.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'components', 'Dashboard.tsx'), 'utf8');
const start = src.indexOf('const pullMessagesOnce = React.useCallback');
const end = src.indexOf('const pullSerialised = React.useCallback');
const pull = src.slice(start, end);

describe('Dashboard DM pull loop - sender binding order', () => {
    it('found the pull loop', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('binds the sender BEFORE every sink that reads the claimed sender id', () => {
        const bind = pull.indexOf('await bindSender(');
        expect(bind).toBeGreaterThan(0);
        for (const sink of [
            'ingestInboundStatusEmoji(',
            'takeActivityKey(',
            'pinAndDetect(envelopeSenderUserId',
            'refreshOwnDevicesIfUnknown(envelopeSenderUserId',
            'resolvedSenderUserId',
            'warmConversationDevices(',
            'ensureUser(envelopeSenderUserId',
        ]) {
            const at = pull.indexOf(sink);
            expect(at, `${sink} must exist`).toBeGreaterThan(0);
            expect(at, `${sink} must come after bindSender`).toBeGreaterThan(bind);
        }
    });

    it('a pending envelope is held un-ACKed (continue), never pushed to ackOnly/toStore', () => {
        const block = pull.slice(pull.indexOf("if (binding === 'pending')"), pull.indexOf("if (binding === 'refuse')"));
        expect(block).toContain('heldSenderBindingRef.current.hold(');
        expect(block).toContain('continue;');
        expect(block).not.toContain('ackOnly.push');
        expect(block).not.toContain('toStore.push');
    });

    it('a refused envelope becomes the stand-in/drop via settleUnshowable, with the parsed content', () => {
        const block = pull.slice(pull.indexOf("if (binding === 'refuse')"), pull.indexOf('const content = takeActivityKey'));
        expect(block).toContain("settleUnshowable(env, 'sender_unbound', rawContent)");
        expect(block).toContain('continue;');
    });

    it('a held result is reused instead of decrypting a second time (a re-decrypt is a REPLAY)', () => {
        expect(pull).toContain('heldSenderBindingRef.current.take(env.envelope_id, env.ciphertext_b64');
        expect(pull).toContain('heldBinding ? heldBinding.result : await window.electronAPI!.decryptMessage(');
    });
});
