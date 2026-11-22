RETIRED. The DeepFilterNet 3 low-delay model was for the native-addon "Strong" noise suppression (electron/audio-engine-*).
Strong is FastEnhancer inside the page's wasm now and nothing fetches or ships this model any more; supply it by hand only
to run the old addon tests. It is not in git (36 MB): `*.tar.gz` is git-ignored.
electron-builder copies this folder to <resources>/dfn/ (package.json "extraResources").
