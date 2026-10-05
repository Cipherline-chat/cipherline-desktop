import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Read the desktop package.json once at config time so the renderer can stamp
// every outbound request with `X-Cipherline-Version: <pkg.version>`. Keeping
// the single source of truth in package.json means `npm version patch` is
// enough to bump both the installer name and the header — no code edits.
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

// ── Which source tree is this build actually running? ───────────────────────
// This repo runs many concurrent sessions, each in its own git worktree, but
// the Tier-1 dev stack is a Docker singleton: `desktop-vite` bind-mounts
// whichever checkout last ran `claim-dev-env.sh` (see CLAUDE.md, "Concurrent
// sessions & worktrees"). So the app can happily serve a DIFFERENT worktree's
// code than the one you're editing, with nothing in the UI to say so. That has
// already burned a full debugging session: real-looking bug reports that were
// all just "the stack is serving someone else's older branch."
//
// Stamping the commit the bundle was built from makes that self-diagnosing —
// the SHA in Settings → Advanced either matches your worktree's HEAD or it
// doesn't. Resolved from the config file's own directory so it reports the tree
// Vite is actually reading, not the CWD the process happened to start in.
//
// Never fatal: a source tarball, a Docker build without .git, or no git binary
// all just yield 'unknown'. `-dirty` marks uncommitted edits, which in dev is
// the normal state and is itself useful (it says the running code isn't any
// commit at all).
function gitDescribe(): string {
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const sha = run('rev-parse', '--short', 'HEAD')
    if (!sha) return 'unknown'
    // Untracked files don't count — only tracked modifications mean the build
    // differs from the commit it claims.
    const dirty = run('status', '--porcelain', '--untracked-files=no') !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

const gitCommit = process.env.CIPHERLINE_BUILD_COMMIT?.trim() || gitDescribe()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // important for electron build paths
  build: {
    sourcemap: false, // never ship source maps in the production bundle
    rollupOptions: {
      output: {
        manualChunks(id) {
          // LiveKit — large WebRTC stack, only needed once a call starts
          if (id.includes('node_modules/livekit-client') ||
              id.includes('node_modules/@livekit/')) return 'livekit';
          // Stripe — only needed on the billing tab
          if (id.includes('node_modules/@stripe/')) return 'stripe';
          // Framer Motion — animation library, defer after first paint
          if (id.includes('node_modules/framer-motion')) return 'framer';
          // Emoji picker + data — only shown when picker opens
          if (id.includes('node_modules/emoji-mart') ||
              id.includes('node_modules/@emoji-mart/')) return 'emoji';
          // DnD kit — drag-and-drop, not critical path
          if (id.includes('node_modules/@dnd-kit/')) return 'dnd';
        },
      },
    },
  },
  define: {
    // Exposed to the renderer as `import.meta.env.VITE_APP_VERSION`.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    // …and the commit it was built from, as `VITE_BUILD_COMMIT`. See
    // gitDescribe() above for why this exists.
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(gitCommit),
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: [
      'cipherline.chat',
      'api.cipherline.chat',
      'media.cipherline.chat',
      'rtc.cipherline.chat',
      'admin.cipherline.chat',
      'localhost',
      '127.0.0.1',
    ],
    // Allow Vite's file watcher to reach out of apps/desktop into the
    // monorepo's packages/ directory so shared-package edits hot-reload.
    fs: {
      allow: [path.resolve(__dirname, '..', '..')],
    },
  },
  resolve: {
    alias: {
      // Use the self-contained browser bundle — no Node.js APIs required.
      'mammoth': 'mammoth/mammoth.browser.min.js',
      // ExcelJS browser build — strips Node.js fs/stream dependencies.
      'exceljs': 'exceljs/dist/exceljs.min.js',
      // Workspace package — resolve the TypeScript source directly so Vite
      // handles type stripping + HMR. Avoids any dependency on symlinked
      // node_modules entries, which can be brittle inside Docker volumes.
      '@cipherline/shared': path.resolve(__dirname, '..', '..', 'packages', 'shared', 'index.ts'),
    },
  },
})
