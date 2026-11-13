{
  "targets": [
    {
      "target_name": "audio_capture",
      # share_power.cc is platform-neutral (its Win32 half is #ifdef _WIN32; elsewhere
      # every export is a no-op), so it stays in the list on mac too (the mac
      # block below only swaps audio_capture.cc / window_geometry.cc). The same
      # holds for hdr_capture.cc (HDR screen capture + tone map; no-op off Windows).
      "sources": [ "src-native/audio_capture.cc", "src-native/window_geometry.cc", "src-native/share_power.cc", "src-native/hdr_capture.cc" ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lole32.lib",
              "-luuid.lib",
              "-lmmdevapi.lib",
              "-luser32.lib",
              "-ldwmapi.lib",
              "-lwinmm.lib",
              "-lshell32.lib",
              "-ldelayimp.lib",
              "-ld3d11.lib",
              "-ldxgi.lib",
              "-ld3dcompiler.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              },
              "VCLinkerTool": {
                "DelayLoadDLLs": ["mmdevapi.dll", "audioses.dll", "dwmapi.dll", "d3d11.dll", "dxgi.dll", "d3dcompiler_47.dll"]
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            # macOS: ScreenCaptureKit per-app / system audio capture. Same addon
            # name and JS surface as the WASAPI build, different source.
            # window_geometry_mac.mm is the annotation overlay's window
            # geometry (window_geometry.cc's macOS counterpart).
            "sources!": [ "src-native/audio_capture.cc", "src-native/window_geometry.cc" ],
            "sources": [ "src-native/audio_capture_mac.mm", "src-native/window_geometry_mac.mm" ],
            "xcode_settings": {
              # No ARCHS here on purpose: node-gyp sets the architecture per run
              # (--arch), and overriding it here made the x64 build compile as
              # i386. scripts/rebuild-native-mac.sh builds each arch and lipo's.
              # ScreenCaptureKit audio is macOS 13+. Target 12.3 (where SCStream first exists) and weak-link the
              # framework so the addon still LOADS on older systems (it then
              # reports isSupported() === false) instead of failing to dlopen.
              "MACOSX_DEPLOYMENT_TARGET": "12.3",
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "OTHER_LDFLAGS": [
                "-weak_framework ScreenCaptureKit",
                "-framework CoreMedia",
                "-framework CoreGraphics",
                "-framework AppKit",
                "-framework Foundation"
              ]
            }
          }
        ],
        [
          "OS=='linux'",
          {
            # Linux: PipeWire per-application audio capture. audio_capture.cc is all
            # #ifdef _WIN32 here, so it is swapped for the PipeWire addon, which
            # registers the same four exports (+ isSupported) AND the same
            # RegisterWindowGeometry / RegisterSharePower / RegisterHdrCapture
            # (window_geometry.cc, share_power.cc, hdr_capture.cc stay in the build).
            # libpipewire is dlopen()ed at run time, never linked: only the vendored
            # MIT headers are used (third_party/pipewire/LICENSE), so the build needs no
            # system dev packages and the addon loads on desktops without PipeWire.
            "sources!": [ "src-native/audio_capture.cc" ],
            "sources": [ "src-native/audio_capture_linux.cc" ],
            "include_dirs": [ "src-native/third_party/pipewire" ],
            "libraries": [ "-ldl" ],
            "cflags_cc": [ "-std=c++17", "-fexceptions", "-Wall" ]
          }
        ],
        [
          "OS!='win' and OS!='mac' and OS!='linux'",
          {
            "cflags_cc": [ "-std=c++17" ]
          }
        ]
      ]
    },
    {
      # Linux/Wayland annotation overlay helper (src-native/wayland_overlay/cl_wayland_overlay.c).
      # A separate EXECUTABLE rather than a part of the addon: a crash in it cannot take the main
      # process down, and it shares no code with the audio paths. Plain C; libwayland-client,
      # libX11, libXext and libXrandr are dlopen()ed at run time (never linked, no -dev packages
      # needed), so it builds anywhere and degrades to "unsupported" where they are missing.
      # Empty (type none) on Windows and macOS, so those builds are unchanged.
      # electron-builder packages and unpacks build/Release/cl-wayland-overlay (package.json).
      "target_name": "cl_wayland_overlay",
      "type": "none",
      "conditions": [
        [
          "OS=='linux'",
          {
            "type": "executable",
            "product_name": "cl-wayland-overlay",
            "sources": [ "src-native/wayland_overlay/cl_wayland_overlay.c" ],
            "include_dirs": [ "src-native/wayland_overlay" ],
            "libraries": [ "-ldl", "-lm" ],
            "cflags_c": [ "-std=gnu11", "-Wall", "-O2", "-fstack-protector-strong", "-fPIE" ],
            "ldflags": [ "-pie", "-Wl,-z,relro,-z,now" ]
          }
        ]
      ]
    }
  ]
}
