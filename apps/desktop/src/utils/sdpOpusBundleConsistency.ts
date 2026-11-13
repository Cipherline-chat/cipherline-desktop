/**
 * Keeps every Opus m-section of a BUNDLE group on ONE parameter set.
 *
 * Why this exists. libwebrtc (M12x+) refuses to treat a BUNDLE as consistent
 * when the same payload type carries different fmtp parameters in two of its
 * sections, and logs, on every call start / voice join:
 *
 *   A BUNDLE group contains a codec collision between {payload_type: 111,
 *   audio/opus, {maxaveragebitrate: 510000, minptime: 10, stereo: 1,
 *   useinbandfec: 1}} and {payload_type: 111, audio/opus, {minptime: 10,
 *   useinbandfec: 1}} ...                      (sdp_offer_answer.cc:575/4171)
 *
 * We do not write that SDP. livekit-server marks ONLY the track that was
 * announced as stereo (`stereo=1;maxaveragebitrate=510000` in its answer to
 * our publisher offer, `sprop-stereo=1` in its subscriber offer) and leaves
 * the other audio m-lines plain, and livekit-client's own answer munge
 * (PCTransport.ensureAudioNackAndStereo) then copies `stereo=1` only onto
 * those same mids. The result is two Opus sections that share PT 111 and
 * disagree on parameters, which BUNDLE forbids. Calls still connect (the
 * check is advisory in practice) but the spec says the remote may apply one
 * section's parameters to all, and the next Chromium may stop being lenient.
 *
 * The fix is to make them agree, taking the UNION of the parameters: a key
 * present on any section is written to all of them (numeric conflicts take
 * the larger value). That keeps screen-share audio stereo (its section's
 * `stereo=1` / `sprop-stereo=1` survives) and costs a mono mic nothing:
 *  - the publisher offer LiveKit sends already carries `stereo=1` on EVERY
 *    audio section (it passes ['all']), so claiming it in the answer too is
 *    the same statement, and what the mic actually encodes is bounded by the
 *    sender's own `maxBitrate` (64 kbps, CallPane `audioPreset`) and its mono
 *    capture, not by `maxaveragebitrate=510000`;
 *  - a receiver that decodes a mono stream as 2-channel Opus just upmixes.
 * Distinct payload types would be the other textbook answer, but the SFU
 * dictates the PTs it will send/accept for each section, so rewriting them
 * here would break media; same-params-per-BUNDLE is the safe one.
 *
 * Only sections that share a payload type number are touched (different PTs
 * cannot collide), only non-rejected ones (port 0), and only when a BUNDLE
 * group names them. Anything unparseable returns the input unchanged.
 */

interface Section { start: number; end: number; kind: string; port: string; mid: string | null }

function splitSections(lines: string[]): { sections: Section[]; bundle: Set<string> | null } {
    const sections: Section[] = [];
    let bundle: Set<string> | null = null;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('m=')) {
            const parts = l.slice(2).split(' ');
            sections.push({ start: i, end: lines.length, kind: parts[0], port: parts[1] ?? '', mid: null });
            if (sections.length > 1) sections[sections.length - 2].end = i;
        } else if (sections.length === 0 && l.startsWith('a=group:BUNDLE')) {
            bundle = new Set(l.slice('a=group:BUNDLE'.length).trim().split(/\s+/).filter(Boolean));
        } else if (sections.length > 0 && l.startsWith('a=mid:')) {
            sections[sections.length - 1].mid = l.slice(6).trim();
        }
    }
    return { sections, bundle };
}

function opusPt(lines: string[], s: Section): string | null {
    for (let i = s.start; i < s.end; i++) {
        const m = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?\s*$/i.exec(lines[i]);
        if (m) return m[1];
    }
    return null;
}

