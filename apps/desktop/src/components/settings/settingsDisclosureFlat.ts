import { createContext } from 'react';

/**
 * Inside a pane that already shows one section at a time (Settings > Profile's
 * tabs), a top-level `card` SettingsDisclosure has nothing to fold: it renders
 * as a plain, always-open card (the tab already names it, so no heading; the
 * title stays the region's accessible name). Inset (nested) disclosures are
 * unaffected.
 */
export const SettingsDisclosureFlatCards = createContext(false);
