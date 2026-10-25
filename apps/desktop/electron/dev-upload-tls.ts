/**
 * Trust store for the DEV-ONLY upload agent in main.ts (`file:upload` IPC).
 *
 * The problem it solves: in the dev stack, presigned upload URLs point at the
 * local Caddy server, whose certificate is issued by Caddy's local root CA.
 * The developer imports that root into the OS trust store (Windows "Trusted
 * Root"), which is enough for the Chromium renderer. Node's `https` module,
 * however, uses only its own bundled Mozilla CA list by default, so the main
 * process rejected the same certificate ("unable to get local issuer
 * certificate").
 *
 * The old workaround switched certificate verification OFF for that agent.
 * This replaces it with the right fix: keep
 * verification ON, and widen the trust anchors to "Node's defaults plus the
 * OS trust store", which is exactly the set the renderer already trusts. A
 * certificate that is not chained to one of those roots, or whose name does
 * not match, is still refused.
 *
 * Production never calls this (the packaged-build branch in main.ts uses
 * Node's default agent with its normal CA list); it is only a dev aid.
 *
 * Deliberately free of any `electron` import so it is unit-testable.
 */
import * as tls from 'tls';

export type CaSource = 'default' | 'system';
export type GetCaCertificates = (type: CaSource) => string[];

/**
 * Node's default CA certificates plus the operating system's trusted roots,
 * de-duplicated. If the runtime cannot read the system store, the result is
 * Node's defaults alone (still a verifying trust store, never an empty one).
 */
export function devUploadTrustedCas(getCaCertificates: GetCaCertificates = tls.getCACertificates): string[] {
  const out = new Set<string>(getCaCertificates('default'));
  try {
    for (const pem of getCaCertificates('system')) out.add(pem);
  } catch {
    // Older runtime or unreadable store: fall back to the defaults only.
  }
  return [...out];
}
