/**
 * The app's one composer-draft store (see composerDrafts.ts for the rules).
 * Kept separate so the factory stays free of the real encrypted store and is
 * unit-testable with a fake.
 */
import secureLocalStore from './secureLocalStore';
import { createDraftStore } from './composerDrafts';

export const composerDrafts = createDraftStore({ secureLocalStore });

// A pending (debounced) draft must be handed to secureLocalStore BEFORE
// secureLocalStore's own pagehide/beforeunload/visibility flush runs, or that
// flush would miss it. secureLocalStore registered first (we import it above),
// so these use the capture phase to run ahead of it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const flush = () => { composerDrafts.flush(); };
    window.addEventListener('pagehide', flush, true);
    window.addEventListener('beforeunload', flush, true);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        }, true);
    }
}
