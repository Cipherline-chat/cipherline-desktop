/**
 * signed-update-provider.ts — make electron-updater verify `<manifest>.sig`
 * BEFORE it parses the manifest, on every platform.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 * electron-updater (6.8.x) gets update info from its provider:
 * `GenericProvider.getLatestVersion()` builds the manifest URL, calls
 * `this.httpRequest(url)` and hands the returned STRING to `parseUpdateInfo`
 * (js-yaml). The whole update — version, file names, the sha512 every
 * installer is checked against — comes from that one string.
 *
 * This mixin overrides `httpRequest` in a GenericProvider subclass: it fetches
 * the manifest, fetches `<same URL>.sig`, verifies the signature over the
 * manifest bytes (update-manifest-signature.ts), and only then returns — the
 * very string that was verified — to upstream's own parser. Upstream's URL
 * building, retries and YAML handling are untouched, so this cannot drift
 * from what the updater actually parses. A rejection throws
 * ManifestVerificationError out of `checkForUpdates()`: no `update-available`,
 * so nothing is downloaded and nothing is installed.
 *
 * main.ts installs the subclass with
 * `autoUpdater.setFeedURL({ provider: 'custom', updateProvider, url })`
 * (electron-updater's documented custom-provider hook). That replaces only
 * the provider: app-update.yml is still read for the cache dir and, on
 * Windows, the Authenticode publisherName.
 *
 * `GenericProvider.httpRequest` is used ONLY for the manifest (installers and
 * blockmaps go through `httpExecutor.download`), and the override still checks
 * that the URL names exactly the manifest the provider asked for.
 *
 * ── Exact bytes ────────────────────────────────────────────────────────────
 * builder-util-runtime's HttpExecutor decodes the body as UTF-8
 * (`response.setEncoding('utf8')`, a streaming decoder) and the provider
 * parses that string. `Buffer.from(string, 'utf8')` gives back the published
 * bytes for any valid UTF-8 file (electron-builder writes ASCII/UTF-8); a
 * file with invalid UTF-8 decodes lossily and then fails verification — the
 * failure mode is "rejected", never "accepted something else".
 *
 * ── A release being published mid-check ────────────────────────────────────
 * The manifest and its .sig are two objects, uploaded one after the other. A
 * check that lands between the two uploads sees a mismatched pair, so an
 * `invalid` verdict is re-fetched (both files) once after a short delay before
 * it is final. A tampered manifest fails both times.
 */

import * as path from 'path';
import type { ManifestChannel } from './update-manifest-keys';
import {
    decideManifest,
    manifestChannelOf,
    ManifestVerificationError,
    type ManifestDecision,
} from './update-manifest-signature';

/** What one finished manifest check reports (for the diagnostics log). */
export interface ManifestCheckReport {
    channel: ManifestChannel | null;
    fileName: string;
    required: boolean;
    decision: ManifestDecision;
    /** 1, or 2 when an `invalid` verdict was re-fetched. */
    attempts: number;
}

export interface ManifestCheckOptions {
    /** Public keys for a channel (update-manifest-keys.ts). */
    keysFor(channel: ManifestChannel): readonly string[];
    /** Whether the signature is mandatory for a channel on this platform. */
    requiredFor(channel: ManifestChannel): boolean;
    /** Called once per check with the final decision. Must not throw. */
    report(r: ManifestCheckReport): void;
    /** Delay before re-fetching a mismatched pair (default 3 s). */
    mismatchRetryDelayMs?: number;
    sleep?(ms: number): Promise<void>;
}

/** The part of electron-updater's GenericProvider this relies on. */
export interface GenericProviderLike {
    httpRequest(url: URL, headers?: unknown, cancellationToken?: unknown): Promise<string | null>;
    /** `<channel><platform suffix>`, e.g. `latest-linux` (GenericProvider getter). */
    readonly channel: string;
}

// The mixin pattern requires a constructor type with `any[]` arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenericProviderCtor = new (...args: any[]) => GenericProviderLike;

const DEFAULT_MISMATCH_RETRY_DELAY_MS = 3_000;

function isNotFound(e: unknown): boolean {
    return (e as { statusCode?: unknown } | null)?.statusCode === 404;
}

/** URL of the detached signature for a manifest URL: same origin, path + ".sig", same query. */
export function signatureUrlFor(manifestUrl: URL): URL {
    const u = new URL(manifestUrl.href);
    u.pathname = `${manifestUrl.pathname}.sig`;
    return u;
}

/**
 * Subclass `Base` (electron-updater's GenericProvider) so every manifest it
 * fetches is signature-checked before it is parsed.
 */
export function withManifestSignatureCheck<TBase extends GenericProviderCtor>(Base: TBase, opts: ManifestCheckOptions): TBase {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retryDelay = opts.mismatchRetryDelayMs ?? DEFAULT_MISMATCH_RETRY_DELAY_MS;

    return class SignedGenericProvider extends Base {
        override async httpRequest(url: URL, headers?: unknown, cancellationToken?: unknown): Promise<string | null> {
            let fileName: string;
            try { fileName = path.posix.basename(decodeURIComponent(url.pathname)); } catch { fileName = ''; }
            const channel = manifestChannelOf(fileName);
            const expected = `${this.channel}.yml`;

            if (!channel || fileName !== expected) {
                const decision: ManifestDecision = { accept: false, outcome: 'unexpected-file' };
                opts.report({ channel, fileName, required: true, decision, attempts: 1 });
                throw new ManifestVerificationError('unexpected-file', fileName);
            }
            const required = opts.requiredFor(channel);
            const keys = opts.keysFor(channel);

            const fetchPair = async (): Promise<{ body: string | null; sig: string | null }> => {
                const body = await super.httpRequest(url, headers, cancellationToken);
                let sig: string | null;
                try {
                    // An EMPTY 200 resolves null upstream; that is a present-but-empty
                    // signature (malformed), not a missing one.
                    sig = (await super.httpRequest(signatureUrlFor(url), headers, cancellationToken)) ?? '';
                } catch (e) {
                    if (!isNotFound(e)) throw e; // network trouble: a normal, retried update error
                    sig = null;
                }
                return { body, sig };
            };
            const decide = (p: { body: string | null; sig: string | null }) => decideManifest({
                fileName,
                manifestBytes: Buffer.from(p.body ?? '', 'utf8'),
                signatureText: p.sig,
                publicKeys: keys,
                required,
            });

            let pair = await fetchPair();
            let decision = decide(pair);
            let attempts = 1;
            if (!decision.accept && decision.outcome === 'invalid') {
                await sleep(retryDelay);
                pair = await fetchPair();
                decision = decide(pair);
                attempts = 2;
            }
            try { opts.report({ channel, fileName, required, decision, attempts }); } catch { /* diagnostics only */ }
            if (!decision.accept) throw new ManifestVerificationError(decision.outcome, fileName);
            // The exact string that was verified is the one upstream parses.
            return pair.body;
        }
    };
}

/** One line for the Performance log: static words, channel/file names and an outcome only. */
export function describeManifestReport(r: ManifestCheckReport): { event: string; detail: string } {
    const base = `channel=${r.channel ?? 'unknown'} file=${r.fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}`;
    const d = r.decision;
    if (d.accept && d.outcome === 'verified') {
        return { event: 'updater:manifest-verified', detail: `${base} key=${d.keyIndex} attempts=${r.attempts}` };
    }
    if (d.accept) return { event: 'updater:manifest-unsigned', detail: `${base} outcome=${d.outcome}` };
    return { event: 'updater:manifest-rejected', detail: `${base} reason=${d.outcome} required=${r.required} attempts=${r.attempts}` };
}
