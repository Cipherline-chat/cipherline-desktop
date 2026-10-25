/**
 * The text "Copy version" puts on the clipboard (Settings -> Advanced): the
 * product, the version and, when this build knows it, the source commit, so a
 * single paste tells a bug report exactly which build it came from.
 *
 *   Cipherline v1.0.22 (88a0183)
 *   Cipherline v1.0.22              (a build made without source-control info)
 */
export function buildVersionText(version: string, commit: string): string {
    const known = !!commit && commit !== 'unknown';
    return `Cipherline v${version}${known ? ` (${commit})` : ''}`;
}
