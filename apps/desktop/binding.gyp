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
          "OS!='win' and OS!='mac'",
          {
            "cflags_cc": [ "-std=c++17" ]
          }
        ]
      ]
    }
  ]
}