function parseParams(cfg: string): Array<[string, string]> {
    return cfg.split(';').map(p => p.trim()).filter(Boolean).map(p => {
        const eq = p.indexOf('=');
        return eq < 0 ? [p, ''] : [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
    });
}

const canon = (p: Array<[string, string]>) => p.map(([k, v]) => `${k}=${v}`).sort().join(';');

/** Union of several parameter lists; a numeric conflict keeps the larger. */
function mergeParams(lists: Array<Array<[string, string]>>): Array<[string, string]> {
    const out = new Map<string, string>();
    for (const list of lists) {
        for (const [k, v] of list) {
            const cur = out.get(k);
            if (cur === undefined) { out.set(k, v); continue; }
            if (cur !== v && /^\d+$/.test(cur) && /^\d+$/.test(v) && Number(v) > Number(cur)) out.set(k, v);
        }
    }
    return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface OpusBundleResult { sdp: string; changed: boolean }

export function unifyOpusBundleParams(sdp: string): OpusBundleResult {
    if (typeof sdp !== 'string' || sdp.length === 0) return { sdp, changed: false };
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(eol);
    const { sections, bundle } = splitSections(lines);
    if (!bundle || bundle.size < 2) return { sdp, changed: false };

    // payload type -> bundled, live, audio sections that map it to opus
    const byPt = new Map<string, Section[]>();
    for (const s of sections) {
        if (s.kind !== 'audio' || s.port === '0' || s.mid === null || !bundle.has(s.mid)) continue;
        const pt = opusPt(lines, s);
        if (pt === null) continue;
        byPt.set(pt, [...(byPt.get(pt) ?? []), s]);
    }

    const fmtpIdx = (s: Section, pt: string): number => {
        for (let i = s.start; i < s.end; i++) if (lines[i].startsWith(`a=fmtp:${pt} `)) return i;
        return -1;
    };

    // Edits are collected by line index and applied bottom-up so indexes hold.
    const replace = new Map<number, string>();
    const insertAfter = new Map<number, string>();
    for (const [pt, group] of byPt) {
        if (group.length < 2) continue;
        const params = group.map(s => {
            const i = fmtpIdx(s, pt);
            return i < 0 ? [] : parseParams(lines[i].slice(`a=fmtp:${pt} `.length));
        });
        if (new Set(params.map(canon)).size === 1) continue;
        const merged = mergeParams(params);
        const text = `a=fmtp:${pt} ${merged.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
        group.forEach(s => {
            const i = fmtpIdx(s, pt);
            if (i >= 0) { if (lines[i] !== text) replace.set(i, text); }
            else {
                let at = s.start;
                for (let j = s.start; j < s.end; j++) if (lines[j].startsWith(`a=rtpmap:${pt} `)) at = j;
                insertAfter.set(at, text);
            }
        });
    }
    if (replace.size === 0 && insertAfter.size === 0) return { sdp, changed: false };

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        out.push(replace.get(i) ?? lines[i]);
        const ins = insertAfter.get(i);
        if (ins !== undefined) out.push(ins);
    }
    return { sdp: out.join(eol), changed: true };
}

/**
 * Which congestion-control feedback each live media section's primary codecs
 * advertise. libwebrtc logs "Inconsistent congestion control feedback types,
 * ignoring all" (sdp_offer_answer.cc:5516) when these disagree; it then drops
 * transport-cc. We do not rewrite this (we have not seen the offending SDP and
 * adding feedback a peer never agreed to is not safe to guess) — this only
 * describes it so one diagnostic line says which sections differ.
 */
export function congestionControlSummary(sdp: string): { consistent: boolean; summary: string } {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(eol);
    const { sections } = splitSections(lines);
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const s of sections) {
        if ((s.kind !== 'audio' && s.kind !== 'video') || s.port === '0') continue;
        const aux = new Set<string>();
        const fb = new Map<string, Set<string>>();
        for (let i = s.start; i < s.end; i++) {
            const rm = /^a=rtpmap:(\d+) ([^/\s]+)/.exec(lines[i]);
            if (rm && /^(rtx|red|ulpfec|flexfec-03|cn|telephone-event)$/i.test(rm[2])) aux.add(rm[1]);
            const fm = /^a=rtcp-fb:(\S+) (transport-cc|goog-remb)\b/.exec(lines[i]);
            if (fm) fb.set(fm[1], (fb.get(fm[1]) ?? new Set()).add(fm[2]));
        }
        const types = new Set<string>();
        for (const [pt, t] of fb) if (!aux.has(pt)) t.forEach(x => types.add(x));
        const label = [...types].sort().join('+') || 'none';
        seen.add(label);
        parts.push(`${s.mid ?? '?'}:${s.kind}=${label}`);
    }
    return { consistent: seen.size <= 1, summary: parts.join(' ') };
}

const warnedCc = new Set<string>();
const PATCHED = Symbol.for('cipherline.opusBundlePatched');

type Proto = {
    setRemoteDescription?: (d?: RTCSessionDescriptionInit, ...r: unknown[]) => Promise<void>;
    setLocalDescription?: (d?: RTCSessionDescriptionInit, ...r: unknown[]) => Promise<void>;
    [PATCHED]?: boolean;
};

function normalizeDesc(d: RTCSessionDescriptionInit | undefined, warnCc: boolean): RTCSessionDescriptionInit | undefined {
    try {
        if (!d || typeof d.sdp !== 'string' || (d.type !== 'offer' && d.type !== 'answer')) return d;
        if (warnCc) {
            const cc = congestionControlSummary(d.sdp);
            if (!cc.consistent && !warnedCc.has(cc.summary)) {
                warnedCc.add(cc.summary);
                console.warn(`[SDP] congestion-control feedback differs across sections (${d.type}): ${cc.summary}`);
            }
        }
        const r = unifyOpusBundleParams(d.sdp);
        return r.changed ? { type: d.type, sdp: r.sdp } : d;
    } catch {
        return d; // never let a consistency pass break a negotiation
    }
}

/**
 * Patch RTCPeerConnection once so every description the app hands to libwebrtc
 * (LiveKit's PCTransport included) has its Opus sections reconciled. Done at
 * the prototype because livekit-client builds its own peer connections and
 * the first server offer can arrive before any room-level hook could attach.
 * Idempotent. `target` is injectable for tests.
 */
export function installOpusBundleConsistency(
    target: Proto | undefined = (typeof RTCPeerConnection !== 'undefined' ? (RTCPeerConnection.prototype as unknown as Proto) : undefined),
): boolean {
    if (!target || target[PATCHED]) return false;
    const origRemote = target.setRemoteDescription;
    const origLocal = target.setLocalDescription;
    if (typeof origRemote !== 'function' || typeof origLocal !== 'function') return false;
    target.setRemoteDescription = function (this: unknown, d?: RTCSessionDescriptionInit, ...rest: unknown[]) {
        return origRemote.call(this, normalizeDesc(d, true), ...rest);
    };
    target.setLocalDescription = function (this: unknown, d?: RTCSessionDescriptionInit, ...rest: unknown[]) {
        return origLocal.call(this, normalizeDesc(d, false), ...rest);
    };
    target[PATCHED] = true;
    return true;
}
