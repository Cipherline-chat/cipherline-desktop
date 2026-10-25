/**
 * Display safety for names another user chose: attachment filenames, mention
 * labels, group titles.
 *
 * Bidirectional-override and isolate characters reorder what is DRAWN without
 * changing what the string IS: "invoice\u202Etxt.exe" displays as
 * "invoiceexe.txt". Zero-width marks and other control characters are
 * invisible. None has a place in a name, so they are removed before display
 * (and before a filename is offered as the name to save under). Ordinary
 * right-to-left text (Arabic, Hebrew) is untouched: it needs no control
 * characters to render correctly.
 */

// U+202A–U+202E embeddings/overrides, U+2066–U+2069 isolates, U+200E/U+200F
// and U+061C directional marks, U+200B / U+2060 / U+FEFF zero-width
// characters, C0 and C1 controls (incl. tab / newline: a name is one line).
// NOT the zero-width joiner / non-joiner (U+200D / U+200C): emoji sequences
// and Persian or Indic text need them, and they cannot reorder text.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_IN_NAMES = /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** `s` without bidi controls, invisible marks and control characters. */
export function stripBidiControls(s: unknown): string {
    if (typeof s !== 'string') return '';
    return s.replace(UNSAFE_IN_NAMES, '');
}

/** A filename safe to display and to offer as the save name ('file' if nothing is left). */
export function safeDisplayFilename(name: unknown): string {
    const cleaned = stripBidiControls(name).trim();
    return cleaned || 'file';
}

/**
 * Extensions that run code when opened on some platform. Warn-only: the
 * file can still be saved; the user is told what it is first.
 */
const EXECUTABLE_EXTENSIONS = new Set([
    // Windows
    'exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'msp', 'msix', 'appx', 'lnk', 'url',
    'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'ps1', 'psm1', 'reg', 'cpl', 'msc', 'jar',
    // macOS
    'app', 'dmg', 'pkg', 'command', 'workflow',
    // Linux / cross-platform
    'sh', 'run', 'bin', 'appimage', 'deb', 'rpm', 'desktop', 'apk',
]);

/** The extension a desktop OS would act on (after trailing dots/spaces, which Windows ignores). */
export function effectiveExtension(name: unknown): string {
    const cleaned = stripBidiControls(name).replace(/[.\s]+$/, '');
    const dot = cleaned.lastIndexOf('.');
    return dot >= 0 ? cleaned.slice(dot + 1).toLowerCase() : '';
}

export function isExecutableFilename(name: unknown): boolean {
    return EXECUTABLE_EXTENSIONS.has(effectiveExtension(name));
}
