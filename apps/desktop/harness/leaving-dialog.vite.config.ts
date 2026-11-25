// The app's Vite config with a PRIVATE dependency cache and its own port, so a
// harness run never writes into the shared (symlinked) node_modules/.vite that
// every worktree's dev server reads. Run from apps/desktop:
//   LD_CACHE=<dir> LD_PORT=5293 VITE_API_HOST=127.0.0.1:13293 npx vite --config harness/leaving-dialog.vite.config.ts
import { mergeConfig } from 'vite';
import base from '../vite.config';

if (!process.env.LD_CACHE) throw new Error('harness: set LD_CACHE to a private cache directory');
export default mergeConfig(base, {
    cacheDir: process.env.LD_CACHE,
    server: { host: '127.0.0.1', port: Number(process.env.LD_PORT ?? 5293), strictPort: true },
});
