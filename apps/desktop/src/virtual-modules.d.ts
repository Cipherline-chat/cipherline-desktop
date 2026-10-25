/**
 * Build-time virtual modules. Ambient on purpose (no top-level import/export):
 * a declaration inside a module file would be an augmentation, not a new module.
 */

/** The release notes parsed from CHANGELOG.md at build time (vite-plugin-whats-new.ts). */
declare module 'virtual:whats-new' {
    const data: import('./utils/changelogParse').WhatsNewData;
    export default data;
}
