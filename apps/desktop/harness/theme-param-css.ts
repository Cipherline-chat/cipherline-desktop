/* eslint-disable -- visual harness, not shipped */
// The theme stylesheets, in src/main.tsx's order and AFTER the page's own CSS
// (the scanner injects this module after the harness entry): see theme-param.ts.
import '../src/styles/theme-light-kit.css';
// The real renderer's night-dive.css paints the title bar / feed / Friends / Home from
// --nd-* properties in every theme; without it a harness shows colours the app does not.
import '../src/styles/night-dive.css';
import '../src/styles/theme-light.css';
import '../src/styles/theme-midnight.css';
import '../src/styles/theme-contrast.css';
