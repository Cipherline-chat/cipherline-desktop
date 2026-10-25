/**
 * Was the sign-in screen shown during this app session? startup_slow measures
 * navigation → the signed-in app being ready; a launch that went through the
 * sign-in screen would measure the person typing, so it is not reported.
 * AuthScreen marks itself on mount. Memory only.
 */
let shown = false;
export function noteAuthScreenShown(): void { shown = true; }
export function wasAuthScreenShown(): boolean { return shown; }
