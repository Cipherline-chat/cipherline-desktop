/**
 * The ORDER in which `crypto:decrypt-message` tries this device's signed
 * prekeys. Ordering only — every retained signed prekey is still a candidate,
 * so the set of envelopes this device can open is exactly what it was.
 *
 * WHY. An envelope does not say which signed prekey it was wrapped to, so the
 * decrypt path tries each retained one (RC-6) until one unwraps it, and each
 * miss costs an X25519 key import, an ECDH and an HKDF. The old order was
 * "active first, then by id descending". That is right when the server
 * advertises the active key — and badly wrong when it does not: a device whose
 * bundle uploads were failing had a server still handing senders a signed
 * prekey from weeks earlier, while the device had rotated (and retained) a new
 * one every 15 minutes since. Every inbound DM then walked hundreds of misses
 * before reaching the one key that worked (measured 0.4-0.9 s per message on
 * the main thread), and the next message did it all again.
 *
 * Messages arrive in runs wrapped to the SAME key (whatever the server is
 * currently advertising), so the key that opened the last envelope is by far
 * the likeliest to open the next. This keeps a short most-recently-successful
 * list and tries it right after the active key.
 *
 * Holds key IDS only — never key material. In-memory; a restart just begins
 * with the old order again.
 *
 * No `electron` import, so it is unit-testable.
 */
export class SpkCandidateOrder {
    private recent: number[] = [];
    private readonly max: number;

    // Plain field + assignment, not a parameter property: the renderer's
    // tsconfig (erasableSyntaxOnly) also type-checks this file via tests.
    constructor(max = 4) {
        this.max = max;
    }

    /** `ids` in try-order: active, then recently successful, then id descending. */
    order(ids: readonly number[], activeId: number | null): number[] {
        const present = new Set(ids);
        const seen = new Set<number>();
        const out: number[] = [];
        const push = (id: number) => {
            if (present.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
        };
        if (activeId !== null) push(activeId);
        for (const id of this.recent) push(id);
        for (const id of [...ids].sort((a, b) => b - a)) push(id);
        return out;
    }

    /** Record the id that just opened an envelope. */
    noteSuccess(id: number): void {
        this.recent = [id, ...this.recent.filter((x) => x !== id)].slice(0, this.max);
    }
}
