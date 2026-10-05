/**
 * Brand web fonts (Fredoka / Nunito / JetBrains Mono), loaded WITHOUT blocking
 * the first paint or the app's own JavaScript.
 *
 * WHY: these used to come from an `@import url(https://fonts.googleapis.com/…)`
 * at the top of index.css. A CSS @import makes the whole stylesheet wait for
 * that request, and a pending parser-inserted stylesheet also holds back the
 * page's module scripts (HTML spec: scripts wait while the document "has a
 * style sheet that is blocking scripts"). So whenever Google was slow or
 * unreachable — most of all right after the PC wakes from sleep, while Wi-Fi /
 * DNS are still coming back, which is exactly when people open the app — the
 * window stayed blank and the app did not even START booting until that one
 * request succeeded or timed out. That is the "it hangs for a long time and
 * then comes back" launch.
 *
 * A stylesheet <link> inserted from script is neither render-blocking nor
 * script-blocking (it is not "created by the parser"), so the app now paints
 * and boots immediately and the fonts swap in when they arrive (the URL keeps
 * `display=swap`, exactly as before; normally they come straight from the HTTP
 * cache). Same URL, same faces, same CSP — only the blocking is gone.
 */
export const WEB_FONTS_CSS_URL =
    'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Nunito:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap';

const MARKER = 'data-cl-webfonts';

/** Idempotent. Safe to call before <body> exists (appends to <head>). */
export function loadWebFonts(doc: Document = document): void {
    if (doc.head.querySelector(`link[${MARKER}]`)) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = WEB_FONTS_CSS_URL;
    link.setAttribute(MARKER, '');
    doc.head.appendChild(link);
}
