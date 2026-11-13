/* eslint-disable -- visual harness, not shipped */
// The REAL CustomStatusInline ("Clear after" ClSelect) pinned to the bottom-left of a short window,
// inside an overflow-hidden popover shell like the status picker's.
//   CT_PORT=5361 npx vite --config harness/status-dropdown.vite.config.ts
//   node harness/status-dropdown-shots.mjs   (env: OUT PREFIX BASE PW_CHROMIUM_EXE)
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { CustomStatusInline } from '../src/components/CustomStatusInline';

loadWebFonts();
createRoot(document.getElementById('root')!).render(
    <div style={{ position: 'fixed', left: 16, bottom: 12, width: 300, overflow: 'hidden', borderRadius: 16, background: '#0f1630', border: '1px solid rgba(255,255,255,.08)' }}>
        <CustomStatusInline current={null} open={true} onSave={() => {}} />
    </div>,
);
