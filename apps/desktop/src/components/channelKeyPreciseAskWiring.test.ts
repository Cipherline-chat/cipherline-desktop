import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring guard for precise key asks (2026-10-19). The decisions live in
 * utils/channelKeyPrefetch.ts and utils/keyServePass.ts (unit-tested there);
 * this pins that Dashboard actually carries the epochs from the planner and the
 * repair sweep to the request body, and asks the API to list precise requests.
 */
const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');

function body(startMarker: string, endMarker: string): string {
    const a = src.indexOf(startMarker);
    expect(a).toBeGreaterThan(-1);
    const b = src.indexOf(endMarker, a);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
}

describe('precise key asks are wired end to end', () => {
    it('fileKeyRequest posts the epochs it was given, trimmed to what is still missing', () => {
        // Ask path since 2026-10-21: prepareKeyAsk (trim) -> POST (single or per-server batch) -> finishKeyAsk.
        const prepare = body('const prepareKeyAsk = useCallback', 'const finishKeyAsk = useCallback');
        const finish = body('const finishKeyAsk = useCallback', 'const fileKeyRequest = useCallback');
        const one = body('const fileKeyRequest = useCallback', 'const fileKeyRequests = useCallback');
        const many = body('const fileKeyRequests = useCallback', 'const fileKeyRequestsRef = useRef(');
        expect(one).toContain('epochs?: number[]');
        // trimmed to what this device does not hold NOW, in prepareKeyAsk (shared by both paths)
        expect(prepare).toMatch(/listChannelEpochs\(channelId\)/);
        expect(prepare).toContain('askEpochs.filter(e => !held.has(e))');
        expect(one).toContain('await prepareKeyAsk(serverId, channelId, epochs)');
        expect(many).toContain('asks.map(a => prepareKeyAsk(serverId, a.channelId, a.epochs))');
        // the body carries them: single POST, and each entry of the batch POST
        expect(one).toContain('ask.askEpochs ? { epochs: ask.askEpochs } : {}');
        expect(many).toContain('...(l.ask.askEpochs ? { epochs: l.ask.askEpochs } : {})');
        // A throttled ask goes back to the queue WITH its epochs, not as "everything".
        expect(prepare.match(/priority: 'forced', \.\.\.\(askEpochs \? \{ epochs: askEpochs \} : \{\}\)/g)?.length).toBe(1);
        expect(finish.match(/priority: 'forced', \.\.\.\(ask\.askEpochs \? \{ epochs: ask\.askEpochs \} : \{\}\)/g)?.length).toBe(1);
    });

    it('the planner\'s and the repair sweep\'s asks carry their epochs into the queue', () => {
        const fn = body('const requestMissingChannelKeys = useCallback', 'const refreshProtectedEpochs = useCallback');
        expect(fn).toContain("...(a.epochs ? { epochs: a.epochs } : {})");
        expect(fn).toContain("priority: 'gap', epochs: [...missingEpochs]");
    });

    it('the queue sends them (one by one, and per server in one batch)', () => {
        expect(src).toContain('channelKeyOpsRef.current.fileKeyRequest(ask.serverId, ask.channelId, ask.epochs)');
        expect(src).toContain('fileKeyRequestsRef.current(asks[0].serverId, asks.map(a => ({ channelId: a.channelId, epochs: a.epochs })))');
    });

    it('both pending-list GETs declare that this client honours `epochs`', () => {
        const gets = src.split('key-requests/pending`').slice(1);
        expect(gets).toHaveLength(2);
        // (the serve pass also asks for the routed view; member_join's hand-off
        // check sends all=1 + the joiner + summary=1 — see keyServeWholeRequest.test.ts)
        for (const after of gets) expect(after.slice(0, 1200)).toMatch(/params: \{ epochs: 1(, all: 1, requester, summary: 1|, routed: 1) \}/);
    });
});
